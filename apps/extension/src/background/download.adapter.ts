import type { DownloadSnapshot, DownloaderPort } from '../shared/ports/download.port';
import { err, ok } from '../shared/utils';

/**
 * `chrome.downloads` による DownloaderPort の実装（要件定義 2.6）。
 *
 * 保存先はブラウザ標準のダウンロード設定に従う。保存ダイアログは出さない
 * （ワンクリック保存。要件定義 2.5）。
 */

/** ファイル名が拒否されたときにブラウザが返すメッセージの断片。 */
const FILENAME_ERROR = 'filename';

function toSnapshot(item: chrome.downloads.DownloadItem): DownloadSnapshot {
	// totalBytes は不明なとき 0 が入る。0 のまま進捗率を出すと常に 0% になるため、
	// 「分からない」として扱えるよう undefined へ倒す
	const totalBytes = item.totalBytes > 0 ? item.totalBytes : undefined;

	return {
		downloadId: item.id,
		state:
			item.state === 'complete'
				? 'complete'
				: item.state === 'interrupted'
					? 'interrupted'
					: 'in-progress',
		bytesReceived: item.bytesReceived,
		...(totalBytes !== undefined && { totalBytes }),
		...(item.error !== undefined && { interruptReason: item.error }),
	};
}

export function createDownloader(): DownloaderPort {
	return {
		async start({ url, filename }) {
			try {
				const downloadId = await chrome.downloads.download({
					url,
					filename,
					// 同名ファイルがあれば連番を振る。既存ファイルを黙って上書きしない
					conflictAction: 'uniquify',
					saveAs: false,
				});

				// 開始できなかった場合 undefined が返り、詳細は lastError にだけ載る
				if (downloadId === undefined) {
					const detail = chrome.runtime.lastError?.message ?? '';
					return err(
						detail.includes(FILENAME_ERROR) ? { reason: 'invalid-filename' } : { reason: 'denied' },
					);
				}

				return ok(downloadId);
			} catch (error) {
				const detail = String(error);
				if (detail.includes(FILENAME_ERROR)) return err({ reason: 'invalid-filename' });
				return err({ reason: 'unknown', detail });
			}
		},

		async cancel(downloadId) {
			try {
				await chrome.downloads.cancel(downloadId);
			} catch {
				// すでに完了・中断している場合に投げる。キャンセルの意図は満たされている
			}
		},

		async query(downloadIds) {
			const snapshots: DownloadSnapshot[] = [];

			for (const id of downloadIds) {
				try {
					const [item] = await chrome.downloads.search({ id });
					if (item !== undefined) snapshots.push(toSnapshot(item));
				} catch {
					// 履歴から消された ID。結果に含めない
				}
			}

			return snapshots;
		},

		subscribe(listener) {
			chrome.downloads.onChanged.addListener((delta) => {
				listener(delta.id);
			});
		},
	};
}
