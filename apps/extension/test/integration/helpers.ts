import type { DetectedMedia, DownloadTask } from '../../src/shared/types';
import { type ExtensionContext, launchExtension } from '../e2e/fixtures';
import { type StaticServer, startStaticServer } from '../e2e/static-server';

export type Harness = ExtensionContext & { server: StaticServer };

export async function startHarness(): Promise<Harness> {
	const server = await startStaticServer();

	// 起動途中で失敗しても静的サーバーを閉じる。
	// 開いたままだとハンドルが残り、テストプロセスが終了しなくなる
	try {
		const extension = await launchExtension();
		const harness: Harness = { ...extension, server };

		try {
			await waitForExtensionReady(harness);
		} catch (error) {
			await extension.close();
			throw error;
		}

		return harness;
	} catch (error) {
		await server.close();
		throw error;
	}
}

/**
 * Service Worker が webRequest リスナーを登録し終えるまで待つ。
 *
 * Playwright の `serviceworker` イベントは worker の生成時点で発火し、
 * モジュールのトップレベルが実行し終わったことまでは保証しない。
 * この待機を省くと、最初のページ遷移で発生するリクエストを
 * 拡張機能が取りこぼし、テストが不安定になる。
 *
 * これは Manifest V3 の実挙動でもある（Service Worker の起動前に
 * 発生したリクエストは観測できない）。製品側は手動再スキャンで補う。
 */
async function waitForExtensionReady(harness: Harness): Promise<void> {
	const worker = harness.context.serviceWorkers()[0];
	if (!worker) throw new Error('service worker not found');

	const deadline = Date.now() + 15_000;
	for (;;) {
		const ready = await worker.evaluate(
			() =>
				chrome.webRequest.onHeadersReceived.hasListeners() &&
				chrome.webRequest.onBeforeRequest.hasListeners(),
		);
		if (ready) return;
		if (Date.now() > deadline) throw new Error('拡張機能の初期化がタイムアウトしました');
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

export async function stopHarness(harness: Harness | undefined): Promise<void> {
	if (!harness) return;

	// ブラウザの終了に失敗しても静的サーバーは必ず閉じる
	try {
		await harness.close();
	} finally {
		await harness.server.close();
	}
}

/**
 * Service Worker の中から `chrome.storage.session` を直接読む。
 *
 * 本番コードにテスト用の口を開けず、実際に保存された形を検証する。
 * ここで読めるということは、Service Worker が再起動しても復元できるということ。
 */
export async function readStoredMedia(
	harness: Harness,
	tabId: number,
): Promise<DetectedMedia[] | undefined> {
	const worker = harness.context.serviceWorkers()[0];
	if (!worker) throw new Error('service worker not found');

	return worker.evaluate(async (id) => {
		const key = `detected-media:${id}`;
		const stored = await chrome.storage.session.get(key);
		return stored[key] as unknown[] | undefined;
	}, tabId) as Promise<DetectedMedia[] | undefined>;
}

/** storage に保存されている全タブ分のキーを返す。 */
export async function listStoredKeys(harness: Harness): Promise<string[]> {
	const worker = harness.context.serviceWorkers()[0];
	if (!worker) throw new Error('service worker not found');

	return worker.evaluate(async () => {
		const all = await chrome.storage.session.get(null);
		return Object.keys(all).filter((key) => key.startsWith('detected-media:'));
	});
}

/** 拡張機能から見たタブ ID を取得する。Playwright の Page には存在しない概念のため。 */
export async function resolveTabId(harness: Harness, urlSubstring: string): Promise<number> {
	const worker = harness.context.serviceWorkers()[0];
	if (!worker) throw new Error('service worker not found');

	const tabId = await worker.evaluate(async (needle) => {
		const tabs = await chrome.tabs.query({});
		return tabs.find((tab) => tab.url?.includes(needle))?.id ?? -1;
	}, urlSubstring);

	if (tabId < 0) throw new Error(`タブが見つかりません: ${urlSubstring}`);
	return tabId;
}

/**
 * 条件が満たされるまで待つ。
 *
 * webRequest → storage 反映は非同期。固定の sleep で待つとテストが不安定になる。
 */
export async function waitFor<T>(
	produce: () => Promise<T>,
	predicate: (value: T) => boolean,
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		label?: string;
		/** タイムアウト時に添える診断情報。原因の切り分けに使う */
		diagnose?: () => Promise<unknown>;
	} = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 100;
	const deadline = Date.now() + timeoutMs;

	let last: T = await produce();
	while (!predicate(last)) {
		if (Date.now() > deadline) {
			const diagnosis = options.diagnose ? await options.diagnose() : undefined;
			throw new Error(
				[
					`待機がタイムアウトしました${options.label ? `: ${options.label}` : ''}`,
					`最後の値: ${JSON.stringify(last)}`,
					diagnosis === undefined ? '' : `診断: ${JSON.stringify(diagnosis, null, 2)}`,
				]
					.filter(Boolean)
					.join('\n'),
			);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		last = await produce();
	}

	return last;
}

/** タイムアウト時の切り分け用に、拡張機能から見える状態をまとめて取る。 */
export async function snapshot(harness: Harness): Promise<unknown> {
	const worker = harness.context.serviceWorkers()[0];
	if (!worker) return { error: 'service worker not found' };

	return worker.evaluate(async () => ({
		tabs: (await chrome.tabs.query({})).map((tab) => ({ id: tab.id, url: tab.url })),
		storage: await chrome.storage.session.get(null),
		listeners: {
			headersReceived: chrome.webRequest.onHeadersReceived.hasListeners(),
			beforeRequest: chrome.webRequest.onBeforeRequest.hasListeners(),
		},
	}));
}

/** ダウンロードタスクの保存状態を Service Worker の中から読む。 */
export async function readStoredTasks(harness: Harness): Promise<DownloadTask[] | undefined> {
	const worker = harness.context.serviceWorkers()[0];
	if (!worker) throw new Error('service worker not found');

	return worker.evaluate(async () => {
		const stored = await chrome.storage.session.get('download-tasks');
		return stored['download-tasks'] as unknown[] | undefined;
	}) as Promise<DownloadTask[] | undefined>;
}

export type DownloadItemSummary = {
	id: number;
	/** 保存先の絶対パス */
	filename: string;
	state: string;
	bytesReceived: number;
	totalBytes: number;
};

/**
 * ブラウザが持っているダウンロードの一覧。
 *
 * 拡張機能側の状態ではなく、実際に保存が行われたかを確かめるために使う。
 */
export async function searchDownloads(harness: Harness): Promise<DownloadItemSummary[]> {
	const worker = harness.context.serviceWorkers()[0];
	if (!worker) throw new Error('service worker not found');

	return worker.evaluate(async () => {
		const items = await chrome.downloads.search({});
		return items.map((item) => ({
			id: item.id,
			filename: item.filename,
			state: item.state,
			bytesReceived: item.bytesReceived,
			totalBytes: item.totalBytes,
		}));
	});
}
