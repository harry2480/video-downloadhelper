import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		// コアロジック層に加えて、実行コンテキスト層のうち chrome.* に触れない
		// オーケストレーター（MediaRegistry 等）も対象にする。
		// chrome.* に依存するコードはここでは動かない（モックで通そうとしないこと）。
		include: ['src/**/*.test.{ts,tsx}'],
		// jsdom が必要なテストは各ファイルの先頭で
		// `/** @vitest-environment jsdom */` を宣言する
		setupFiles: ['./test/setup-dom.ts'],
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
