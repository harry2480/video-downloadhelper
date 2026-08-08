/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		// domain → 外部層 禁止
		{
			name: 'domain-no-depend-on-outer-layers',
			severity: 'error',
			comment: 'domain 層は application, infrastructure, presentation に依存してはならない',
			from: { path: 'src/backend/domain/' },
			to: {
				path: [
					'src/backend/application/',
					'src/backend/infrastructure/',
					'src/backend/presentation/',
				],
			},
		},
		// application → infrastructure 禁止
		{
			name: 'application-no-depend-on-infrastructure',
			severity: 'error',
			comment:
				'application 層は infrastructure に直接依存してはならない（Gateway interface 経由のみ）',
			from: { path: 'src/backend/application/' },
			to: { path: 'src/backend/infrastructure/' },
		},
		// presentation/loaders, actions → domain 禁止
		{
			name: 'presentation-loaders-actions-no-depend-on-domain',
			severity: 'error',
			comment: 'presentation/loaders, actions は domain に直接依存してはならない',
			from: { path: 'src/backend/presentation/(loaders|actions)/' },
			to: { path: 'src/backend/domain/' },
		},
		// presentation/loaders, actions → infrastructure 禁止
		{
			name: 'presentation-loaders-actions-no-depend-on-infrastructure',
			severity: 'error',
			comment:
				'presentation/loaders, actions は infrastructure に直接依存してはならない（composition 経由で解決）',
			from: { path: 'src/backend/presentation/(loaders|actions)/' },
			to: { path: 'src/backend/infrastructure/' },
		},
		// frontend → backend/presentation 以外禁止
		{
			name: 'frontend-only-depend-on-presentation',
			severity: 'error',
			comment: 'frontend は backend/presentation のみ参照可',
			from: { path: '(src/app/|src/frontend/)' },
			to: {
				path: 'src/backend/',
				pathNot: 'src/backend/presentation/',
			},
		},
	],
	options: {
		doNotFollow: {
			path: ['node_modules'],
		},
		tsPreCompilationDeps: true,
		tsConfig: {
			fileName: './tsconfig.json',
		},
		enhancedResolveOptions: {
			exportsFields: ['exports'],
			conditionNames: ['import', 'require', 'node', 'default'],
		},
		reporterOptions: {
			text: {
				highlightFocused: true,
			},
		},
	},
};
