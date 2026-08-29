import { analyzeHlsManifest, withEstimatedSizes } from '../media/hls/analysis';
import type { MediaFetcherPort } from '../shared/ports/media-fetcher.port';
import type { DetectedMedia } from '../shared/types';
import type { MediaRegistry } from './media-registry';

/**
 * 検出した HLS マニフェストを取得し直して解析する（要件定義 2.2 の再フェッチ方式）。
 *
 * 取得に失敗する URL（認証付き・有効期限付き）は珍しくない。
 * その場合は対応外として理由を記録し、検出自体は残す。
 *
 * **失敗の扱いを 2 つに分ける。**
 * 通信の失敗（オフライン・DNS・5xx）は一時的なことがあるため、理由を出しつつ
 * 未解析のまま残して再試行できるようにする。マニフェストとして解析できないなど
 * 内容に起因する失敗は、何度試しても結果が変わらないので解析済みとして打ち切る。
 */

/** 再フェッチ失敗時にユーザーへ出す理由。 */
const FETCH_FAILED = 'マニフェストを取得できませんでした（認証や有効期限が原因の可能性があります）';
const TOO_LARGE = 'マニフェストとして扱うには大きすぎます';
const NOT_A_PLAYLIST = 'マニフェストとして解析できませんでした';

/** 1 件あたりの自動再試行の上限。使い切った後はユーザーの更新操作でのみ再開する。 */
const MAX_ATTEMPTS = 3;

/**
 * 同じ URL を再試行するまでの最短間隔（ms）。
 *
 * 解析の契機は「検出結果の変化」で、ライブ HLS では数百 ms 間隔で届く。
 * 間隔を置かないと数秒の瞬断で上限を使い切ってしまい、
 * 一時的な失敗から自動で回復するという意図が働かない。
 */
const RETRY_INTERVAL_MS = 10_000;

/**
 * タブあたりの自動再試行の総数上限。
 *
 * 1 件あたりの上限だけでは総量が抑えられない。検出は 1 タブ 200 件まで保持し、
 * その URL 集合はページ側が決められる。再フェッチは Cookie 付きで飛ぶため、
 * ページから増幅させられる余地を残さない。ページ遷移で回復する。
 */
const MAX_RETRIES_PER_TAB = 50;

/** タブ ID と dedupeKey を混ぜない区切り。URL に現れない文字を使う。 */
const stateKey = (tabId: number, dedupeKey: string) => `${tabId}\u0000${dedupeKey}`;

type ResolveState =
	/** 取得中。二重に取得しない */
	| { status: 'resolving' }
	/** 解析済み、または再試行しても変わらない失敗 */
	| { status: 'settled' }
	/** 一時的な失敗。間隔を空けて上限まで再試行する */
	| { status: 'failed'; attempts: number; lastAttemptAt: number };

/** 1 件の解析結果。再試行してよいかを表す。 */
type ResolveOutcome = 'settled' | 'transient-failure';

export class ManifestResolver {
	/**
	 * 解析の進行状況。`タブID + dedupeKey` で持つ。
	 *
	 * ライブ HLS はマニフェストが繰り返し読み込まれるため、
	 * 抑止しないと同じ URL を何度も取得してしまう。
	 * タブごとに持つのは、ページ遷移で抑止を解除できるようにするため。
	 */
	private readonly states = new Map<string, ResolveState>();

	/** タブごとの自動再試行の消費数。`MAX_RETRIES_PER_TAB` を参照。 */
	private readonly retries = new Map<number, number>();

	constructor(
		private readonly fetcher: MediaFetcherPort,
		private readonly registry: MediaRegistry,
		/** 再試行の間隔を測る時計。テストから差し替える */
		private readonly now: () => number = () => Date.now(),
	) {}

	/**
	 * タブの検出結果が変わったときに呼ぶ。未解析の HLS があれば解析する。
	 *
	 * @param generation 呼び出し元がイベントを受け取った時点の世代
	 */
	async resolvePending(tabId: number, media: DetectedMedia[], generation: number): Promise<void> {
		for (const item of media) {
			// 1 件ごとに世代を確認する。取得は 1 件あたり数秒かかることがあり、
			// その間にページ遷移が起きると、遷移後のページの状態を旧ページ由来の
			// 取得結果で書き換えてしまう
			if (generation !== this.registry.currentGeneration(tabId)) return;

			if (item.type !== 'hls') continue;
			if (item.manifestResolved === true) continue;

			const key = stateKey(tabId, item.dedupeKey);
			const state = this.states.get(key);
			if (state?.status === 'resolving' || state?.status === 'settled') continue;
			if (state !== undefined && !this.canRetry(tabId, state)) continue;

			const attempts = (state?.status === 'failed' ? state.attempts : 0) + 1;
			if (attempts > 1) this.retries.set(tabId, (this.retries.get(tabId) ?? 0) + 1);

			// 自分が置いた印。以降の書き換えはこの印が残っているときだけ行う。
			// 旧世代の取得が、同じキーを掴み直した新しい取得を壊さないようにするため
			const marker: ResolveState = { status: 'resolving' };
			this.states.set(key, marker);

			let outcome: ResolveOutcome;
			try {
				outcome = await this.resolve(tabId, item, generation);
			} catch (error) {
				// storage の失敗など。取得中のまま固定すると、更新ボタンでも復帰できなくなる
				this.handOver(key, marker, { status: 'failed', attempts, lastAttemptAt: this.now() });
				throw error;
			}

			if (generation !== this.registry.currentGeneration(tabId)) {
				// 取得中に遷移した。旧ページの状態を残さない（`forgetTab` と前後してもよいように）
				this.handOver(key, marker, undefined);
				return;
			}

			this.handOver(
				key,
				marker,
				outcome === 'transient-failure'
					? { status: 'failed', attempts, lastAttemptAt: this.now() }
					: { status: 'settled' },
			);
		}
	}

	/**
	 * 当該タブの状態をすべて捨てる。ページ遷移・タブ破棄時に呼ぶ。
	 * 捨てないと、同じページを開き直しても再解析されない。
	 */
	forgetTab(tabId: number): void {
		const prefix = stateKey(tabId, '');
		for (const key of this.states.keys()) {
			if (key.startsWith(prefix)) this.states.delete(key);
		}
		this.retries.delete(tabId);
	}

	/**
	 * 失敗の記録だけを捨てる。ユーザーの明示的な再試行（更新ボタン）で呼ぶ。
	 *
	 * 取得中の項目は残す。消すと同じ URL への取得が二重に走る。
	 * タブあたりの再試行総数は戻さない。戻すと連打で上限を無効化できてしまう。
	 */
	resetFailures(tabId: number): void {
		const prefix = stateKey(tabId, '');
		for (const [key, state] of this.states) {
			if (key.startsWith(prefix) && state.status === 'failed') this.states.delete(key);
		}
	}

	/** 一時的な失敗を今もう一度試してよいか。 */
	private canRetry(tabId: number, state: ResolveState): boolean {
		if (state.status !== 'failed') return true;
		if (state.attempts >= MAX_ATTEMPTS) return false;
		if (this.now() - state.lastAttemptAt < RETRY_INTERVAL_MS) return false;
		return (this.retries.get(tabId) ?? 0) < MAX_RETRIES_PER_TAB;
	}

	/** 自分が置いた印が残っているときだけ状態を移す。`undefined` なら取り除く。 */
	private handOver(key: string, marker: ResolveState, next: ResolveState | undefined): void {
		if (this.states.get(key) !== marker) return;
		if (next === undefined) {
			this.states.delete(key);
			return;
		}
		this.states.set(key, next);
	}

	private async resolve(
		tabId: number,
		media: DetectedMedia,
		generation: number,
	): Promise<ResolveOutcome> {
		const fetched = await this.fetcher.fetchText(media.sourceUrl);

		if (!fetched.ok) {
			if (fetched.reason === 'too-large') {
				// 取り違えの可能性が高い。同じ URL を取り直しても変わらない
				await this.registry.enrich(tabId, media.dedupeKey, generation, {
					unsupportedReason: TOO_LARGE,
				});
				return 'settled';
			}

			// 通信の失敗・HTTP エラー。理由は出すが解析済みにはせず、再試行の余地を残す
			await this.registry.recordManifestFailure(tabId, media.dedupeKey, generation, FETCH_FAILED);
			return 'transient-failure';
		}

		const analyzed = analyzeHlsManifest(fetched.text, media.sourceUrl);
		if (!analyzed.ok) {
			await this.registry.enrich(tabId, media.dedupeKey, generation, {
				unsupportedReason: NOT_A_PLAYLIST,
			});
			return 'settled';
		}

		const analysis = analyzed.value;
		await this.registry.enrich(tabId, media.dedupeKey, generation, {
			...analysis,
			...(analysis.variants !== undefined && {
				variants: withEstimatedSizes(analysis.variants, analysis.duration ?? media.duration),
			}),
		});
		return 'settled';
	}
}
