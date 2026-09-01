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

/** フィクスチャが投げる回数（`media-hls-live.html` と対になる）。 */
const PAGE_RELOADS = 8;

/** 観測を打ち切るまでの猶予。短いと、抑止が壊れていても超過分を見逃す。 */
const SETTLE_MS = 1_500;

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
			await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
		} finally {
			observed.stop();
			await page.close();
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
		let stored: Awaited<ReturnType<typeof readStoredMedia>>;

		try {
			await page.goto(`${harness.server.origin}/media-hls-live.html`);
			const tabId = await resolveTabId(harness, 'media-hls-live.html');
			await waitFor(
				() => readStoredMedia(harness, tabId),
				(media) => media?.[0]?.manifestResolved === true,
				{ label: 'ライブ HLS の解析', diagnose: () => snapshot(harness) },
			);

			// ページ側が投げ終わるまで待つ
			await waitFor(
				async () => observed.fromPage.length,
				(count) => count >= PAGE_RELOADS,
				{ label: 'ページからの再読み込み' },
			);
			// 待たずに打ち切ると、抑止が壊れていても超過分を観測できずに通る
			await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

			stored = await readStoredMedia(harness, tabId);
		} finally {
			observed.stop();
			await page.close();
		}

		// ページは何度も読み込むが、拡張機能の再フェッチは 1 回だけ
		expect(observed.fromServiceWorker).toHaveLength(1);
		// シーケンス番号だけが違う URL が 1 件へまとまっていること。
		// まとまっていなければ、抑止が効いていても件数は増える
		expect(stored).toHaveLength(1);
	});
});

describe('対応の判定', () => {
	it('fMP4 セグメントの HLS を対応外にしない', async () => {
		// 初期化セグメント（#EXT-X-MAP）を先頭に置いて結合すれば
		// mp4 として保存できる。理由を出して止めない
		const page = await harness.context.newPage();

		try {
			await page.goto(`${harness.server.origin}/media-hls-fmp4.html`);

			const tabId = await resolveTabId(harness, 'media-hls-fmp4.html');
			const stored = await waitFor(
				() => readStoredMedia(harness, tabId),
				(media) => media?.[0]?.manifestResolved === true,
				{ label: 'fMP4 の解析', diagnose: () => snapshot(harness) },
			);

			expect(stored?.[0]?.unsupportedReason).toBeUndefined();
		} finally {
			await page.close();
		}
	});

	it('AES-128 の HLS を対応外にしない', async () => {
		// 鍵を取得して復号する。復号できない場合だけ保存計画の側で弾く
		const page = await harness.context.newPage();

		try {
			await page.goto(`${harness.server.origin}/media-hls-aes.html`);

			const tabId = await resolveTabId(harness, 'media-hls-aes.html');
			const stored = await waitFor(
				() => readStoredMedia(harness, tabId),
				(media) => media?.[0]?.manifestResolved === true,
				{ label: 'AES-128 の解析', diagnose: () => snapshot(harness) },
			);

			expect(stored?.[0]?.unsupportedReason).toBeUndefined();
		} finally {
			await page.close();
		}
	});
});

/**
 * マニフェストへのリクエストを、発行元ごとに数える。
 *
 * **Page ではなく BrowserContext で監視すること。** Service Worker が送る
 * リクエストは `page.on('request')` には現れない。拡張機能の再フェッチは
 * Service Worker から出るため、Page 単位で監視すると 1 件も観測できず、
 * 「繰り返していない」という検証が素通りする。
 *
 * **前提: 再フェッチは Service Worker からのみ出る。** Content Script は
 * ページのフレームで動くため `serviceWorker()` は null を返し、
 * `fromPage` に数えられる。取得の主体を Content Script へ移すなら、
 * この分類も見直すこと（そうしないと退行を見逃す）。
 */
function collectManifestRequests(
	harness: Harness,
	pathSubstring: string,
): { fromServiceWorker: string[]; fromPage: string[]; stop: () => void } {
	const fromServiceWorker: string[] = [];
	const fromPage: string[] = [];

	const onRequest = (request: Request) => {
		if (!request.url().includes(pathSubstring)) return;

		// serviceWorker() は Chromium のみ。**「何らかの SW」では足りない。**
		// フィクスチャが SW を登録すると、ページ由来の取得が混ざる
		const worker = request.serviceWorker();
		if (worker?.url().startsWith('chrome-extension://') === true) {
			fromServiceWorker.push(request.url());
		} else {
			fromPage.push(request.url());
		}
	};

	harness.context.on('request', onRequest);
	return {
		fromServiceWorker,
		fromPage,
		stop: () => harness.context.off('request', onRequest),
	};
}
