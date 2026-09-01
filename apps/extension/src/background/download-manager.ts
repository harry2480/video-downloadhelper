import { downloadRejectionReason, resolveDownloadUrl } from '../media/downloadable';
import { variantKey } from '../media/variant-selection';
import type { MediaContainer } from '../processor/download-plan';
import {
	applyDownloadSnapshot,
	isActive,
	markDownloadCancelled,
	markDownloadFailed,
	resetDownloadTask,
} from '../processor/download-task';
import { buildFilename } from '../processor/filename';
import type { AssemblerPort } from '../shared/ports/assembler.port';
import type { DownloadStartFailure, DownloaderPort } from '../shared/ports/download.port';
import type { DownloadTaskRepository } from '../shared/storage/download-task.repository';
import type { DetectedMedia, DownloadRequest, DownloadTask, MediaVariant } from '../shared/types';
import { isPrivateHostUrl } from '../shared/utils';
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

/**
 * 開始したまま動かないタスクを諦めるまでの時間（ms）。
 *
 * ブラウザへ依頼する前に Service Worker が停止すると、`browserDownloadId` を
 * 持たないタスクが残る。問い合わせ対象にならないため放置すると 0% で固まる。
 */
const STALE_QUEUED_MS = 60_000;

/**
 * 1 ファイルあたりの上限（要件定義 2.6）。
 *
 * HLS は取得したセグメントを Blob へ組み立ててから保存するため、
 * 全体がメモリに載る。逐次書き込み（File System Access API）は将来の拡張。
 */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const MEDIA_GONE = 'メディアが見つかりませんでした（ページを再読み込みしてください）';
const VARIANT_GONE = '選択した画質が見つかりませんでした（選び直してください）';
const TOO_LARGE = '推定サイズが上限（2GB）を超えるため保存できません';
const ASSEMBLY_FAILED = 'セグメントの取得を開始できませんでした';
const LOST = 'ダウンロードの状況を取得できなくなりました';
const START_FAILED = 'ダウンロードを開始できませんでした';
const INVALID_FILENAME = 'ファイル名が受け付けられませんでした';
const DENIED = 'ブラウザにダウンロードを拒否されました';

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
		private readonly assembler: AssemblerPort,
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

			const lookup = lookupVariant(media, request.variantKey);
			const variant = lookup.kind === 'found' ? lookup.variant : undefined;
			const task = this.createTask(tabId, request, media, variant);

			if (media === undefined) {
				await this.commit([markDownloadFailed(task, MEDIA_GONE), ...tasks], tabId);
				return;
			}

			// 選ばれていた画質が消えているなら、既定へ落とさず失敗させる
			if (lookup.kind === 'gone') {
				await this.commit([markDownloadFailed(task, VARIANT_GONE), ...tasks], tabId);
				return;
			}

			const target = resolveDownloadUrl(media, variant);
			const rejection = downloadRejectionReason(media, variant);

			if (rejection !== undefined || target === undefined) {
				await this.commit([markDownloadFailed(task, rejection ?? MEDIA_GONE), ...tasks], tabId);
				return;
			}

			await this.commit([task, ...tasks], tabId);
			await this.beginTask(task, media, variant, target);
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
			if (target.status === 'processing') {
				await this.assembler.cancel(target.id);
			}
			await this.releaseUrl(target.objectUrl);

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
			const lookup = lookupVariant(media, target.variantKey);
			const variant = lookup.kind === 'found' ? lookup.variant : undefined;

			if (media === undefined) {
				await this.commit(replace(tasks, markDownloadFailed(target, MEDIA_GONE)), target.tabId);
				return;
			}

			// 再試行までの間に再解析が挟まると、覚えていた画質が消えていることがある
			if (lookup.kind === 'gone') {
				await this.commit(replace(tasks, markDownloadFailed(target, VARIANT_GONE)), target.tabId);
				return;
			}

			const url = resolveDownloadUrl(media, variant);
			const rejection = downloadRejectionReason(media, variant);

			if (rejection !== undefined || url === undefined) {
				await this.commit(
					replace(tasks, markDownloadFailed(target, rejection ?? MEDIA_GONE)),
					target.tabId,
				);
				return;
			}

			const restarted = resetDownloadTask(target, this.now());
			await this.commit(replace(tasks, restarted), restarted.tabId);
			await this.beginTask(restarted, media, variant, url);
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
			const swept = this.sweepStale(await this.repository.findAll());
			const ids = swept.tasks.filter(isActive).flatMap(toBrowserId);

			if (ids.length === 0) {
				if (swept.changed) await this.saveAndNotify(swept.tasks, swept.changedTabs);
				return;
			}

			await this.applySnapshots(swept.tasks, ids, swept.changedTabs);
		});
	}

	/**
	 * ブラウザへ依頼できないまま残ったタスクを諦める。
	 *
	 * 依頼の直前に Service Worker が停止すると `browserDownloadId` を持たない
	 * アクティブなタスクが残り、問い合わせ対象にならないので永久に 0% で固まる。
	 */
	private sweepStale(tasks: DownloadTask[]): {
		tasks: DownloadTask[];
		changed: boolean;
		changedTabs: Set<number>;
	} {
		const changedTabs = new Set<number>();
		const now = this.now();

		const next = tasks.map((task) => {
			// 組み立て中（HLS）は browserDownloadId を持たないまま長く走る。
			// 掃除の対象は「依頼を出す直前で止まった」開始待ちだけにする
			if (task.status !== 'queued') return task;
			if (now - task.startedAt < STALE_QUEUED_MS) return task;

			changedTabs.add(task.tabId);
			return markDownloadFailed(task, START_FAILED);
		});

		return { tasks: next, changed: changedTabs.size > 0, changedTabs };
	}

	/** ブラウザ側の状態変化を取り込む。完了・中断はここで届く。 */
	async handleBrowserChange(downloadId: number): Promise<void> {
		await this.enqueue(async () => {
			const tasks = await this.repository.findAll();
			const known = tasks.some((task) => task.browserDownloadId === downloadId);

			// 拡張機能と無関係なダウンロードの通知も届く
			if (!known) return;

			await this.applySnapshots(tasks, [downloadId], new Set());
		});
	}

	/**
	 * タブが閉じられたときに呼ぶ。当該タブのタスクを一覧から外す。
	 *
	 * ブラウザ側の保存は止めない。ページの寿命とは独立して進むため。
	 */
	async forgetTab(tabId: number): Promise<void> {
		await this.enqueue(async () => {
			const own = splitByTab(await this.repository.findAll(), tabId);
			if (own.mine.length === 0) return;

			// **ブラウザへ渡した Blob を保存中のタスクは残す。**
			// ここで手放すとオブジェクト URL を解放する者が居なくなり、
			// 解放すれば読み込み中の保存が壊れる。完了を見届けてから解放する
			const [retained, dropped] = partition(own.mine, holdsBlobDownload);

			await this.repository.saveAll([...own.others, ...retained]);
			this.onTasksChanged(tabId, []);

			// 拡張機能の中に閉じた資源は道連れにする。
			// ブラウザ側の保存だけはページの寿命と独立して続く
			for (const task of dropped) {
				if (task.status === 'processing') await this.assembler.cancel(task.id);
				await this.releaseUrl(task.objectUrl);
			}
		});
	}

	/** オブジェクト URL があれば解放する。 */
	private async releaseUrl(objectUrl: string | undefined): Promise<void> {
		if (objectUrl === undefined) return;
		await this.assembler.release(objectUrl);
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
			...(request.variantKey !== undefined && { variantKey: request.variantKey }),
			...(request.audioVariantKey !== undefined && { audioVariantKey: request.audioVariantKey }),
			tabId,
			filename: media === undefined ? '' : buildFilename({ media, variant }),
			status: 'queued',
			progress: 0,
			startedAt: this.now(),
		};
	}

	/** 組み立ての進捗を取り込む（Offscreen からの通知）。 */
	async handleAssemblyProgress(
		taskId: string,
		completed: number,
		total: number,
		bytes: number,
	): Promise<void> {
		await this.enqueue(async () => {
			const tasks = await this.repository.findAll();
			const target = tasks.find((task) => task.id === taskId);
			if (target === undefined || !isActive(target)) return;

			const progress = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
			const updated: DownloadTask = {
				...target,
				status: 'processing',
				progress,
				downloadedBytes: bytes,
			};
			if (!hasChanged(target, updated)) return;

			await this.commit(replace(tasks, updated), target.tabId);
		});
	}

	/** 組み立てが終わった。出来上がった Blob をブラウザへ渡して保存する。 */
	async handleAssemblyDone(
		taskId: string,
		objectUrl: string,
		bytes: number,
		container: MediaContainer,
	): Promise<void> {
		await this.enqueue(async () => {
			const tasks = await this.repository.findAll();
			const target = tasks.find((task) => task.id === taskId);

			// 組み立て中に中止・タブ破棄が起きていることがある。作った Blob は捨てる
			if (target === undefined || !isActive(target)) {
				await this.assembler.release(objectUrl);
				return;
			}

			// **拡張子は出来上がったものに合わせる。** タスクを作る時点では
			// Media Playlist を読んでいないため、HLS は一律 .ts になっている。
			// fMP4 を .ts で保存すると、プレイヤーが開けないファイルになる
			const ready: DownloadTask = {
				...target,
				filename: withExtension(target.filename, container),
				objectUrl,
				totalBytes: bytes,
				progress: 100,
			};
			await this.commit(replace(tasks, ready), ready.tabId);
			await this.begin(ready, objectUrl);
		});
	}

	/** 組み立てに失敗した。理由は Offscreen 側でユーザー向けの文言にしてある。 */
	async handleAssemblyFailed(taskId: string, reason: string): Promise<void> {
		await this.enqueue(async () => {
			const tasks = await this.repository.findAll();
			const target = tasks.find((task) => task.id === taskId);
			if (target === undefined || !isActive(target)) return;

			await this.commit(replace(tasks, markDownloadFailed(target, reason)), target.tabId);
		});
	}

	/**
	 * 取得を始める。直接保存できるものはブラウザへ、HLS / DASH は Offscreen へ渡す。
	 *
	 * セグメントを取得して結合する必要があり、`URL.createObjectURL` が
	 * 使えない Service Worker では完結しない（要件定義 2.6）。
	 */
	private async beginTask(
		task: DownloadTask,
		media: DetectedMedia,
		variant: MediaVariant | undefined,
		url: string,
	): Promise<void> {
		// 直接保存できるものはブラウザへ渡す。セグメントを集める必要があるのは
		// HLS と DASH だけ
		if (media.type !== 'hls' && media.type !== 'dash') {
			await this.begin(task, url);
			return;
		}

		// 取りかかる前に見込みで弾く。組み立て中にも実測で打ち切る
		const estimated = variant?.estimatedSize ?? media.estimatedSize;
		if (estimated !== undefined && estimated > MAX_TOTAL_BYTES) {
			await this.failTask(task.id, TOO_LARGE);
			return;
		}

		// **依頼と同時に processing にする。** 最初の進捗が届くまで queued のままだと、
		// 開始待ちの掃除（`sweepStale`）に巻き込まれて取得済みのデータが無駄になる
		await this.mark(task.id, (current) => ({ ...current, status: 'processing' }));

		try {
			await this.assembler.start({
				taskId: task.id,
				// **DASH は MPD を読み直して計画を組み立てる。** variant の URL は
				// 初期化セグメントを指すため、マニフェストとしては使えない
				manifestUrl: media.type === 'dash' ? media.sourceUrl : url,
				format: media.type,
				...(media.type === 'dash' &&
					variant?.sourceId !== undefined && { representationId: variant.sourceId }),
				maxBytes: MAX_TOTAL_BYTES,
				// ページが差し替えられない値で判断する。公開ページから
				// LAN やループバックを叩かせないため
				allowPrivateHosts: isPrivateHostUrl(media.sourceUrl),
			});
		} catch {
			await this.failTask(task.id, ASSEMBLY_FAILED);
		}
	}

	/** キューの中から呼ぶ前提で、1 件を書き換える。 */
	private async mark(
		taskId: string,
		transform: (task: DownloadTask) => DownloadTask,
	): Promise<void> {
		const tasks = await this.repository.findAll();
		const target = tasks.find((task) => task.id === taskId);
		if (target === undefined) return;

		await this.commit(replace(tasks, transform(target)), target.tabId);
	}

	/** キューの中から呼ぶ前提で、1 件を失敗にする。 */
	private async failTask(taskId: string, reason: string): Promise<void> {
		await this.mark(taskId, (task) => markDownloadFailed(task, reason));
	}

	/** ブラウザへ取得を依頼し、結果をタスクへ反映する。 */
	private async begin(task: DownloadTask, url: string): Promise<void> {
		const started = await this.downloader.start({ url, filename: task.filename });
		const tasks = await this.repository.findAll();

		// キューの中で実行されるため、依頼中に他の操作は割り込まない。
		// ただし依頼が返るまでキューを占有する点は意識しておくこと
		const current = tasks.find((item) => item.id === task.id);
		if (current === undefined || !isActive(current)) {
			// 組み立て済みの Blob を渡せなかった。抱えたままにしない
			await this.releaseUrl(task.objectUrl);
			return;
		}

		if (!started.ok) {
			await this.commit(
				replace(tasks, markDownloadFailed(current, describe(started.error))),
				task.tabId,
			);
			await this.releaseUrl(current.objectUrl);
			return;
		}

		await this.commit(
			replace(tasks, { ...current, status: 'downloading', browserDownloadId: started.value }),
			task.tabId,
		);
	}

	/** 問い合わせた現況をタスクへ反映し、変化があれば保存して通知する。 */
	private async applySnapshots(
		tasks: DownloadTask[],
		ids: number[],
		changedTabs: Set<number>,
	): Promise<void> {
		const snapshots = await this.downloader.query(ids);
		const released: string[] = [];

		const next = tasks.map((task) => {
			const id = task.browserDownloadId;
			if (id === undefined || !ids.includes(id)) return task;

			const snapshot = snapshots.find((item) => item.downloadId === id);

			// 問い合わせても返らない＝履歴から消された。進行中のまま残さない
			const updated =
				snapshot === undefined
					? isActive(task)
						? markDownloadFailed(task, LOST)
						: task
					: applyDownloadSnapshot(task, snapshot);

			if (!hasChanged(task, updated)) return task;

			// 保存が終わったら Blob を解放する。持ち続けるとメモリに残り続ける
			if (isActive(task) && !isActive(updated) && task.objectUrl !== undefined) {
				released.push(task.objectUrl);
			}

			changedTabs.add(task.tabId);
			return updated;
		});

		await this.saveAndNotify(next, changedTabs);
		for (const objectUrl of released) await this.releaseUrl(objectUrl);
	}

	private async saveAndNotify(tasks: DownloadTask[], changedTabs: Set<number>): Promise<void> {
		if (changedTabs.size === 0) return;

		await this.repository.saveAll(tasks);
		for (const tabId of changedTabs) this.onTasksChanged(tabId, forTab(tasks, tabId));
	}

	/**
	 * 保存して通知する。
	 *
	 * 上限超過で捨てたタスクのタブへも通知する。捨てられた側のタブで
	 * ポップアップが開いていると、消えたはずのタスクを表示し続けるため。
	 */
	private async commit(tasks: DownloadTask[], tabId: number): Promise<void> {
		const capped = capTasks(tasks);

		const kept = new Set(capped.map((task) => task.id));
		const changedTabs = new Set([tabId]);
		for (const task of tasks) {
			if (!kept.has(task.id)) changedTabs.add(task.tabId);
		}

		await this.repository.saveAll(capped);
		for (const changed of changedTabs) this.onTasksChanged(changed, forTab(capped, changed));
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

/** ブラウザが Blob を読んでいる最中か。解放を待つ必要がある。 */
function holdsBlobDownload(task: DownloadTask): boolean {
	return task.objectUrl !== undefined && task.browserDownloadId !== undefined && isActive(task);
}

function splitByTab(
	tasks: readonly DownloadTask[],
	tabId: number,
): { mine: DownloadTask[]; others: DownloadTask[] } {
	return {
		mine: tasks.filter((task) => task.tabId === tabId),
		others: tasks.filter((task) => task.tabId !== tabId),
	};
}

function partition(
	tasks: readonly DownloadTask[],
	predicate: (task: DownloadTask) => boolean,
): [DownloadTask[], DownloadTask[]] {
	const matched: DownloadTask[] = [];
	const rest: DownloadTask[] = [];
	for (const task of tasks) (predicate(task) ? matched : rest).push(task);
	return [matched, rest];
}

function forTab(tasks: readonly DownloadTask[], tabId: number): DownloadTask[] {
	return tasks.filter((task) => task.tabId === tabId).sort((a, b) => b.startedAt - a.startedAt);
}

function replace(tasks: readonly DownloadTask[], updated: DownloadTask): DownloadTask[] {
	return tasks.map((task) => (task.id === updated.id ? updated : task));
}

/**
 * 保存名の拡張子を差し替える。
 *
 * 既に同じ拡張子なら触らない。ベース名にドットが含まれていても、
 * 最後のドットより後ろだけを見る。
 */
function withExtension(filename: string, container: MediaContainer): string {
	const dotIndex = filename.lastIndexOf('.');
	const base = dotIndex <= 0 ? filename : filename.slice(0, dotIndex);
	return `${base}.${container}`;
}

function toBrowserId(task: DownloadTask): number[] {
	return task.browserDownloadId === undefined ? [] : [task.browserDownloadId];
}

/**
 * 要求された品質を、いまの検出結果から引き直した結果。
 *
 * **「指定なし」と「指定されたが見つからない」を分ける。** 混同すると
 * `resolveDownloadUrl` が `media.sourceUrl`（HLS なら Master Playlist）へ
 * フォールバックし、動画のつもりでプレイリストを保存してしまう。
 */
type VariantLookup =
	/** 品質の指定がない。既定（メディア自身の URL）でよい */
	| { kind: 'unspecified' }
	| { kind: 'found'; variant: MediaVariant }
	/** 指定はあったが、いまの一覧に無い。再解析で入れ替わった場合など */
	| { kind: 'gone' };

function lookupVariant(media: DetectedMedia | undefined, key: string | undefined): VariantLookup {
	if (key === undefined) return { kind: 'unspecified' };

	const variant = media?.variants?.find((item) => variantKey(item) === key);
	return variant === undefined ? { kind: 'gone' } : { kind: 'found', variant };
}

function describe(failure: DownloadStartFailure): string {
	switch (failure.reason) {
		case 'invalid-filename':
			return INVALID_FILENAME;
		case 'denied':
			return DENIED;
		default:
			return START_FAILED;
	}
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
