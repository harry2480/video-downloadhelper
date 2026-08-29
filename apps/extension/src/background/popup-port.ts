import { isBlockedUrl } from '../media/blocklist';
import {
	type BackgroundToContent,
	type BackgroundToPopup,
	POPUP_PORT_NAME,
	parsePopupMessage,
} from '../shared/messages';
import type { DetectedMedia, DownloadTask } from '../shared/types';
import type { DownloadManager } from './download-manager';
import { fireAndForget } from './fire-and-forget';
import type { ManifestResolver } from './manifest-resolver';
import type { MediaRegistry } from './media-registry';

/**
 * Popup への状態配信。
 *
 * **Popup は状態を所有しない**（要件定義 2.7）。ポップアップはいつ閉じられても
 * よい前提で、検出結果は Background が持つ。Popup は接続時に現在の状態を受け取り、
 * 以降は変化のたびに push を受ける。
 *
 * ポップアップは開いている間しか存在しないため、Port は 1 本かゼロ本。
 * それでも複数接続を許す形にしておく（開発時に複数ウィンドウで開くことがある）。
 */

/**
 * ダウンロード進捗を取り込む間隔（ms）。
 *
 * `chrome.downloads` は受信バイト数を通知しないため問い合わせる必要がある。
 * ポップアップが開いている間だけ回し、誰も見ていないときは止める（要件定義 2.7）。
 */
const PROGRESS_POLL_MS = 1_000;

type Subscriber = {
	port: chrome.runtime.Port;
	tabId: number;
};

const subscribers = new Set<Subscriber>();

async function resolveActiveTab(): Promise<chrome.tabs.Tab | undefined> {
	try {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		return tab;
	} catch {
		return undefined;
	}
}

function postMediaList(port: chrome.runtime.Port, media: DetectedMedia[], blocked: boolean): void {
	post(port, { kind: 'media-list', media, blocked });
}

function post(port: chrome.runtime.Port, message: BackgroundToPopup): void {
	try {
		port.postMessage(message);
	} catch {
		// ポップアップが閉じられた直後に起こる。切断は onDisconnect で処理する
	}
}

/** 検出結果が変わったタブを購読している Popup へ通知する。 */
export function broadcastToPopups(tabId: number, media: DetectedMedia[]): void {
	for (const subscriber of subscribers) {
		if (subscriber.tabId !== tabId) continue;
		postMediaList(subscriber.port, media, false);
	}
}

/** ダウンロード状態が変わったタブを購読している Popup へ通知する。 */
export function broadcastDownloads(tabId: number, tasks: DownloadTask[]): void {
	for (const subscriber of subscribers) {
		if (subscriber.tabId !== tabId) continue;
		post(subscriber.port, { kind: 'download-updated', tasks });
	}
}

export function registerPopupPort(
	registry: MediaRegistry,
	resolver: ManifestResolver,
	downloads: DownloadManager,
): void {
	chrome.runtime.onConnect.addListener((port) => {
		// 送信元を検証する。外部から接続できないようにするための防壁
		if (port.sender?.id !== chrome.runtime.id) {
			port.disconnect();
			return;
		}
		if (port.name !== POPUP_PORT_NAME) return;

		// **ポップアップの URL であることまで確かめる。** 拡張機能の ID を名乗れるのは
		// ポップアップだけではない（Content Script も同じ ID で届く）
		const senderUrl = port.sender?.url ?? '';
		if (!senderUrl.startsWith(chrome.runtime.getURL('src/popup/'))) {
			port.disconnect();
			return;
		}

		// **切断の購読は同期的に行う。** アクティブタブの解決を待つ間に
		// ポップアップが閉じられると、後から登録したリスナーはもう呼ばれず、
		// 進捗ポーリングを止められなくなる
		const connection: Connection = { port, closed: false };
		port.onDisconnect.addListener(() => {
			connection.closed = true;
			closeConnection(connection);
		});

		fireAndForget(
			attachSubscriber(registry, resolver, downloads, connection),
			'ポップアップへの状態配信',
		);
	});
}

/** 接続 1 本ぶんの後始末をまとめる。 */
type Connection = {
	port: chrome.runtime.Port;
	closed: boolean;
	subscriber?: Subscriber;
	poll?: ReturnType<typeof setInterval>;
};

function closeConnection(connection: Connection): void {
	if (connection.subscriber !== undefined) subscribers.delete(connection.subscriber);
	if (connection.poll !== undefined) clearInterval(connection.poll);
	connection.poll = undefined;
}

async function attachSubscriber(
	registry: MediaRegistry,
	resolver: ManifestResolver,
	downloads: DownloadManager,
	connection: Connection,
): Promise<void> {
	const port = connection.port;
	const tab = await resolveActiveTab();
	const tabId = tab?.id;

	// 解決を待つ間に閉じられていたら、購読もタイマーも作らない
	if (connection.closed) return;

	if (tabId === undefined || tabId < 0) {
		postMediaList(port, [], false);
		return;
	}

	const blocked = tab?.url !== undefined && isBlockedUrl(tab.url);
	const subscriber: Subscriber = { port, tabId };
	subscribers.add(subscriber);
	connection.subscriber = subscriber;

	// 進捗はポップアップが開いている間だけ取り込む
	connection.poll = setInterval(() => {
		fireAndForget(downloads.refresh(), 'ダウンロード進捗の取り込み');
	}, PROGRESS_POLL_MS);

	port.onMessage.addListener((raw: unknown) => {
		const message = parsePopupMessage(raw);
		if (message === undefined) return;

		// ブロック対象サイトでは何もしない（要件定義 2.4）。
		// 検出側でも遮っているが、起点ごとに判定しないと必ず漏れる
		if (blocked) return;

		if (message.kind === 'rescan') {
			fireAndForget(requestRescan(tabId), '再スキャンの要求');

			// 明示的な再試行。取得に失敗していた項目をもう一度取りに行く
			resolver.resetFailures(tabId);
			fireAndForget(resolvePending(registry, resolver, tabId), 'マニフェストの解析');
			return;
		}

		if (message.kind === 'start-download') {
			fireAndForget(downloads.start(tabId, message.request), 'ダウンロードの開始');
			return;
		}

		if (message.kind === 'cancel-download') {
			fireAndForget(downloads.cancel(message.taskId), 'ダウンロードの中止');
			return;
		}

		fireAndForget(downloads.retry(message.taskId), 'ダウンロードの再試行');
	});

	if (blocked) {
		postMediaList(port, [], true);
		return;
	}

	// 世代は一覧を読む前に取る。読んでいる間に遷移すると、旧ページの検出結果を
	// 遷移後の世代で解析してしまう
	const generation = registry.currentGeneration(tabId);
	const media = await registry.list(tabId);
	postMediaList(port, media, false);

	// **ここが Service Worker 再起動後の唯一の再開契機になる。**
	// 解析は検出結果の変化からしか始まらないが、読み込みの終わったページでは
	// もうメディアリクエストが起きない。ポップアップを開いた時点で拾い直さないと
	// 「画質を確認しています…」のまま止まる
	fireAndForget(resolver.resolvePending(tabId, media, generation), 'マニフェストの解析');

	// 進行中の取得は Service Worker の停止をまたいで続く。開いた時点の状態を渡す
	post(port, { kind: 'download-updated', tasks: await downloads.listByTab(tabId) });
	fireAndForget(downloads.refresh(), 'ダウンロード進捗の取り込み');
}

/** 現在の検出結果のうち未解析の HLS を解析する。 */
async function resolvePending(
	registry: MediaRegistry,
	resolver: ManifestResolver,
	tabId: number,
): Promise<void> {
	const generation = registry.currentGeneration(tabId);
	await resolver.resolvePending(tabId, await registry.list(tabId), generation);
}

/**
 * Content Script へ再走査を要求する（要件定義 2.5 の更新ボタン）。
 *
 * Service Worker の起動前に発生したリクエストは観測できないため、
 * ユーザーが明示的にやり直せる経路を用意している。
 */
async function requestRescan(tabId: number): Promise<void> {
	const message: BackgroundToContent = { kind: 'rescan' };
	try {
		await chrome.tabs.sendMessage(tabId, message);
	} catch {
		// Content Script が注入されていないページ（chrome:// 等）では失敗する
	}
}
