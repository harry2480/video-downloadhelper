import { defineConfig } from '@playwright/test';

/**
 * E2E テストの設定。
 *
 * 拡張機能は launchPersistentContext + --load-extension でしかロードできず、
 * 従来の headless では動作しない。各テストが自前でコンテキストを起動するため、
 * ここでは projects による browser 指定を行わない。
 *
 * 実行前に `pnpm build` が必要（dist/ を読み込むため）。
 */
export default defineConfig({
	testDir: './test/e2e',
	// 拡張機能はブラウザごとにプロファイルを占有するため並列度を上げない
	workers: 1,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
	timeout: 60_000,
	expect: { timeout: 10_000 },
});
