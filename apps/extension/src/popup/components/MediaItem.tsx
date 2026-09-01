import { useId, useState } from 'react';
import {
	formatHost,
	formatMediaType,
	formatSummary,
	formatTitle,
	formatUnsupportedReason,
	formatUrlForDisplay,
} from '../../media/format';
import { resolveSelectedVariant, variantKey } from '../../media/variant-selection';
import type { DetectedMedia, DownloadRequest, DownloadTask } from '../../shared/types';
import { DownloadControl } from './DownloadControl';
import { QualitySelector } from './QualitySelector';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';

/**
 * 検出メディア 1 件の表示（要件定義 4.3）。
 *
 * 表示する文字列はすべてページ由来の信頼できない入力。
 * `dangerouslySetInnerHTML` を使わず、折り返しを必ず指定する。
 */
type Props = {
	media: DetectedMedia;
	task: DownloadTask | undefined;
	onDownload: (request: DownloadRequest) => void;
	onCancel: (taskId: string) => void;
	onRetry: (taskId: string) => void;
};

export function MediaItem({ media, task, onDownload, onCancel, onRetry }: Props) {
	const [isDetailOpen, setIsDetailOpen] = useState(false);
	const detailId = useId();

	const variants = media.variants ?? [];
	// **id ではなく品質そのものを覚える。** id は再解析で振り直され、
	// 別の品質を指しうる（media/variant-selection.ts）。
	// 未選択なら既定で最高品質。variants は解析時に高画質順へ並べてある
	const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
	const selectedVariant = resolveSelectedVariant(variants, selectedKey);

	const title = formatTitle(media);
	const host = formatHost(media.sourceUrl);
	const summary = formatSummary(media);
	const unsupportedReason = formatUnsupportedReason(media);

	return (
		<li className="border-border border-b px-4 py-3 last:border-b-0">
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex items-start justify-between gap-2">
					<span className="min-w-0 flex-1 truncate font-medium text-sm" title={title}>
						{title}
					</span>
					<Badge tone={media.drm ? 'danger' : 'neutral'}>{formatMediaType(media.type)}</Badge>
				</div>

				{host !== undefined && <span className="truncate text-muted text-xs">{host}</span>}
				{summary.length > 0 && <span className="text-muted text-xs">{summary}</span>}

				{unsupportedReason !== undefined && (
					<p className="text-danger text-xs">{unsupportedReason}</p>
				)}

				{media.type === 'hls' &&
					media.manifestResolved !== true &&
					unsupportedReason === undefined && (
						<p className="text-muted text-xs">画質を確認しています…</p>
					)}

				{variants.length > 1 && selectedVariant !== undefined && (
					<QualitySelector
						variants={variants}
						selectedId={selectedVariant.id}
						onSelect={(variant) => setSelectedKey(variantKey(variant))}
					/>
				)}

				<div className="mt-1">
					<DownloadControl
						media={media}
						variant={selectedVariant}
						task={task}
						onDownload={onDownload}
						onCancel={onCancel}
						onRetry={onRetry}
					/>
				</div>

				<div className="mt-1 flex gap-2">
					<Button
						variant="ghost"
						aria-expanded={isDetailOpen}
						aria-controls={detailId}
						onClick={() => setIsDetailOpen((open) => !open)}
					>
						{isDetailOpen ? '詳細を隠す' : '詳細'}
					</Button>
				</div>

				{isDetailOpen && (
					<dl id={detailId} className="mt-2 flex flex-col gap-1 text-xs">
						<div>
							<dt className="text-muted">URL</dt>
							<dd className="break-all">{formatUrlForDisplay(media.sourceUrl)}</dd>
						</div>
						{media.mimeType !== undefined && (
							<div>
								<dt className="text-muted">Content-Type</dt>
								<dd className="break-all">{media.mimeType}</dd>
							</div>
						)}
						<div>
							<dt className="text-muted">検出方式</dt>
							<dd>{media.detectedBy}</dd>
						</div>
					</dl>
				)}
			</div>
		</li>
	);
}
