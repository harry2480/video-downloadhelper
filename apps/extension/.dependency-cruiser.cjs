/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: 'no-core-to-context',
			severity: 'error',
			comment:
				'コアロジック層(shared/media/processor)は実行コンテキストに依存してはならない。副作用は Port として注入する',
			from: { path: '^src/(shared|media|processor)/' },
			to: { path: '^src/(background|offscreen|content|popup)/' },
		},
		{
			name: 'no-cross-context',
			severity: 'error',
			comment: '実行コンテキスト同士は別バンドル。直接 import できないのでメッセージ経由で通信する',
			from: { path: '^src/(background|offscreen|content|popup)/' },
			// $1 は from.path のキャプチャ。自分自身のディレクトリ内の import のみ許可する
			to: {
				path: '^src/(background|offscreen|content|popup)/',
				pathNot: '^src/$1/',
			},
		},
		{
			name: 'shared-is-innermost',
			severity: 'error',
			comment: 'shared は最内層。他ディレクトリへ依存してはならない',
			from: { path: '^src/shared/' },
			to: {
				path: '^src/(media|processor|background|offscreen|content|popup)/',
			},
		},
		{
			name: 'media-depends-on-shared-only',
			severity: 'error',
			comment: 'media は shared にのみ依存してよい',
			from: { path: '^src/media/' },
			to: { path: '^src/processor/' },
		},
		{
			name: 'core-no-storage',
			severity: 'error',
			comment: 'shared/storage は chrome.storage を直接呼ぶ例外層。コアロジック層へ波及させない',
			from: { path: '^src/(media|processor)/' },
			to: { path: '^src/shared/storage/' },
		},
		{
			name: 'no-circular',
			severity: 'error',
			comment: '循環依存を禁止する',
			from: {},
			to: { circular: true },
		},
		// 未使用モジュールの検出は knip が担当する（`pnpm knip`）。
		// depcruise の no-orphans は各コンテキストのエントリを誤検知するため使わない。
	],
	options: {
		doNotFollow: { path: 'node_modules' },
		exclude: { path: '\\.test\\.tsx?$' },
		tsPreCompilationDeps: true,
		tsConfig: { fileName: './tsconfig.json' },
		enhancedResolveOptions: {
			exportsFields: ['exports'],
			conditionNames: ['import', 'require', 'node', 'default'],
			extensions: ['.js', '.jsx', '.ts', '.tsx'],
		},
		reporterOptions: {
			text: { highlightFocused: true },
		},
	},
};
