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

	it('同じマニフェストを繰り返し取得しない', async () => {
		const page = await harness.context.newPage();

		const manifestRequests: string[] = [];
		harness.context.on('request', (request) => {
			if (request.url().includes('hls/master.m3u8')) manifestRequests.push(request.url());
		});

		await page.goto(`${harness.server.origin}/media-hls.html`);
		const tabId = await resolveTabId(harness, 'media-hls.html');
		await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => media?.[0]?.manifestResolved === true,
		);

		await new Promise((resolve) => setTimeout(resolve, 1_500));

		// ページ自身の XHR 1 回 + 拡張機能の再フェッチ 1 回
		expect(manifestRequests.length).toBeLessThanOrEqual(2);

		await page.close();
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
