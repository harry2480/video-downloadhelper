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

test('Service Worker が background のバンドルを実行している', async () => {
	// エントリのファイル名が重複していると、CRXJS が
	// service-worker-loader.js を別のバンドル（content script 等）へ
	// 紐づけてしまう。SW は起動するが中身が別物、という形で静かに壊れる。
	// リスナーの登録有無で「正しいコードが動いているか」を直接確かめる。
	const worker = extension.context.serviceWorkers()[0];
	expect(worker).toBeDefined();

	const listeners = await worker?.evaluate(() => ({
		headersReceived: chrome.webRequest.onHeadersReceived.hasListeners(),
		beforeRequest: chrome.webRequest.onBeforeRequest.hasListeners(),
		tabRemoved: chrome.tabs.onRemoved.hasListeners(),
	}));

	expect(listeners).toEqual({
		headersReceived: true,
		beforeRequest: true,
		tabRemoved: true,
	});
});

/** manifest が宣言しているアイコンのサイズ。生成スクリプトの SIZES と対になる。 */
const ICON_SIZES = [16, 32, 48, 128] as const;

test('manifest のアイコンが実際に解決できる', async () => {
	// icons / default_icon のパスがずれていても、ビルドも typecheck も通り、
	// Chrome は拡張機能をロードする。既定のアイコンが出るだけなので、
	// 目視しない限り気づけない。実寸と「描かれているか」まで確かめて、
	// リサイズ漏れとラスタライズ失敗も塞ぐ。
	const worker = extension.context.serviceWorkers()[0];
	expect(worker).toBeDefined();

	const resolved = await worker?.evaluate(async () => {
		const manifest = chrome.runtime.getManifest();
		const declared: Record<string, Record<string, string>> = {
			icons: (manifest.icons ?? {}) as Record<string, string>,
			// 文字列を 1 つだけ指定する形も manifest 上は妥当。ここでは表形式のみ扱う
			default_icon: (manifest.action?.default_icon ?? {}) as Record<string, string>,
		};

		const results: {
			field: string;
			size: string;
			ok: boolean;
			width: number;
			height: number;
			visible: boolean;
		}[] = [];

		for (const [field, table] of Object.entries(declared)) {
			for (const [size, path] of Object.entries(table)) {
				try {
					const response = await fetch(chrome.runtime.getURL(path));
					if (!response.ok) throw new Error(`HTTP ${response.status}`);

					// PNG として実際に復号できることまで確かめる
					const bitmap = await createImageBitmap(await response.blob());
					const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
					const context = canvas.getContext('2d');
					if (context === null) throw new Error('2d コンテキストを取得できませんでした');

					context.drawImage(bitmap, 0, 0);
					const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;

					results.push({
						field,
						size,
						ok: true,
						width: bitmap.width,
						height: bitmap.height,
						// 全面透明でも「解決できる」ため、不透明な画素があることを見る
						visible: pixels.some((value, i) => i % 4 === 3 && value > 0),
					});
					bitmap.close();
				} catch {
					// 未登録のリソースへの fetch は 404 ではなく TypeError になる。
					// ここで握らないと evaluate ごと落ち、どのサイズが壊れたか差分に出ない
					results.push({ field, size, ok: false, width: 0, height: 0, visible: false });
				}
			}
		}

		return results;
	});

	// Chrome Web Store の提出には 128x128 が必須（docs/インフラストラクチャ規約.md）
	expect(resolved).toEqual(
		['icons', 'default_icon'].flatMap((field) =>
			ICON_SIZES.map((size) => ({
				field,
				size: String(size),
				ok: true,
				width: size,
				height: size,
				visible: true,
			})),
		),
	);
});

test('ポップアップが表示される', async () => {
	const page = await extension.context.newPage();
	await page.goto(popupUrl(extension.extensionId));

	await expect(page.getByRole('heading', { name: 'Video Download Helper' })).toBeVisible();

	await page.close();
});

test('ポップアップがコンソールへ警告もエラーも出さない', async () => {
	// **`<link rel="modulepreload" crossorigin>` は拡張機能では逆効果。**
	// crossorigin により先読みが CORS モードで走り、本体のモジュール取得
	// （同一オリジン）と食い違う。Chrome は先読み結果を捨てて取り直すため、
	// ポップアップを開くたびに無駄な取得と警告が出ていた
	//
	//   A preload for '...' is found, but is not used because it is a
	//   cross-world extension resource mismatch.
	const page = await extension.context.newPage();

	const messages: string[] = [];
	page.on('console', (message) => {
		if (message.type() !== 'warning' && message.type() !== 'error') return;
		messages.push(`${message.type()}: ${message.text()}`);
	});
	page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));

	await page.goto(popupUrl(extension.extensionId));
	await expect(page.getByRole('heading', { name: 'Video Download Helper' })).toBeVisible();

	// 先読みの警告は読み込み完了から数秒後に出る。待たないと素通りする
	await page.waitForTimeout(3_000);

	expect(messages).toEqual([]);

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

test('ポップアップがライト・ダークで配色を切り替える', async () => {
	// Tailwind v4 は @theme をホイストするため、@media の中に書くと条件が
	// 失われて片方の配色だけが常に効く。生成された CSS を目視しないと
	// 気づけないので、実ブラウザの算出値で確認する。
	const page = await extension.context.newPage();

	const readSurface = async () =>
		page.locator('#root > div').evaluate((element) => getComputedStyle(element).backgroundColor);

	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto(popupUrl(extension.extensionId));
	const light = await readSurface();

	await page.emulateMedia({ colorScheme: 'dark' });
	const dark = await readSurface();

	expect(light).not.toBe(dark);
	expect(light).toBe('rgb(255, 255, 255)');
	expect(dark).toBe('rgb(32, 33, 36)');

	await page.close();
});

test('Content Script の検出がバッジまで届く', async () => {
	// manifest による注入 → DOM 検出 → メッセージ → Background → バッジ という
	// 経路を通しで確認する。preload="none" のためネットワーク検出は働かず、
	// Content Script が動いていなければバッジは出ない。
	const page = await extension.context.newPage();
	await page.goto(`${server.origin}/media-dom-only.html`);

	const worker = extension.context.serviceWorkers()[0];
	expect(worker).toBeDefined();

	const tabId = await worker?.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ url: '*://*/media-dom-only.html' });
		return tab?.id ?? -1;
	});
	expect(tabId).toBeGreaterThanOrEqual(0);

	await expect
		.poll(() => worker?.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), {
			timeout: 15_000,
		})
		.toBe('1');

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
