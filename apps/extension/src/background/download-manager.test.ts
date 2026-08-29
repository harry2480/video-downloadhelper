import { describe, expect, it } from 'vitest';
import type { DetectionInput } from '../media/detected-media.model';
import type {
	DownloadSnapshot,
	DownloadStartFailure,
	DownloaderPort,
} from '../shared/ports/download.port';
import type { DetectedMediaRepository } from '../shared/storage/detected-media.repository';
import type { DownloadTaskRepository } from '../shared/storage/download-task.repository';
import type { DetectedMedia, DownloadTask } from '../shared/types';
import { err, ok } from '../shared/utils';
import { DownloadManager } from './download-manager';
import { MediaRegistry } from './media-registry';

/**
 * DownloadManager は chrome.* に触れず、ブラウザの保存機能を Port 経由で受け取る。
 *
 * ここで押さえるのは「保存してよいものだけを保存すること」と
 * 「Service Worker が止まっても状態が storage 側に残ること」。
 */

const TAB_ID = 1;
const MP4_URL = 'https://cdn.example.com/movie.mp4';
const HLS_URL = 'https://cdn.example.com/master.m3u8';

function input(sourceUrl: string, overrides: Partial<DetectionInput> = {}): DetectionInput {
	return {
		tabId: TAB_ID,
		pageUrl: 'https://example.com/watch',
		pageTitle: 'サンプル動画',
		sourceUrl,
		detectedBy: 'network',
		detectedAt: 1_000,
		...overrides,
	};
}

function createHarness() {
	const mediaStore = new Map<number, DetectedMedia[]>();
	const mediaRepository: DetectedMediaRepository = {
		async findByTab(tabId) {
			return mediaStore.get(tabId) ?? [];
		},
		async saveForTab(tabId, media) {
			mediaStore.set(tabId, [...media]);
		},
		async clearTab(tabId) {
			mediaStore.delete(tabId);
		},
	};
	const registry = new MediaRegistry(mediaRepository, () => undefined);

	let stored: DownloadTask[] = [];
	const taskRepository: DownloadTaskRepository = {
		async findAll() {
			return [...stored];
		},
		async saveAll(tasks) {
			stored = [...tasks];
		},
	};

	const started: { url: string; filename: string }[] = [];
	const cancelled: number[] = [];
	let snapshots: DownloadSnapshot[] = [];
	let nextDownloadId = 1;
	let startResult: () => ReturnType<DownloaderPort['start']> = async () => ok(nextDownloadId++);

	const downloader: DownloaderPort = {
		async start(request) {
			started.push(request);
			return startResult();
		},
		async cancel(downloadId) {
			cancelled.push(downloadId);
		},
		async query(ids) {
			return snapshots.filter((snapshot) => ids.includes(snapshot.downloadId));
		},
		subscribe() {
			// Service Worker 側で購読する。ここでは使わない
		},
	};

	const broadcasts: { tabId: number; tasks: DownloadTask[] }[] = [];
	let seq = 0;
	let time = 1_000;
	const manager = new DownloadManager(
		downloader,
		taskRepository,
		registry,
		(tabId, tasks) => broadcasts.push({ tabId, tasks }),
		() => time,
		() => `task-${++seq}`,
	);

	return {
		manager,
		registry,
		started,
		cancelled,
		broadcasts,
		get tasks() {
			return stored;
		},
		failStart(failure: DownloadStartFailure) {
			startResult = async () => err(failure);
		},
		setSnapshots(next: DownloadSnapshot[]) {
			snapshots = next;
		},
		advance(ms: number) {
			time += ms;
		},
		/** Service Worker が依頼の途中で止まった状態を作る */
		strandTask() {
			stored = stored.map((task) => ({ ...task, status: 'queued' as const }));
		},
		async detect(sourceUrl: string, overrides: Partial<DetectionInput> = {}) {
			await registry.register(input(sourceUrl, overrides), registry.currentGeneration(TAB_ID));
			const media = await registry.list(TAB_ID);
			const found = media.find((item) => item.sourceUrl === sourceUrl);
			if (found === undefined) throw new Error('検出できていない');
			return found;
		},
		async enrich(dedupeKey: string, analysis: Parameters<MediaRegistry['enrich']>[3]) {
			await registry.enrich(TAB_ID, dedupeKey, registry.currentGeneration(TAB_ID), analysis);
		},
	};
}

describe('start', () => {
	it('直接メディアの保存を開始し、状態を保存する', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);

		await harness.manager.start(TAB_ID, { mediaId: media.id });

		expect(harness.started).toEqual([{ url: MP4_URL, filename: expect.stringMatching(/\.mp4$/) }]);
		expect(harness.tasks[0]).toMatchObject({
			mediaId: media.id,
			tabId: TAB_ID,
			status: 'downloading',
			browserDownloadId: 1,
		});
	});

	it('ページタイトルからファイル名を組み立てる', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);

		await harness.manager.start(TAB_ID, { mediaId: media.id });

		expect(harness.tasks[0]?.filename).toBe('サンプル動画.mp4');
	});

	it('選択された品質の URL を取得する', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.enrich(media.dedupeKey, {
			variants: [
				{ id: 'v0', url: 'https://cdn.example.com/1080.mp4', height: 1080 },
				{ id: 'v1', url: 'https://cdn.example.com/720.mp4', height: 720 },
			],
		});

		await harness.manager.start(TAB_ID, { mediaId: media.id, variantId: 'v1' });

		expect(harness.started[0]?.url).toBe('https://cdn.example.com/720.mp4');
		expect(harness.tasks[0]?.filename).toBe('サンプル動画_720p.mp4');
	});

	it('品質 URL のスキームが不正なら取得しない', async () => {
		// マニフェスト由来の URL は検出時の関門を通っていない
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.enrich(media.dedupeKey, {
			variants: [{ id: 'v0', url: 'file:///etc/passwd', height: 1080 }],
		});

		await harness.manager.start(TAB_ID, { mediaId: media.id, variantId: 'v0' });

		expect(harness.started).toHaveLength(0);
		expect(harness.tasks[0]?.status).toBe('failed');
	});

	it('DRM 保護されたメディアは保存しない', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.enrich(media.dedupeKey, { drm: true });

		await harness.manager.start(TAB_ID, { mediaId: media.id });

		expect(harness.started).toHaveLength(0);
		expect(harness.tasks[0]).toMatchObject({
			status: 'failed',
			error: expect.stringContaining('DRM'),
		});
	});

	it('HLS はまだ保存しない', async () => {
		// セグメント取得・結合の実装後に対応する
		const harness = createHarness();
		const media = await harness.detect(HLS_URL);

		await harness.manager.start(TAB_ID, { mediaId: media.id });

		expect(harness.started).toHaveLength(0);
		expect(harness.tasks[0]?.status).toBe('failed');
	});

	it('検出結果が消えていたら理由を残して失敗にする', async () => {
		const harness = createHarness();

		await harness.manager.start(TAB_ID, { mediaId: '1:https://cdn.example.com/gone.mp4' });

		expect(harness.started).toHaveLength(0);
		expect(harness.tasks[0]).toMatchObject({
			status: 'failed',
			error: expect.stringContaining('見つかりませんでした'),
		});
	});

	it('ブラウザに拒否されたら理由を残す', async () => {
		const harness = createHarness();
		harness.failStart({ reason: 'denied' });
		const media = await harness.detect(MP4_URL);

		await harness.manager.start(TAB_ID, { mediaId: media.id });

		expect(harness.tasks[0]).toMatchObject({
			status: 'failed',
			error: expect.stringContaining('拒否'),
		});
	});

	it('同じメディアの取得が進行中なら二重に始めない', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);

		await harness.manager.start(TAB_ID, { mediaId: media.id });
		await harness.manager.start(TAB_ID, { mediaId: media.id });

		expect(harness.started).toHaveLength(1);
		expect(harness.tasks).toHaveLength(1);
	});

	it('終わったメディアはもう一度保存できる', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });

		harness.setSnapshots([
			{ downloadId: 1, state: 'complete', bytesReceived: 100, totalBytes: 100 },
		]);
		await harness.manager.refresh();
		await harness.manager.start(TAB_ID, { mediaId: media.id });

		expect(harness.started).toHaveLength(2);
	});
});

describe('進捗の取り込み', () => {
	it('問い合わせた現況をタスクへ反映して通知する', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });
		harness.broadcasts.length = 0;

		harness.setSnapshots([
			{ downloadId: 1, state: 'in-progress', bytesReceived: 512, totalBytes: 1_024 },
		]);
		await harness.manager.refresh();

		expect(harness.tasks[0]).toMatchObject({ progress: 50, downloadedBytes: 512 });
		expect(harness.broadcasts).toHaveLength(1);
	});

	it('変化がなければ通知しない', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });

		harness.setSnapshots([
			{ downloadId: 1, state: 'in-progress', bytesReceived: 512, totalBytes: 1_024 },
		]);
		await harness.manager.refresh();
		harness.broadcasts.length = 0;
		await harness.manager.refresh();

		expect(harness.broadcasts).toHaveLength(0);
	});

	it('履歴から消されたダウンロードを進行中のまま残さない', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });

		// 問い合わせても返らない状態にする
		harness.setSnapshots([]);
		await harness.manager.refresh();

		expect(harness.tasks[0]).toMatchObject({
			status: 'failed',
			error: expect.stringContaining('取得できなくなりました'),
		});
	});

	it('依頼できないまま残ったタスクを一定時間で諦める', async () => {
		// 依頼の直前に Service Worker が停止すると browserDownloadId を持たない
		// タスクが残る。問い合わせ対象にならないので放置すると 0% で固まる
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		harness.failStart({ reason: 'unknown', detail: 'stopped' });
		await harness.manager.start(TAB_ID, { mediaId: media.id });
		harness.strandTask();

		harness.advance(60_000);
		await harness.manager.refresh();

		expect(harness.tasks[0]?.status).toBe('failed');
	});

	it('拡張機能と無関係なダウンロードの通知は無視する', async () => {
		const harness = createHarness();
		harness.setSnapshots([{ downloadId: 99, state: 'complete', bytesReceived: 1 }]);

		await harness.manager.handleBrowserChange(99);

		expect(harness.tasks).toHaveLength(0);
	});

	it('完了の通知で状態を完了にする', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });

		harness.setSnapshots([
			{ downloadId: 1, state: 'complete', bytesReceived: 1_024, totalBytes: 1_024 },
		]);
		await harness.manager.handleBrowserChange(1);

		expect(harness.tasks[0]).toMatchObject({ status: 'completed', progress: 100 });
	});
});

describe('cancel / retry', () => {
	it('進行中の取得を止めて状態を中止にする', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });

		const taskId = harness.tasks[0]?.id as string;
		await harness.manager.cancel(taskId);

		expect(harness.cancelled).toEqual([1]);
		expect(harness.tasks[0]?.status).toBe('cancelled');
	});

	it('終わったタスクは中止しない', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });
		const taskId = harness.tasks[0]?.id as string;
		await harness.manager.cancel(taskId);
		harness.cancelled.length = 0;

		await harness.manager.cancel(taskId);

		expect(harness.cancelled).toHaveLength(0);
	});

	it('中止したタスクをやり直せる', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });
		const taskId = harness.tasks[0]?.id as string;
		await harness.manager.cancel(taskId);

		await harness.manager.retry(taskId);

		expect(harness.started).toHaveLength(2);
		expect(harness.tasks).toHaveLength(1);
		expect(harness.tasks[0]).toMatchObject({ id: taskId, status: 'downloading' });
	});

	it('やり直し時にメディアが消えていたら理由を残す', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });
		const taskId = harness.tasks[0]?.id as string;
		await harness.manager.cancel(taskId);
		await harness.registry.clearTab(TAB_ID);

		await harness.manager.retry(taskId);

		expect(harness.started).toHaveLength(1);
		expect(harness.tasks[0]).toMatchObject({
			status: 'failed',
			error: expect.stringContaining('見つかりませんでした'),
		});
	});

	it('進行中のタスクはやり直さない', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });

		await harness.manager.retry(harness.tasks[0]?.id as string);

		expect(harness.started).toHaveLength(1);
	});
});

describe('タブ単位の扱い', () => {
	it('当該タブのタスクを新しい順で返す', async () => {
		const harness = createHarness();
		const first = await harness.detect(MP4_URL);
		const second = await harness.detect('https://cdn.example.com/other.mp4');

		await harness.manager.start(TAB_ID, { mediaId: first.id });
		await harness.manager.start(TAB_ID, { mediaId: second.id });

		const listed = await harness.manager.listByTab(TAB_ID);
		expect(listed.map((task) => task.mediaId)).toEqual([second.id, first.id]);
		expect(await harness.manager.listByTab(999)).toEqual([]);
	});

	it('タブを閉じたらそのタブのタスクを外す', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });

		await harness.manager.forgetTab(TAB_ID);

		expect(harness.tasks).toHaveLength(0);
		expect(harness.broadcasts.at(-1)).toEqual({ tabId: TAB_ID, tasks: [] });
	});

	it('関係のないタブを閉じても通知しない', async () => {
		const harness = createHarness();
		const media = await harness.detect(MP4_URL);
		await harness.manager.start(TAB_ID, { mediaId: media.id });
		harness.broadcasts.length = 0;

		await harness.manager.forgetTab(999);

		expect(harness.tasks).toHaveLength(1);
		expect(harness.broadcasts).toHaveLength(0);
	});
});
