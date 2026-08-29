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

/**
 * 一時的な失敗を自動で再試行する上限。
 *
 * ライブ HLS はマニフェストが繰り返し読み込まれ、そのたびに解析の契機が来る。
 * 上限がないと、恒久的に落ちる URL に対して検出のたびに取得を繰り返す。
 * 使い切った後はユーザーの更新操作（`resetFailures`）でのみ再開する。
 */
const MAX_ATTEMPTS = 3;

/** タブ ID と dedupeKey を混ぜない区切り。URL に現れない文字を使う。 */
const handledKey = (tabId: number, dedupeKey: string) => `${tabId}\u0000${dedupeKey}`;

type ResolveState =
	/** 取得中。二重に取得しない */
	| { status: 'resolving' }
	/** 解析済み、または再試行しても変わらない失敗 */
	| { status: 'settled' }
	/** 一時的な失敗。上限まで再試行する */
	| { status: 'failed'; attempts: number };

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

	constructor(
		private readonly fetcher: MediaFetcherPort,
		private readonly registry: MediaRegistry,
	) {}

	/**
	 * タブの検出結果が変わったときに呼ぶ。未解析の HLS があれば解析する。
	 *
	 * @param generation 呼び出し元がイベントを受け取った時点の世代
	 */
	async resolvePending(tabId: number, media: DetectedMedia[], generation: number): Promise<void> {
		for (const item of media) {
			// 1 件ごとに世代を確認する。取得は 1 件あたり数秒かかることがあり、
			// その間にページ遷移が起きると、クリア済みの状態へ旧ページのキーを
			// 入れ直してしまう（遷移後のページで解析が始まらなくなる）
			if (generation !== this.registry.currentGeneration(tabId)) return;

			if (item.type !== 'hls') continue;
			if (item.manifestResolved === true) continue;

			const key = handledKey(tabId, item.dedupeKey);
			const state = this.states.get(key);
			if (state?.status === 'resolving' || state?.status === 'settled') continue;

			const attempts = (state?.attempts ?? 0) + 1;
			if (attempts > MAX_ATTEMPTS) continue;

			this.states.set(key, { status: 'resolving' });
			const outcome = await this.resolve(tabId, item, generation);

			if (generation !== this.registry.currentGeneration(tabId)) {
				// 取得中に遷移した。旧ページの状態を残さない（`forgetTab` と前後してもよいように）
				this.states.delete(key);
				return;
			}

			this.states.set(
				key,
				outcome === 'transient-failure' ? { status: 'failed', attempts } : { status: 'settled' },
			);
		}
	}

	/**
	 * 当該タブの状態をすべて捨てる。ページ遷移・タブ破棄時に呼ぶ。
	 * 捨てないと、同じページを開き直しても再解析されない。
	 */
	forgetTab(tabId: number): void {
		const prefix = handledKey(tabId, '');
		for (const key of this.states.keys()) {
			if (key.startsWith(prefix)) this.states.delete(key);
		}
	}

	/**
	 * 失敗の記録だけを捨てる。ユーザーの明示的な再試行（更新ボタン）で呼ぶ。
	 *
	 * 取得中の項目は残す。消すと同じ URL への取得が二重に走る。
	 */
	resetFailures(tabId: number): void {
		const prefix = handledKey(tabId, '');
		for (const [key, state] of this.states) {
			if (key.startsWith(prefix) && state.status === 'failed') this.states.delete(key);
		}
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
