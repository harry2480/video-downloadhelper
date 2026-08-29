import type { Result } from '../utils';

/**
 * ブラウザのダウンロード機能。
 *
 * 直接保存できるメディアは `chrome.downloads` に任せる（要件定義 2.6）。
 * 実装は実行コンテキスト層が注入する。コアロジック層はこの interface だけを知る。
 */

export type DownloadStartFailure =
	/** ファイル名が受け付けられなかった */
	| { reason: 'invalid-filename' }
	/** 拡張機能の権限・ブラウザ設定で拒否された */
	| { reason: 'denied' }
	/** それ以外。ブラウザからの文字列をそのまま持つ */
	| { reason: 'unknown'; detail: string };

/**
 * ブラウザ側のダウンロードの現況。
 *
 * `chrome.downloads.onChanged` は受信バイト数を通知しないため、
 * 進捗は問い合わせで取る。
 */
export type DownloadSnapshot = {
	downloadId: number;
	state: 'in-progress' | 'complete' | 'interrupted';
	bytesReceived: number;
	/** 不明な場合は `undefined`。Content-Length を返さないサーバーがある */
	totalBytes?: number;
	/** 中断の理由。`chrome.downloads` の InterruptReason をそのまま持つ */
	interruptReason?: string;
};

export type DownloaderPort = {
	/** 保存を開始し、ブラウザのダウンロード ID を返す */
	start: (request: { url: string; filename: string }) => Promise<
		Result<number, DownloadStartFailure>
	>;

	/** 進行中のダウンロードを止める。すでに終わっていても失敗にしない */
	cancel: (downloadId: number) => Promise<void>;

	/** 現況を問い合わせる。見つからない ID は結果に含めない */
	query: (downloadIds: readonly number[]) => Promise<DownloadSnapshot[]>;

	/**
	 * 状態の変化を購読する。通知されるのは ID のみで、詳細は `query` で取る。
	 * **リスナー登録はモジュールのトップレベルで同期的に行うこと**（SW 再起動対策）。
	 */
	subscribe: (listener: (downloadId: number) => void) => void;
};
