import { useId } from 'react';
import { formatBitrate, formatBytes, formatResolution } from '../../media/format';
import type { MediaVariant } from '../../shared/types';

/**
 * HLS / DASH の品質選択（要件定義 4.4）。
 *
 * ネイティブの radiogroup セマンティクスを使う。キーボードだけで
 * 選択できることが要件（2.5 アクセシビリティ）。
 */

function variantLabel(variant: MediaVariant): string {
	const parts = [
		formatResolution(variant.width, variant.height) ?? '解像度不明',
		formatBitrate(variant.bandwidth),
		formatBytes(variant.estimatedSize),
	];
	return parts.filter((part): part is string => part !== undefined).join('  ');
}

export function QualitySelector({
	variants,
	selectedId,
	onSelect,
}: {
	variants: MediaVariant[];
	selectedId: string;
	/** 選ばれた variant を丸ごと返す。id は再解析で振り直されるため上位で覚えない */
	onSelect: (variant: MediaVariant) => void;
}) {
	const groupName = useId();

	return (
		<fieldset className="mt-2 flex flex-col gap-1">
			<legend className="mb-1 text-muted text-xs">画質を選択</legend>
			{variants.map((variant) => (
				<label
					key={variant.id}
					className="flex cursor-pointer items-center gap-2 text-xs"
					htmlFor={`${groupName}-${variant.id}`}
				>
					<input
						id={`${groupName}-${variant.id}`}
						type="radio"
						name={groupName}
						value={variant.id}
						checked={variant.id === selectedId}
						onChange={() => onSelect(variant)}
					/>
					<span>{variantLabel(variant)}</span>
				</label>
			))}
		</fieldset>
	);
}
