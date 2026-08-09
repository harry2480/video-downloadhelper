import type { DetectedMedia } from '../../shared/types';
import { MediaItem } from './MediaItem';

export function MediaList({ media }: { media: DetectedMedia[] }) {
	return (
		<ul aria-label="検出したメディア">
			{media.map((item) => (
				<MediaItem key={item.id} media={item} />
			))}
		</ul>
	);
}
