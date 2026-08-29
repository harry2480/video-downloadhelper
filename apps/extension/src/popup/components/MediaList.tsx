import type { DetectedMedia, DownloadRequest, DownloadTask } from '../../shared/types';
import { MediaItem } from './MediaItem';

type Props = {
	media: DetectedMedia[];
	/** mediaId をキーにした最新のダウンロード状態 */
	tasks: Map<string, DownloadTask>;
	onDownload: (request: DownloadRequest) => void;
	onCancel: (taskId: string) => void;
	onRetry: (taskId: string) => void;
};

export function MediaList({ media, tasks, onDownload, onCancel, onRetry }: Props) {
	return (
		<ul aria-label="検出したメディア">
			{media.map((item) => (
				<MediaItem
					key={item.id}
					media={item}
					task={tasks.get(item.id)}
					onDownload={onDownload}
					onCancel={onCancel}
					onRetry={onRetry}
				/>
			))}
		</ul>
	);
}
