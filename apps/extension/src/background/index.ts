/**
 * Background Service Worker のエントリ兼 Composition Root。
 *
 * Service Worker は常駐を保証されない。長時間処理をここに置かず、
 * Offscreen Document へ委譲すること（docs/アーキテクチャ.md 参照）。
 */

chrome.runtime.onInstalled.addListener(() => {
	console.info('[vdh] service worker installed');
});

// 拡張機能内部メッセージは必ず送信元を検証する。
// 外部ページから任意の処理を呼び出せないようにするための最初の防壁。
chrome.runtime.onMessage.addListener((_message, sender) => {
	if (sender.id !== chrome.runtime.id) return false;
	return false;
});
