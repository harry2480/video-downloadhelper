import { MediaList } from './components/MediaList';
import { type Status, StatusMessage } from './components/StatusMessage';
import { Button } from './components/ui/Button';
import { useDownloads } from './hooks/use-downloads';
import { useMediaList } from './hooks/use-media-list';
import { type PortFactory, usePopupPort } from './hooks/use-popup-port';

/**
 * ポップアップの寸法はビューポート単位ではなく固定 px で指定する。
 * スクロールはルートではなく一覧領域の内側に持たせる（docs/スタイルガイド.md 参照）。
 */
export function App({ portFactory }: { portFactory?: PortFactory }) {
	const port = usePopupPort(portFactory);
	const { media, isLoading, isBlocked, rescan } = useMediaList(port);
	const { tasksByMedia, start, cancel, retry } = useDownloads(port);

	const status: Status | undefined = isBlocked
		? 'blocked'
		: isLoading
			? 'detecting'
			: media.length === 0
				? 'empty'
				: undefined;

	return (
		<div className="flex max-h-[600px] w-[420px] flex-col bg-surface text-foreground">
			<header className="flex items-center justify-between gap-2 border-border border-b px-4 py-3">
				<h1 className="font-medium text-sm">Video Download Helper</h1>
				<div className="flex items-center gap-2">
					{!isLoading && !isBlocked && (
						<span className="text-muted text-xs">{media.length} 件</span>
					)}
					<Button variant="ghost" onClick={rescan} disabled={isBlocked} aria-label="再スキャン">
						更新
					</Button>
				</div>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{status === undefined ? (
					<MediaList
						media={media}
						tasks={tasksByMedia}
						onDownload={start}
						onCancel={cancel}
						onRetry={retry}
					/>
				) : (
					<StatusMessage status={status} />
				)}
			</div>
		</div>
	);
}
