import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		// コアロジック層のみを対象とする。実行コンテキスト層は Integration / E2E で担保する。
		include: ['src/{shared,media,processor}/**/*.test.ts'],
		passWithNoTests: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov'],
			include: ['src/shared/**', 'src/media/**', 'src/processor/**'],
			exclude: [
				'**/*.test.ts',
				'**/*.d.ts',
				// chrome.storage を直接呼ぶ Repository は Integration テストで検証する。
				// Unit テストの対象外なので計測からも外す（codecov.yml と揃えること）
				'src/shared/storage/**',
			],
		},
	},
});
