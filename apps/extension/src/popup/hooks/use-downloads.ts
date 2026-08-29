import { useCallback, useEffect, useState } from 'react';
import type { DownloadRequest, DownloadTask } from '../../shared/types';
import type { PopupPort } from './use-popup-port';

/**
 * Background が所有するダウンロード状態を購読する。
 *
 * **楽観的更新をしない**（docs/フロントエンド規約.md）。開始・中止・再試行は
 * 要求を送るだけで、描画は Background から返る `download-updated` に従う。
 * ポップアップは閉じられても取得は続くため、表示だけ先に進めると実態とずれる。
 */

type DownloadsState = {
	/** mediaId をキーにした最新のタスク。1 メディアにつき最新の 1 件を引ける */
	tasksByMedia: Map<string, DownloadTask>;
	start: (request: DownloadRequest) => void;
	cancel: (taskId: string) => void;
	retry: (taskId: string) => void;
};

function indexByMedia(tasks: DownloadTask[]): Map<string, DownloadTask> {
	const byMedia = new Map<string, DownloadTask>();

	// Background は新しい順で送る。同じメディアの古いタスクで上書きしない
	for (const task of tasks) {
		if (byMedia.has(task.mediaId)) continue;
		byMedia.set(task.mediaId, task);
	}

	return byMedia;
}

export function useDownloads(port: PopupPort): DownloadsState {
	const [tasksByMedia, setTasksByMedia] = useState<Map<string, DownloadTask>>(new Map());

	useEffect(
		() =>
			port.subscribe((message) => {
				if (message.kind !== 'download-updated') return;
				setTasksByMedia(indexByMedia(message.tasks));
			}),
		[port],
	);

	const start = useCallback(
		(request: DownloadRequest) => port.send({ kind: 'start-download', request }),
		[port],
	);

	const cancel = useCallback(
		(taskId: string) => port.send({ kind: 'cancel-download', taskId }),
		[port],
	);

	const retry = useCallback(
		(taskId: string) => port.send({ kind: 'retry-download', taskId }),
		[port],
	);

	return { tasksByMedia, start, cancel, retry };
}
