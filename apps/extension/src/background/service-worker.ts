import { createDetectedMediaRepository } from '../shared/storage/detected-media.repository';
import { updateBadge } from './badge';
import { fireAndForget } from './fire-and-forget';
import { ManifestResolver } from './manifest-resolver';
import { createMediaFetcher } from './media-fetcher.adapter';
import { MediaRegistry } from './media-registry';
import { registerMessageHandler } from './message-handler';
import { broadcastToPopups, registerPopupPort } from './popup-port';
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
const fetcher = createMediaFetcher();

// ManifestResolver は registry を必要とし、registry の通知は resolver を呼ぶ。
// コールバックは両方の生成後にしか実行されないため、クロージャ経由で参照してよい
const registry = new MediaRegistry(repository, (tabId, media) => {
	void updateBadge(tabId, media.length);
	broadcastToPopups(tabId, media);

	if (media.length === 0) {
		// ページ遷移・タブ破棄。開き直したときに再解析できるよう抑止を解く
		resolver.forgetTab(tabId);
		return;
	}

	fireAndForget(
		resolver.resolvePending(tabId, media, registry.currentGeneration(tabId)),
		'マニフェストの解析',
	);
});

const resolver = new ManifestResolver(fetcher, registry);

registerRequestDetector(registry);
registerTabLifecycle(registry);
registerMessageHandler(registry);
registerPopupPort(registry);
