/**
 * 進捗バー。0〜100 の値だけを受け取り、意味づけは呼び出し側が持つ。
 *
 * 色だけで状態を伝えない（docs/スタイルガイド.md）。数値やテキストは併記すること。
 */
export function ProgressBar({ value, label }: { value: number; label: string }) {
	const clamped = Math.min(100, Math.max(0, Math.round(value)));

	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuenow={clamped}
			aria-valuemin={0}
			aria-valuemax={100}
			// progressbar は操作対象ではないためタブ順には入れない。
			// スクリーンリーダーから参照できるよう、プログラム的なフォーカスだけ許す
			tabIndex={-1}
			className="h-1.5 w-full overflow-hidden rounded bg-surface-muted"
		>
			<div className="h-full bg-primary" style={{ width: `${clamped}%` }} />
		</div>
	);
}
