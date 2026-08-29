import { isDownloadable, isPendingSupport } from '../../media/downloadable';
import { formatBytes } from '../../media/format';
import type { DetectedMedia, DownloadRequest, DownloadTask } from '../../shared/types';
import { Button } from './ui/Button';
import { ProgressBar } from './ui/ProgressBar';

/**
 * メディア 1 件分のダウンロード操作と状態表示（要件定義 2.5 / 2.6）。
 *
 * 状態は Background が持つ。ここは受け取った `task` を描画し、
 * 操作は上位から渡されたハンドラへ流すだけにする。
 */

type Props = {
	media: DetectedMedia;
	variantId: string | undefined;
	task: DownloadTask | undefined;
	onDownload: (request: DownloadRequest) => void;
	onCancel: (taskId: string) => void;
	onRetry: (taskId: string) => void;
};

/** 取得中に出す進捗の説明。総バイト数を返さないサーバーがあるため分岐する。 */
function progressLabel(task: DownloadTask): string {
	const received = formatBytes(task.downloadedBytes);
	const total = formatBytes(task.totalBytes);

	if (received !== undefined && total !== undefined) {
		return `${task.progress}%（${received} / ${total}）`;
	}
	if (received !== undefined) return `${received} 取得済み`;
	return '取得中…';
}

export function DownloadControl({ media, variantId, task, onDownload, onCancel, onRetry }: Props) {
	// まだ対応していない形式は、押せるのに保存できないボタンを出さずに理由を書く
	if (isPendingSupport(media)) {
		return <p className="text-muted text-xs">この形式の保存は準備中です</p>;
	}

	// DRM・対応外の理由・保存できない URL は MediaItem 側で表示済み。操作は出さない
	if (!isDownloadable(media)) return null;

	if (
		task?.status === 'queued' ||
		task?.status === 'downloading' ||
		task?.status === 'processing'
	) {
		return (
			<div className="flex flex-col gap-1">
				<ProgressBar value={task.progress} label="ダウンロードの進捗" />
				<div className="flex items-center justify-between gap-2">
					<span className="text-muted text-xs">{progressLabel(task)}</span>
					<Button variant="ghost" onClick={() => onCancel(task.id)}>
						中止
					</Button>
				</div>
			</div>
		);
	}

	if (task?.status === 'completed') {
		return (
			<div className="flex items-center justify-between gap-2">
				<span className="text-muted text-xs">保存しました</span>
				<Button variant="ghost" onClick={() => onRetry(task.id)}>
					もう一度保存
				</Button>
			</div>
		);
	}

	if (task?.status === 'failed' || task?.status === 'cancelled') {
		return (
			<div className="flex items-center justify-between gap-2">
				<span className="text-danger text-xs">
					{task.status === 'cancelled'
						? 'ダウンロードを中止しました'
						: (task.error ?? 'ダウンロードに失敗しました')}
				</span>
				<Button variant="ghost" onClick={() => onRetry(task.id)}>
					再試行
				</Button>
			</div>
		);
	}

	return (
		<div>
			<Button
				onClick={() =>
					onDownload({ mediaId: media.id, ...(variantId !== undefined && { variantId }) })
				}
			>
				保存
			</Button>
		</div>
	);
}
