/**
 * セグメントの取得・結合の依頼先。
 *
 * Manifest V3 の Service Worker では `URL.createObjectURL` が使えず、
 * 長時間の取得も停止で中断される。実体は Offscreen Document が担う
 * （要件定義 2.6 / 2.7）。Background はこの interface だけを知る。
 */

export type AssemblyJob = {
	/** 進捗と結果を突き合わせるための ID。DownloadTask の ID を使う */
	taskId: string;
	/** Media Playlist の絶対 URL */
	playlistUrl: string;
	/** 合計サイズの上限（バイト） */
	maxBytes: number;
	/**
	 * プライベートネットワーク宛のセグメントを許すか。
	 *
	 * 検出元のメディア URL 自体がプライベートな場合にのみ真にする。
	 * ページが差し替えられない値（webRequest で観測した URL）を材料にする。
	 */
	allowPrivateHosts: boolean;
};

export type AssemblerPort = {
	/** 組み立てを依頼する。進捗と結果は通知として返る */
	start: (job: AssemblyJob) => Promise<void>;

	/** 進行中の組み立てを止める。すでに終わっていても失敗にしない */
	cancel: (taskId: string) => Promise<void>;

	/** オブジェクト URL を解放する。保存が終わった後に呼ぶ */
	release: (objectUrl: string) => Promise<void>;
};
