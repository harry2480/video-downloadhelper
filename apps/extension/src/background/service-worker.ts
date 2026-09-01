import { parseOffscreenMessage } from '../shared/messages';
import { createDetectedMediaRepository } from '../shared/storage/detected-media.repository';
import { createDownloadTaskRepository } from '../shared/storage/download-task.repository';
import { updateBadge } from './badge';
import { createDownloader } from './download.adapter';
import { DownloadManager } from './download-manager';
import { fireAndForget } from './fire-and-forget';
import { ManifestResolver } from './manifest-resolver';
import { createMediaFetcher } from './media-fetcher.adapter';
import { MediaRegistry } from './media-registry';
import { registerMessageHandler } from './message-handler';
import { createOffscreenHost } from './offscreen-host';
import { broadcastDownloads, broadcastToPopups, registerPopupPort } from './popup-port';
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
const downloader = createDownloader();
const assembler = createOffscreenHost();
const downloadTasks = createDownloadTaskRepository();

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
const downloads = new DownloadManager(
	downloader,
	assembler,
	downloadTasks,
	registry,
	broadcastDownloads,
);

// ブラウザ側の完了・中断はポップアップが閉じていても届く。
// 進捗（受信バイト数）は通知されないため、ポップアップ接続中のみ問い合わせる
downloader.subscribe((downloadId) => {
	fireAndForget(downloads.handleBrowserChange(downloadId), 'ダウンロード状態の取り込み');
});

// Offscreen Document からの進捗・結果。送信元を検証してから取り込む
chrome.runtime.onMessage.addListener((raw, sender) => {
	if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;

	const message = parseOffscreenMessage(raw);
	if (message === undefined) return false;

	if (message.kind === 'assembly-progress') {
		fireAndForget(
			downloads.handleAssemblyProgress(
				message.taskId,
				message.completed,
				message.total,
				message.bytes,
			),
			'組み立ての進捗の取り込み',
		);
		return false;
	}

	if (message.kind === 'assembly-done') {
		fireAndForget(
			downloads.handleAssemblyDone(
				message.taskId,
				message.objectUrl,
				message.bytes,
				message.container,
			),
			'組み立て結果の保存',
		);
		return false;
	}

	fireAndForget(
		downloads.handleAssemblyFailed(message.taskId, message.reason),
		'組み立ての失敗の記録',
	);
	return false;
});

registerRequestDetector(registry);
registerTabLifecycle(registry, downloads);
registerMessageHandler(registry);
registerPopupPort(registry, resolver, downloads);
