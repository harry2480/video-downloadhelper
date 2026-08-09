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

/**
 * 外部ホストへのリクエストを収集する。
 *
 * **Page ではなく BrowserContext で監視すること。** Service Worker が送る
 * リクエストは page.on('request') には一切現れない。外部送信を最も起こしやすい
 * のが Service Worker なので、Page 単位で監視するとこの検証は素通りする。
 */
function collectExternalRequests(
	context: ExtensionContext['context'],
	allowedOrigin: string,
): { urls: string[]; stop: () => void } {
	const urls: string[] = [];

	const onRequest = (request: { url: () => string }) => {
		const url = request.url();
		if (!/^https?:\/\//.test(url)) return;
		// ローカルのフィクスチャ配信は外部送信ではない
		if (url.startsWith(allowedOrigin)) return;
		urls.push(url);
	};

	context.on('request', onRequest);
	return { urls, stop: () => context.off('request', onRequest) };
}

test('拡張機能が外部ホストへリクエストしない', async () => {
	const collected = collectExternalRequests(extension.context, server.origin);
	const page = await extension.context.newPage();

	await page.goto(popupUrl(extension.extensionId));
	// Content Script も動かしたうえで観測する
	await page.goto(`${server.origin}/basic.html`);
	await page.waitForTimeout(1_000);

	collected.stop();

	// プライバシー要件の機械的検証（要件定義 12 章）。
	// 画像・フォント・スクリプトはすべて同梱し、外部へ出ないこと
	expect(collected.urls).toEqual([]);

	await page.close();
});

test('外部リクエストの検出機構が Service Worker の通信を捕捉する', async () => {
	// 上のテストが「監視できていないから空」で通る状態に退行していないことを保証する。
	// page.on('request') に戻すとこのテストが落ちる。
	const collected = collectExternalRequests(extension.context, server.origin);

	const worker = extension.context.serviceWorkers()[0];
	expect(worker).toBeDefined();

	await worker?.evaluate(async () => {
		try {
			await fetch('https://detector-selftest.invalid/beacon');
		} catch {
			// 名前解決に失敗してよい。リクエストが発生した事実を観測できればよい
		}
	});

	collected.stop();

	expect(collected.urls).toContain('https://detector-selftest.invalid/beacon');
});
