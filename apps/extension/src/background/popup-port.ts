import { isBlockedUrl } from '../media/blocklist';
import {
	type BackgroundToContent,
	type BackgroundToPopup,
	POPUP_PORT_NAME,
	type PopupToBackground,
} from '../shared/messages';
import type { DetectedMedia } from '../shared/types';
import { fireAndForget } from './fire-and-forget';
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
	const message: BackgroundToPopup = { kind: 'media-list', media, blocked };
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

export function registerPopupPort(registry: MediaRegistry): void {
	chrome.runtime.onConnect.addListener((port) => {
		// 送信元を検証する。外部から接続できないようにするための防壁
		if (port.sender?.id !== chrome.runtime.id) {
			port.disconnect();
			return;
		}
		if (port.name !== POPUP_PORT_NAME) return;

		fireAndForget(attachSubscriber(registry, port), 'ポップアップへの状態配信');
	});
}

async function attachSubscriber(registry: MediaRegistry, port: chrome.runtime.Port): Promise<void> {
	const tab = await resolveActiveTab();
	const tabId = tab?.id;

	if (tabId === undefined || tabId < 0) {
		postMediaList(port, [], false);
		return;
	}

	const blocked = tab?.url !== undefined && isBlockedUrl(tab.url);
	const subscriber: Subscriber = { port, tabId };
	subscribers.add(subscriber);

	port.onDisconnect.addListener(() => {
		subscribers.delete(subscriber);
	});

	port.onMessage.addListener((message: PopupToBackground) => {
		if (message?.kind !== 'rescan') return;
		fireAndForget(requestRescan(tabId), '再スキャンの要求');
	});

	postMediaList(port, blocked ? [] : await registry.list(tabId), blocked);
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
