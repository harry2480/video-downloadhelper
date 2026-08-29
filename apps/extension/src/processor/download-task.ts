import type { DownloadSnapshot } from '../shared/ports/download.port';
import type { DownloadTask } from '../shared/types';

/**
 * ダウンロードタスクの状態遷移（要件定義 5.4）。
 *
 * 副作用を持たない。ブラウザへの問い合わせ・保存は実行コンテキスト層が行い、
 * ここでは「現況をタスクへどう反映するか」だけを決める。
 */

/** 中断理由ごとのユーザー向け文言。ブラウザの InterruptReason に対応する。 */
const INTERRUPT_MESSAGES: Record<string, string> = {
	SERVER_FORBIDDEN: 'サーバーに拒否されました（認証や有効期限が原因の可能性があります）',
	SERVER_UNAUTHORIZED: 'サーバーに拒否されました（認証や有効期限が原因の可能性があります）',
	SERVER_BAD_CONTENT: 'サーバーからファイルを取得できませんでした',
	SERVER_FAILED: 'サーバーからファイルを取得できませんでした',
	SERVER_NO_RANGE: 'サーバーからファイルを取得できませんでした',
	SERVER_CERT_PROBLEM: 'サーバーの証明書に問題があります',
	NETWORK_FAILED: '通信に失敗しました',
	NETWORK_TIMEOUT: '通信がタイムアウトしました',
	NETWORK_DISCONNECTED: 'ネットワークが切断されました',
	NETWORK_SERVER_DOWN: 'サーバーへ接続できませんでした',
	FILE_FAILED: 'ファイルを保存できませんでした',
	FILE_ACCESS_DENIED: '保存先へのアクセスが拒否されました',
	FILE_NO_SPACE: 'ディスクの空き容量が足りません',
	FILE_NAME_TOO_LONG: 'ファイル名が長すぎます',
	FILE_TOO_LARGE: 'ファイルが大きすぎます',
	FILE_VIRUS_INFECTED: 'ウイルス検査で保存が中止されました',
	FILE_BLOCKED: 'ブラウザの設定により保存がブロックされました',
	USER_SHUTDOWN: 'ブラウザの終了により中断されました',
	CRASH: 'ブラウザの異常終了により中断されました',
};

/** ユーザーによる中止。失敗ではなくキャンセルとして扱う。 */
const USER_CANCELED = 'USER_CANCELED';

/**
 * 中断理由をユーザー向けの文言にする。
 *
 * **ブラウザから来た文字列をそのまま出さない。** 未知の理由は一般的な文言へ倒す。
 */
export function describeInterruptReason(reason: string | undefined): string {
	if (reason === undefined) return 'ダウンロードが中断されました';
	return INTERRUPT_MESSAGES[reason] ?? 'ダウンロードが中断されました';
}

/**
 * 進捗率（0〜100）。
 *
 * 総バイト数が分からないサーバーがあるため、その場合は 0 のままにする。
 * 「進んでいるように見えて実は分からない」より、分からないことを示す方がよい。
 */
export function toProgress(bytesReceived: number, totalBytes: number | undefined): number {
	if (totalBytes === undefined || totalBytes <= 0) return 0;
	if (bytesReceived <= 0) return 0;

	const ratio = (bytesReceived / totalBytes) * 100;
	return Math.min(100, Math.round(ratio));
}

/**
 * ブラウザ側の現況をタスクへ反映する。
 *
 * 終了済みのタスクは動かさない。完了したダウンロードの ID が再利用された場合に
 * 状態が巻き戻るのを防ぐ。
 */
export function applyDownloadSnapshot(
	task: DownloadTask,
	snapshot: DownloadSnapshot,
): DownloadTask {
	if (isFinished(task)) return task;

	const next: DownloadTask = {
		...task,
		downloadedBytes: snapshot.bytesReceived,
		...(snapshot.totalBytes !== undefined && { totalBytes: snapshot.totalBytes }),
	};

	if (snapshot.state === 'complete') {
		return { ...next, status: 'completed', progress: 100 };
	}

	if (snapshot.state === 'interrupted') {
		if (snapshot.interruptReason === USER_CANCELED) {
			return { ...next, status: 'cancelled' };
		}
		return {
			...next,
			status: 'failed',
			error: describeInterruptReason(snapshot.interruptReason),
		};
	}

	return {
		...next,
		status: 'downloading',
		progress: toProgress(snapshot.bytesReceived, snapshot.totalBytes ?? task.totalBytes),
	};
}

/** 失敗として確定させる。理由は呼び出し側がユーザー向けの文言にしてから渡す。 */
export function markDownloadFailed(task: DownloadTask, error: string): DownloadTask {
	return { ...task, status: 'failed', error };
}

/** ユーザーによる中止。 */
export function markDownloadCancelled(task: DownloadTask): DownloadTask {
	return { ...task, status: 'cancelled' };
}

/**
 * 再試行のために開始前の状態へ戻す。ファイル名と選択品質は引き継ぐ。
 *
 * **総バイト数とオブジェクト URL も落とす。** 総バイト数を残すと、再試行先が
 * Content-Length を返さない場合に前回の総量で割った進捗が出る。オブジェクト
 * URL を残すと、解放済みの URL に対してもう一度解放を要求してしまう。
 */
export function resetDownloadTask(task: DownloadTask, startedAt: number): DownloadTask {
	const {
		error: _error,
		browserDownloadId: _id,
		downloadedBytes: _bytes,
		totalBytes: _total,
		objectUrl: _objectUrl,
		...rest
	} = task;
	return { ...rest, status: 'queued', progress: 0, startedAt };
}

/** 終了して動かなくなった状態か。 */
export function isFinished(task: DownloadTask): boolean {
	return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
}

/** 進行中の状態か。再試行やキャンセルの可否判定に使う。 */
export function isActive(task: DownloadTask): boolean {
	return !isFinished(task);
}
