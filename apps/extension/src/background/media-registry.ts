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
export class MediaRegistry {
	/**
	 * タブごとの直列化キュー。
	 *
	 * webRequest のイベントは高頻度で並行して届く。read-modify-write を
	 * 素で行うと後勝ちで検出結果が失われるため、タブ単位で順番に処理する。
	 */
	private readonly queues = new Map<number, Promise<unknown>>();

	constructor(
		private readonly repository: DetectedMediaRepository,
		private readonly onTabChanged: (tabId: number, media: DetectedMedia[]) => void,
	) {}

	/**
	 * 検出候補を取り込む。
	 *
	 * 生成に失敗した候補（blob URL、対応外形式など）は黙って捨てる。
	 * 検出は「候補を拾って絞る」処理であり、絞られること自体は異常ではない。
	 */
	async register(input: DetectionInput): Promise<void> {
		const created = createDetectedMedia(input);
		if (!created.ok) return;

		await this.enqueue(input.tabId, async () => {
			const current = await this.repository.findByTab(input.tabId);
			const next = upsertDetectedMedia(current, created.value);

			await this.repository.saveForTab(input.tabId, next);
			this.onTabChanged(input.tabId, next);
		});
	}

	async list(tabId: number): Promise<DetectedMedia[]> {
		return this.enqueue(tabId, () => this.repository.findByTab(tabId));
	}

	/** ページ遷移・タブ破棄時に呼ぶ。 */
	async clearTab(tabId: number): Promise<void> {
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
