import type { MediaRegistry } from './media-registry';

/**
 * 検出結果のライフサイクル管理（要件定義 2.2 の検出結果リセット規則）。
 *
 * - メインフレームのページ遷移時: 当該タブの検出結果をクリアする
 * - History API 等による SPA 内遷移: 検出結果を維持しつつ継続監視する
 * - タブを閉じた場合: 破棄する
 *
 * **メインフレーム遷移の検知に webRequest を使う。**
 * History API による遷移は main_frame リクエストを発生させないため、
 * この方式なら SPA 内遷移で検出結果が消えない。`webNavigation` 権限を
 * 追加せずに規則をそのまま表現できる。
 */
export function registerTabLifecycle(registry: MediaRegistry): void {
	chrome.webRequest.onBeforeRequest.addListener(
		(details) => {
			if (details.tabId >= 0) void registry.clearTab(details.tabId);

			// 観測専用。通信のブロック・改変は行わないため常に undefined を返す
			return undefined;
		},
		{ urls: ['<all_urls>'], types: ['main_frame'] },
	);

	chrome.tabs.onRemoved.addListener((tabId) => {
		void registry.clearTab(tabId);
	});

	// タブが破棄され別プロセスで復元された場合、旧 tabId の結果は不要になる
	chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
		void registry.clearTab(removedTabId);
		void registry.clearTab(addedTabId);
	});
}
