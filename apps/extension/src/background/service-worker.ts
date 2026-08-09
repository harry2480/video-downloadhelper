import { createDetectedMediaRepository } from '../shared/storage/detected-media.repository';
import { updateBadge } from './badge';
import { MediaRegistry } from './media-registry';
import { registerRequestDetector } from './request-detector';
import { registerTabLifecycle } from './tab-manager';

/**
 * Background Service Worker のエントリ兼 Composition Root。
 *
 * **Service Worker は常駐を保証されない。**
 * 状態は Repository（chrome.storage.session）が持ち、ここでは保持しない。
 * リスナー登録はモジュールのトップレベルで同期的に行うこと。
 * 非同期処理の中で登録すると、SW 再起動時にイベントを取りこぼす。
 *
 * 長時間処理（セグメント取得・結合）はここに置かず Offscreen Document へ委譲する。
 */

const repository = createDetectedMediaRepository();

const registry = new MediaRegistry(repository, (tabId, media) => {
	void updateBadge(tabId, media.length);
});

registerRequestDetector(registry);
registerTabLifecycle(registry);

// 拡張機能内部メッセージは必ず送信元を検証する。
// 外部ページから任意の処理を呼び出せないようにするための最初の防壁。
chrome.runtime.onMessage.addListener((_message, sender) => {
	if (sender.id !== chrome.runtime.id) return false;
	return false;
});
