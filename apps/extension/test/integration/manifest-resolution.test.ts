import type { Request } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	type Harness,
	readStoredMedia,
	resolveTabId,
	snapshot,
	startHarness,
	stopHarness,
	waitFor,
} from './helpers';

/**
 * マニフェスト再フェッチの Integration テスト。
 *
 * 拡張機能が実際に取得し直して解析できることを、実 Chrome で確認する。
 * MVP 完了条件「Master Playlist から画質一覧を取得できる」に対応する。
 */

let harness: Harness;

beforeAll(async () => {
	harness = await startHarness();
}, 60_000);

afterAll(async () => {
	await stopHarness(harness);
});

describe('Master Playlist の解析', () => {
	it('画質一覧を取得して高画質順に並べる', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-hls.html`);

		const tabId = await resolveTabId(harness, 'media-hls.html');
		const stored = await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => media?.[0]?.manifestResolved === true,
			{ label: 'マニフェスト解析', diagnose: () => snapshot(harness) },
		);

		const hls = stored?.[0];
		expect(hls?.type).toBe('hls');
		expect(hls?.variants).toHaveLength(2);
		expect(hls?.variants?.map((variant) => variant.height)).toEqual([1080, 720]);
		expect(hls?.variants?.[0]?.url).toContain('1080p/index.m3u8');
		expect(hls?.unsupportedReason).toBeUndefined();

		await page.close();
	});

	it('検出したマニフェストを 1 回だけ取得し直す', async () => {
		const page = await harness.context.newPage();
		const observed = collectManifestRequests(harness, 'hls/master.m3u8');

		try {
			await page.goto(`${harness.server.origin}/media-hls.html`);
			const tabId = await resolveTabId(harness, 'media-hls.html');
			await waitFor(
				() => readStoredMedia(harness, tabId),
				(media) => media?.[0]?.manifestResolved === true,
				{ label: 'マニフェスト解析', diagnose: () => snapshot(harness) },
			);

			// 抑止が効いていなければ、この間に再フェッチが積み上がる
			await new Promise((resolve) => setTimeout(resolve, 1_500));
		} finally {
			observed.stop();
		}

		// **上限だけを見ないこと。** `toBeLessThanOrEqual(2)` は、拡張機能の
		// fetch を 1 件も観測できていなくても通る。Service Worker からの
		// リクエストを実際に捉えられていることまで確かめる
		expect(observed.fromServiceWorker).toHaveLength(1);
		expect(observed.fromPage).toHaveLength(1);
	});

	it('繰り返し読み込まれても再フェッチは 1 回で済ませる', async () => {
		// 上のテストはページが 1 回しか取得しないため、抑止を外しても
		// 件数が変わらない。ライブ HLS のようにプレイヤーが繰り返し
		// 読み込む形にして、抑止そのものを検証する。
		// シーケンス番号だけが違う URL は重複判定で 1 件へまとまる
		const page = await harness.context.newPage();
		const observed = collectManifestRequests(harness, 'hls/master.m3u8');

		try {
			await page.goto(`${harness.server.origin}/media-hls-live.html`);
			const tabId = await resolveTabId(harness, 'media-hls-live.html');
			await waitFor(
				() => readStoredMedia(harness, tabId),
				(media) => media?.[0]?.manifestResolved === true,
				{ label: 'ライブ HLS の解析', diagnose: () => snapshot(harness) },
			);

			// ページ側が 8 回投げ終わるまで待つ
			await waitFor(
				async () => observed.fromPage.length,
				(count) => count >= 8,
				{ label: 'ページからの再読み込み' },
			);
			await new Promise((resolve) => setTimeout(resolve, 500));
		} finally {
			observed.stop();
		}

		// ページは何度も読み込むが、拡張機能の再フェッチは 1 回だけ
		expect(observed.fromServiceWorker).toHaveLength(1);
		expect(observed.fromPage.length).toBeGreaterThanOrEqual(8);
	});
});

describe('対応外の判定', () => {
	it('fMP4 セグメントの HLS を対応外として理由を記録する', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-hls-fmp4.html`);

		const tabId = await resolveTabId(harness, 'media-hls-fmp4.html');
		const stored = await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => media?.[0]?.manifestResolved === true,
			{ label: 'fMP4 の解析', diagnose: () => snapshot(harness) },
		);

		expect(stored?.[0]?.unsupportedReason).toContain('fMP4');
		expect(stored?.[0]?.variants).toBeUndefined();

		await page.close();
	});
});

/**
 * マニフェストへのリクエストを、発行元ごとに数える。
 *
 * **Page ではなく BrowserContext で監視すること。** Service Worker が送る
 * リクエストは `page.on('request')` には現れない。拡張機能の再フェッチは
 * Service Worker から出るため、Page 単位で監視すると 1 件も観測できず、
 * 「繰り返していない」という検証が素通りする。
 */
function collectManifestRequests(
	harness: Harness,
	pathSubstring: string,
): { fromServiceWorker: string[]; fromPage: string[]; stop: () => void } {
	const fromServiceWorker: string[] = [];
	const fromPage: string[] = [];

	const onRequest = (request: Request) => {
		if (!request.url().includes(pathSubstring)) return;
		// serviceWorker() は Chromium のみ。null ならフレーム由来
		if (request.serviceWorker() === null) fromPage.push(request.url());
		else fromServiceWorker.push(request.url());
	};

	harness.context.on('request', onRequest);
	return {
		fromServiceWorker,
		fromPage,
		stop: () => harness.context.off('request', onRequest),
	};
}
