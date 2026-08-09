import { expect, test } from '@playwright/test';
import { type ExtensionContext, launchExtension, popupUrl } from './fixtures';
import { type StaticServer, startStaticServer } from './static-server';

/**
 * ビルド成果物が実際に Chrome へロードでき、各コンテキストが起動することを確認する。
 *
 * manifest のエントリ記述漏れやビルド設定の誤りは typecheck では検出できず、
 * 実際にロードするまで表面化しない。ここが落ちたら他のすべてが動かない。
 */

let extension: ExtensionContext;
let server: StaticServer;

test.beforeAll(async () => {
	server = await startStaticServer();
	extension = await launchExtension();
});

test.afterAll(async () => {
	await extension?.close();
	await server?.close();
});

test('Service Worker が起動する', async () => {
	const workers = extension.context.serviceWorkers();

	expect(workers.length).toBeGreaterThan(0);
	expect(extension.extensionId).toMatch(/^[a-p]{32}$/);
});

test('ポップアップが表示される', async () => {
	const page = await extension.context.newPage();
	await page.goto(popupUrl(extension.extensionId));

	await expect(page.getByRole('heading', { name: 'Video Download Helper' })).toBeVisible();

	await page.close();
});

test('ポップアップが要件どおりの幅で描画される', async () => {
	const page = await extension.context.newPage();
	await page.goto(popupUrl(extension.extensionId));

	// 要件定義 4.2: 幅 400〜480px。ビューポート単位を使うと値が確定せず崩れる
	const width = await page
		.locator('#root > div')
		.evaluate((element) => element.getBoundingClientRect().width);

	expect(width).toBeGreaterThanOrEqual(400);
	expect(width).toBeLessThanOrEqual(480);

	await page.close();
});

test('Content Script が通常のページへ注入される', async () => {
	const page = await extension.context.newPage();

	// data: URL には注入されないため、ローカルの http ページを使う
	const injected = page.waitForEvent('console', {
		predicate: (message) => message.text().includes('[vdh] content script injected'),
		timeout: 15_000,
	});

	await page.goto(`${server.origin}/basic.html`);
	await expect(injected).resolves.toBeTruthy();

	await page.close();
});

test('拡張機能が外部ホストへリクエストしない', async () => {
	const page = await extension.context.newPage();
	const externalRequests: string[] = [];

	page.on('request', (request) => {
		const url = request.url();
		if (/^https?:\/\//.test(url)) externalRequests.push(url);
	});

	await page.goto(popupUrl(extension.extensionId));
	await page.waitForTimeout(1_000);

	// プライバシー要件の機械的検証（要件定義 12 章）。
	// 画像・フォント・スクリプトはすべて同梱し、外部へ出ないこと
	expect(externalRequests).toEqual([]);

	await page.close();
});
