/**
 * ポップアップの寸法はビューポート単位ではなく固定 px で指定する。
 * スクロールはルートではなく一覧領域の内側に持たせる（docs/スタイルガイド.md 参照）。
 */
export function App() {
	return (
		<div className="flex max-h-[600px] w-[420px] flex-col bg-surface text-foreground">
			<header className="border-border border-b px-4 py-3">
				<h1 className="font-medium text-sm">Video Download Helper</h1>
			</header>
			<div className="flex-1 overflow-y-auto px-4 py-6">
				<p className="text-muted text-sm">このページの動画を検出しています…</p>
			</div>
		</div>
	);
}
