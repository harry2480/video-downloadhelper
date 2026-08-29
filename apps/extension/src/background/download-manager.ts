import {
	applyDownloadSnapshot,
	isActive,
	markDownloadCancelled,
	markDownloadFailed,
	resetDownloadTask,
} from '../processor/download-task';
import { buildFilename } from '../processor/filename';
import type { DownloaderPort } from '../shared/ports/download.port';
import type { DownloadTaskRepository } from '../shared/storage/download-task.repository';
import type { DetectedMedia, DownloadRequest, DownloadTask, MediaVariant } from '../shared/types';
import type { MediaRegistry } from './media-registry';

/**
 * ダウンロードの開始・進捗追跡・キャンセル・再試行（要件定義 2.6）。
 *
 * **状態の所有者は Repository（chrome.storage.session）。**
 * Service Worker はいつ停止してもよく、再起動後は storage から復元する。
 * インスタンス変数へタスクを溜め込まないこと。
 *
 * Phase 1 は直接保存できるメディアのみを扱う。HLS のセグメント取得・結合は
 * Offscreen Document へ委譲する形で別途実装する。
 */

/** 保持するタスク数の上限。超えたら終了済みの古いものから捨てる。 */
const MAX_TASKS = 100;

const DRM_REJECTED = 'DRM で保護されているため保存できません';
const NOT_DOWNLOADABLE = 'この形式の保存にはまだ対応していません';
const MEDIA_GONE = 'メディアが見つかりませんでした（ページを再読み込みしてください）';
const START_FAILED = 'ダウンロードを開始できませんでした';
const INVALID_FILENAME = 'ファイル名が受け付けられませんでした';
const DENIED = 'ブラウザにダウンロードを拒否されました';

/** Phase 1 で直接保存できる形式。 */
const DOWNLOADABLE_TYPES = new Set(['direct', 'audio']);

export class DownloadManager {
	/**
	 * 直列化キュー。
	 *
	 * タスク一覧は 1 つのレコードとして読み書きするため、素で並行に扱うと
	 * 後勝ちで更新が消える。ブラウザからの変化通知とユーザー操作は同時に来る。
	 */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly downloader: DownloaderPort,
		private readonly repository: DownloadTaskRepository,
		private readonly registry: MediaRegistry,
		private readonly onTasksChanged: (tabId: number, tasks: DownloadTask[]) => void,
		private readonly now: () => number = () => Date.now(),
		private readonly createId: () => string = () => crypto.randomUUID(),
	) {}

	/** 当該タブのタスクを新しい順で返す。 */
	async listByTab(tabId: number): Promise<DownloadTask[]> {
		return this.enqueue(async () => forTab(await this.repository.findAll(), tabId));
	}

	/** ダウンロードを開始する。選択品質は要求に載って渡る（要件定義 5.3）。 */
	async start(tabId: number, request: DownloadRequest): Promise<void> {
		await this.enqueue(async () => {
			const tasks = await this.repository.findAll();

			// 同じメディアの取得が進行中なら二重に始めない
			if (tasks.some((task) => task.mediaId === request.mediaId && isActive(task))) return;

			const media = (await this.registry.list(tabId)).find((item) => item.id === request.mediaId);

			const variant = findVariant(media, request.variantId);
			const task = this.createTask(tabId, request, media, variant);

			const rejection = rejectionReason(media);
			if (rejection !== undefined) {
				await this.commit([markDownloadFailed(task, rejection), ...tasks], tabId);
				return;
			}
			// rejectionReason が undefined を返した時点でメディアは存在する
			if (media === undefined) return;

			await this.commit([task, ...tasks], tabId);
			await this.begin(task, variant?.url ?? media.sourceUrl);
		});
	}

	/** 進行中のダウンロードを止める。 */
	async cancel(taskId: string): Promise<void> {
		await this.enqueue(async () => {
			const tasks = await this.repository.findAll();
			const target = tasks.find((task) => task.id === taskId);
			if (target === undefined || !isActive(target)) return;

			if (target.browserDownloadId !== undefined) {
				await this.downloader.cancel(target.browserDownloadId);
			}

			await this.commit(replace(tasks, markDownloadCancelled(target)), target.tabId);
		});
	}

	/** 失敗・中止したダウンロードをやり直す（要件定義 2.6）。 */
	async retry(taskId: string): Promise<void> {
		await this.enqueue(async () => {
			const tasks = await this.repository.findAll();
			const target = tasks.find((task) => task.id === taskId);
			if (target === undefined || isActive(target)) return;

			const media = (await this.registry.list(target.tabId)).find(
				(item) => item.id === target.mediaId,
			);
			const variant = findVariant(media, target.variantId);

			const rejection = rejectionReason(media);
			if (rejection !== undefined) {
				await this.commit(replace(tasks, markDownloadFailed(target, rejection)), target.tabId);
				return;
			}
			if (media === undefined) return;

			const restarted = resetDownloadTask(target, this.now());
			await this.commit(replace(tasks, restarted), restarted.tabId);
			await this.begin(restarted, variant?.url ?? media.sourceUrl);
		});
	}

	/**
	 * 進行中タスクの現況をブラウザから取り込む。
	 *
	 * `chrome.downloads` は受信バイト数を通知しないため、進捗はここで問い合わせる。
	 * ポップアップが開いている間だけ呼ぶ（誰も見ていないときに回さない）。
	 */
	async refresh(): Promise<void> {
		await this.enqueue(async () => {
			const tasks = await this.repository.findAll();
			const ids = tasks.filter(isActive).flatMap(toBrowserId);
			if (ids.length === 0) return;

			await this.applySnapshots(tasks, ids);
		});
	}

	/** ブラウザ側の状態変化を取り込む。完了・中断はここで届く。 */
	async handleBrowserChange(downloadId: number): Promise<void> {
		await this.enqueue(async () => {
			const tasks = await this.repository.findAll();
			const known = tasks.some((task) => task.browserDownloadId === downloadId);

			// 拡張機能と無関係なダウンロードの通知も届く
			if (!known) return;

			await this.applySnapshots(tasks, [downloadId]);
		});
	}

	/** タブが閉じられたときに呼ぶ。進行中の取得は残さない。 */
	async forgetTab(tabId: number): Promise<void> {
		await this.enqueue(async () => {
			const tasks = await this.repository.findAll();
			const remaining = tasks.filter((task) => task.tabId !== tabId);
			if (remaining.length === tasks.length) return;

			await this.repository.saveAll(remaining);
			this.onTasksChanged(tabId, []);
		});
	}

	private createTask(
		tabId: number,
		request: DownloadRequest,
		media: DetectedMedia | undefined,
		variant: MediaVariant | undefined,
	): DownloadTask {
		return {
			id: this.createId(),
			mediaId: request.mediaId,
			...(request.variantId !== undefined && { variantId: request.variantId }),
			...(request.audioVariantId !== undefined && { audioVariantId: request.audioVariantId }),
			tabId,
			filename: media === undefined ? '' : buildFilename({ media, variant }),
			status: 'queued',
			progress: 0,
			startedAt: this.now(),
		};
	}

	/** ブラウザへ取得を依頼し、結果をタスクへ反映する。 */
	private async begin(task: DownloadTask, url: string): Promise<void> {
		const started = await this.downloader.start({ url, filename: task.filename });
		const tasks = await this.repository.findAll();

		// 依頼している間にキャンセルされていることがある
		const current = tasks.find((item) => item.id === task.id);
		if (current === undefined || !isActive(current)) return;

		if (!started.ok) {
			await this.commit(
				replace(tasks, markDownloadFailed(current, describe(started.error))),
				task.tabId,
			);
			return;
		}

		await this.commit(
			replace(tasks, { ...current, status: 'downloading', browserDownloadId: started.value }),
			task.tabId,
		);
	}

	/** 問い合わせた現況をタスクへ反映し、変化があれば保存して通知する。 */
	private async applySnapshots(tasks: DownloadTask[], ids: number[]): Promise<void> {
		const snapshots = await this.downloader.query(ids);
		if (snapshots.length === 0) return;

		const changedTabs = new Set<number>();
		const next = tasks.map((task) => {
			const snapshot = snapshots.find((item) => item.downloadId === task.browserDownloadId);
			if (snapshot === undefined) return task;

			const updated = applyDownloadSnapshot(task, snapshot);
			if (!hasChanged(task, updated)) return task;

			changedTabs.add(task.tabId);
			return updated;
		});

		if (changedTabs.size === 0) return;

		await this.repository.saveAll(next);
		for (const tabId of changedTabs) this.onTasksChanged(tabId, forTab(next, tabId));
	}

	/** 保存して当該タブへ通知する。 */
	private async commit(tasks: DownloadTask[], tabId: number): Promise<void> {
		const capped = capTasks(tasks);
		await this.repository.saveAll(capped);
		this.onTasksChanged(tabId, forTab(capped, tabId));
	}

	/**
	 * 直列に実行する。
	 *
	 * 直前の処理が失敗しても後続を止めない（1 件の失敗で以降の操作が
	 * 全部落ちる方が有害なため）。
	 */
	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.queue.then(task, task);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function forTab(tasks: readonly DownloadTask[], tabId: number): DownloadTask[] {
	return tasks.filter((task) => task.tabId === tabId).sort((a, b) => b.startedAt - a.startedAt);
}

function replace(tasks: readonly DownloadTask[], updated: DownloadTask): DownloadTask[] {
	return tasks.map((task) => (task.id === updated.id ? updated : task));
}

function toBrowserId(task: DownloadTask): number[] {
	return task.browserDownloadId === undefined ? [] : [task.browserDownloadId];
}

function findVariant(
	media: DetectedMedia | undefined,
	variantId: string | undefined,
): MediaVariant | undefined {
	if (media === undefined || variantId === undefined) return undefined;
	return media.variants?.find((variant) => variant.id === variantId);
}

/** 保存できない理由。保存してよければ `undefined`。 */
function rejectionReason(media: DetectedMedia | undefined): string | undefined {
	if (media === undefined) return MEDIA_GONE;
	if (media.drm === true) return DRM_REJECTED;
	if (media.unsupportedReason !== undefined) return media.unsupportedReason;
	if (!DOWNLOADABLE_TYPES.has(media.type)) return NOT_DOWNLOADABLE;
	return undefined;
}

function describe(failure: { reason: string }): string {
	if (failure.reason === 'invalid-filename') return INVALID_FILENAME;
	if (failure.reason === 'denied') return DENIED;
	return START_FAILED;
}

/** 表示に影響する値が変わったか。変わっていなければ保存も通知もしない。 */
function hasChanged(before: DownloadTask, after: DownloadTask): boolean {
	return (
		before.status !== after.status ||
		before.progress !== after.progress ||
		before.downloadedBytes !== after.downloadedBytes ||
		before.totalBytes !== after.totalBytes ||
		before.error !== after.error
	);
}

/**
 * 上限を超えた分を捨てる。
 *
 * 終了済みの古いものから捨て、進行中のタスクは残す。
 */
function capTasks(tasks: readonly DownloadTask[]): DownloadTask[] {
	if (tasks.length <= MAX_TASKS) return [...tasks];

	const active = tasks.filter(isActive);
	const finished = tasks.filter((task) => !isActive(task));
	const keep = finished
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, Math.max(0, MAX_TASKS - active.length));

	return [...active, ...keep];
}
