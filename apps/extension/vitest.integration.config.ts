import { defineConfig } from 'vitest/config';

/**
 * Integration テストの設定。
 *
 * chrome.* に依存する層（storage / messaging / webRequest）を対象とする。
 * 実際の Chrome へ拡張機能をロードして検証するため、実行前に `pnpm build` が必要。
 *
 * chrome.* API のモックを自作しないこと。モックは本物の制約
 * （構造化クローン、容量上限、session の生存期間）を再現せず、
 * テストが通っても実環境で壊れる（docs/テストガイドライン.md 参照）。
 */
export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['test/integration/**/*.test.ts'],
		// テストは機能の実装と同じ PR で追加していく
		passWithNoTests: true,
		// Chrome の起動を伴うため Unit テストより長い猶予を与える
		testTimeout: 30_000,
		hookTimeout: 60_000,
	},
});
