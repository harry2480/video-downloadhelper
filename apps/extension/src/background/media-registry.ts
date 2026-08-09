import {
	type DetectionInput,
	createDetectedMedia,
	upsertDetectedMedia,
} from '../media/detected-media.model';
import type { DetectedMediaRepository } from '../shared/storage/detected-media.repository';
import type { DetectedMedia } from '../shared/types';

/**
 * タブ単位の検出結果を集約する。
 *
 * **状態の所有者はここではなく Repository（chrome.storage.session）。**
 * Service Worker はいつ停止してもよく、停止後に再起動しても
 * Repository から復元できる形を保つ。インスタンス変数へ検出結果を
 * 溜め込まないこと。
 */
/**
 * 1 タブあたりに保持する検出結果の上限。
 *
 * DOM 検出は検出内容がページ側の操作で決まるため、上限がないと
 * 際限なく増える。1 件追加ごとに配列全体の読み書きが走るため、
 * 増えるほど遅くなり storage の容量も圧迫する（要件定義 2.7）。
 */
const MAX_MEDIA_PER_TAB = 200;

export class MediaRegistry {
	/**
	 * タブごとの直列化キュー。
	 *
	 * webRequest のイベントは高頻度で並行して届く。read-modify-write を
	 * 素で行うと後勝ちで検出結果が失われるため、タブ単位で順番に処理する。
	 */
	private readonly queues = new Map<number, Promise<unknown>>();

	/**
	 * タブごとの世代番号。ページ遷移のたびに 1 つ進める。
	 *
	 * 検出は「イベント発生 → 非同期でタブ情報を取得 → 登録」という流れで、
	 * イベント発生から登録までに間がある。この間に通常遷移が起きると、
	 * クリア済みのタブへ旧ページの検出結果を書き戻してしまう。
	 * 世代を突き合わせて、遷移前のイベント由来の登録を破棄する。
	 *
	 * タブ ID をキーにした数値のみで、閉じたタブの分も残す。
	 * 消すと世代が 0 に戻り、遅れて届いた旧登録と一致してしまうため。
	 */
	private readonly generations = new Map<number, number>();

	constructor(
		private readonly repository: DetectedMediaRepository,
		private readonly onTabChanged: (tabId: number, media: DetectedMedia[]) => void,
	) {}

	/**
	 * 現在の世代を返す。
	 *
	 * **イベントを受け取った時点で同期的に呼ぶこと。** `await` をまたいでから
	 * 呼ぶと遷移後の世代を拾ってしまい、この仕組みが意味をなさなくなる。
	 */
	currentGeneration(tabId: number): number {
		return this.generations.get(tabId) ?? 0;
	}

	/**
	 * 検出候補を取り込む。
	 *
	 * 生成に失敗した候補（blob URL、対応外形式など）は黙って捨てる。
	 * 検出は「候補を拾って絞る」処理であり、絞られること自体は異常ではない。
	 *
	 * @param generation イベントを受け取った時点の世代。遷移後なら破棄する
	 */
	async register(input: DetectionInput, generation: number): Promise<void> {
		const created = createDetectedMedia(input);
		if (!created.ok) return;
		if (generation !== this.currentGeneration(input.tabId)) return;

		await this.enqueue(input.tabId, async () => {
			// キューを待っている間にも遷移し得るため、保存の直前に再確認する
			if (generation !== this.currentGeneration(input.tabId)) return;

			const current = await this.repository.findByTab(input.tabId);

			// 既存の統合は上限に関わらず通す。新規追加のみ打ち切る
			const isNew = !current.some((media) => media.dedupeKey === created.value.dedupeKey);
			if (isNew && current.length >= MAX_MEDIA_PER_TAB) return;

			const next = upsertDetectedMedia(current, created.value);

			await this.repository.saveForTab(input.tabId, next);
			this.onTabChanged(input.tabId, next);
		});
	}

	async list(tabId: number): Promise<DetectedMedia[]> {
		return this.enqueue(tabId, () => this.repository.findByTab(tabId));
	}

	/**
	 * ページ遷移・タブ破棄時に呼ぶ。
	 *
	 * 世代の更新はキューに入れず、呼ばれた時点で同期的に行う。
	 * キューの中で進めると、順番待ちしている旧世代の登録が先に保存される。
	 */
	async clearTab(tabId: number): Promise<void> {
		this.generations.set(tabId, this.currentGeneration(tabId) + 1);

		await this.enqueue(tabId, async () => {
			await this.repository.clearTab(tabId);
			this.onTabChanged(tabId, []);
		});
	}

	/**
	 * タブ単位で直列に実行する。
	 *
	 * 直前の処理が失敗しても後続を止めない（1件の検出失敗で以降の検出が
	 * 全部落ちる方が有害なため）。
	 */
	private enqueue<T>(tabId: number, task: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(tabId) ?? Promise.resolve();
		const result = previous.then(task, task);

		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(tabId, settled);

		// キューが空になったら Map から落とす。タブを開閉し続けても増え続けないように
		void settled.then(() => {
			if (this.queues.get(tabId) === settled) this.queues.delete(tabId);
		});

		return result;
	}
}
