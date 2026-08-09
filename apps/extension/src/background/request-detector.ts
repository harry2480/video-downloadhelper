import { isBlockedUrl } from '../media/blocklist';
import type { DetectionInput } from '../media/detected-media.model';
import { fireAndForget } from './fire-and-forget';
import type { MediaRegistry } from './media-registry';

/**
 * ネットワークリクエストの監視によるメディア検出（要件定義 2.2）。
 *
 * `chrome.webRequest` は Manifest V3 では **観測専用**。通信のブロック・改変は行わない。
 * レスポンスボディは読めない（`filterResponseData` は Firefox 専用）ため、
 * ここでは URL と Content-Type の取得までを担う。マニフェストの解析は
 * 検出した URL を拡張機能側で再フェッチして別途行う。
 */

/**
 * 監視するリソース種別。
 *
 * `<all_urls>` の全リクエストを見ると通常のブラウジングに影響するため絞る。
 * - media: `<video>` / `<audio>` が読む MP4 / WebM 等
 * - xmlhttprequest: hls.js / dash.js が読むマニフェストとセグメント
 * - other: fetch() 経由のマニフェスト等
 */
const OBSERVED_TYPES: `${chrome.webRequest.ResourceType}`[] = ['media', 'xmlhttprequest', 'other'];

function findHeader(
	headers: chrome.webRequest.HttpHeader[] | undefined,
	name: string,
): string | undefined {
	const lowered = name.toLowerCase();
	return headers?.find((header) => header.name.toLowerCase() === lowered)?.value;
}

function parseContentLength(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * リクエスト元タブのページ情報を取得する。
 *
 * `tabs` 権限は要求していないが、`<all_urls>` のホスト権限があれば
 * URL とタイトルを取得できる（要件定義 7 章）。
 */
async function resolvePageInfo(
	tabId: number,
): Promise<{ pageUrl: string; pageTitle?: string } | undefined> {
	try {
		const tab = await chrome.tabs.get(tabId);
		if (!tab.url) return undefined;
		return {
			pageUrl: tab.url,
			...(tab.title !== undefined && { pageTitle: tab.title }),
		};
	} catch {
		// タブが既に閉じられている
		return undefined;
	}
}

export function registerRequestDetector(registry: MediaRegistry): void {
	chrome.webRequest.onHeadersReceived.addListener(
		(details) => {
			// タブに紐づかないリクエスト（Service Worker 自身の再フェッチ等）は対象外
			if (details.tabId >= 0) {
				// 世代はイベントを受け取った時点で確定させる。
				// await をまたいでから取ると、通常遷移後の世代を拾ってしまう
				const generation = registry.currentGeneration(details.tabId);
				fireAndForget(handleResponse(registry, details, generation), 'メディア検出');
			}

			// 観測専用。通信のブロック・改変は行わないため常に undefined を返す
			return undefined;
		},
		{ urls: ['<all_urls>'], types: OBSERVED_TYPES },
		['responseHeaders'],
	);
}

async function handleResponse(
	registry: MediaRegistry,
	details: chrome.webRequest.OnHeadersReceivedDetails,
	generation: number,
): Promise<void> {
	// リダイレクトやエラーレスポンスを保存対象にしない
	if (details.statusCode < 200 || details.statusCode >= 300) return;

	const pageInfo = await resolvePageInfo(details.tabId);
	if (!pageInfo) return;

	// ブロックリスト対象サイトでは検出そのものを行わない（要件定義 2.1）
	if (isBlockedUrl(pageInfo.pageUrl)) return;

	const contentType = findHeader(details.responseHeaders, 'content-type');
	const contentLength = parseContentLength(findHeader(details.responseHeaders, 'content-length'));

	const input: DetectionInput = {
		tabId: details.tabId,
		pageUrl: pageInfo.pageUrl,
		...(pageInfo.pageTitle !== undefined && { pageTitle: pageInfo.pageTitle }),
		sourceUrl: details.url,
		detectedBy: 'network',
		detectedAt: details.timeStamp,
		...(contentType !== undefined && { contentType }),
		...(contentLength !== undefined && { estimatedSize: contentLength }),
	};

	await registry.register(input, generation);
}
