import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	type Harness,
	listStoredKeys,
	readStoredMedia,
	resolveTabId,
	snapshot,
	startHarness,
	stopHarness,
	waitFor,
} from './helpers';

/**
 * 検出パイプラインの Integration テスト。
 *
 * chrome.* をモックせず、実際の Chrome へ拡張機能をロードして検証する。
 * モックは本物の制約（構造化クローン・容量上限・session の生存期間）を
 * 再現せず、テストが通っても実環境で壊れる。
 */

let harness: Harness;

beforeAll(async () => {
	harness = await startHarness();
}, 60_000);

afterAll(async () => {
	await stopHarness(harness);
});

describe('ネットワーク検出', () => {
	it('video 要素が読み込む MP4 を検出して storage へ保存する', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-mp4.html`);

		const tabId = await resolveTabId(harness, 'media-mp4.html');
		const stored = await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => (media?.length ?? 0) > 0,
			{ label: 'MP4 の検出', diagnose: () => snapshot(harness) },
		);

		expect(stored).toHaveLength(1);
		expect(stored?.[0]).toMatchObject({
			type: 'direct',
			mimeType: 'video/mp4',
			detectedBy: 'network',
			tabId,
		});
		expect(stored?.[0]?.sourceUrl).toContain('sample.mp4');

		await page.close();
	});

	it('XHR で取得される m3u8 を HLS として検出する', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-hls.html`);

		const tabId = await resolveTabId(harness, 'media-hls.html');
		const stored = await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => (media?.length ?? 0) > 0,
			{ label: 'HLS の検出' },
		);

		expect(stored?.[0]).toMatchObject({ type: 'hls', detectedBy: 'network' });
		expect(stored?.[0]?.sourceUrl).toContain('master.m3u8');

		await page.close();
	});

	it('メディアを含まないページでは何も保存しない', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/basic.html`);

		const tabId = await resolveTabId(harness, 'basic.html');
		// 検出されないことの確認なので、一定時間待ってから見る
		await new Promise((resolve) => setTimeout(resolve, 1_500));

		expect(await readStoredMedia(harness, tabId)).toBeUndefined();

		await page.close();
	});

	it('保存された値が構造化クローン可能な plain object である', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-mp4.html`);

		const tabId = await resolveTabId(harness, 'media-mp4.html');
		await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => (media?.length ?? 0) > 0,
		);

		// Service Worker 再起動後に復元できることの前提条件
		const worker = harness.context.serviceWorkers()[0];
		const isPlain = await worker?.evaluate(async (id) => {
			const key = `detected-media:${id}`;
			const stored = await chrome.storage.session.get(key);
			const media = stored[key] as unknown[];
			return media.every(
				(item) =>
					Object.getPrototypeOf(item) === Object.prototype &&
					Object.values(item as object).every((value) => typeof value !== 'function'),
			);
		}, tabId);

		expect(isPlain).toBe(true);

		await page.close();
	});
});

describe('タブ単位の分離', () => {
	it('別タブの検出結果が混ざらない', async () => {
		const mp4Page = await harness.context.newPage();
		await mp4Page.goto(`${harness.server.origin}/media-mp4.html`);
		const mp4TabId = await resolveTabId(harness, 'media-mp4.html');

		const hlsPage = await harness.context.newPage();
		await hlsPage.goto(`${harness.server.origin}/media-hls.html`);
		const hlsTabId = await resolveTabId(harness, 'media-hls.html');

		expect(mp4TabId).not.toBe(hlsTabId);

		const mp4Media = await waitFor(
			() => readStoredMedia(harness, mp4TabId),
			(media) => (media?.length ?? 0) > 0,
		);
		const hlsMedia = await waitFor(
			() => readStoredMedia(harness, hlsTabId),
			(media) => (media?.length ?? 0) > 0,
		);

		expect(mp4Media?.every((m) => m.type === 'direct')).toBe(true);
		expect(hlsMedia?.every((m) => m.type === 'hls')).toBe(true);

		await mp4Page.close();
		await hlsPage.close();
	});

	it('タブを閉じたら検出結果を破棄する', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-mp4.html`);
		const tabId = await resolveTabId(harness, 'media-mp4.html');

		await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => (media?.length ?? 0) > 0,
		);

		await page.close();

		const keys = await waitFor(
			() => listStoredKeys(harness),
			(list) => !list.includes(`detected-media:${tabId}`),
			{ label: 'タブ破棄後のクリア' },
		);
		expect(keys).not.toContain(`detected-media:${tabId}`);
	});
});

describe('検出結果のリセット規則', () => {
	it('メインフレームのページ遷移で検出結果をクリアする', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-mp4.html`);
		const tabId = await resolveTabId(harness, 'media-mp4.html');

		await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => (media?.length ?? 0) > 0,
		);

		// メディアを含まないページへ通常遷移する
		await page.goto(`${harness.server.origin}/basic.html`);

		const afterNavigation = await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => (media?.length ?? 0) === 0,
			{ label: 'ページ遷移後のクリア' },
		);
		expect(afterNavigation ?? []).toHaveLength(0);

		await page.close();
	});

	it('History API による SPA 内遷移では検出結果を維持する', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/spa.html`);
		const tabId = await resolveTabId(harness, 'spa.html');

		await page.click('#load-media');
		await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => (media?.length ?? 0) > 0,
			{ label: 'SPA でのメディア検出' },
		);

		// main_frame リクエストを発生させない遷移
		await page.click('#spa-navigate');
		expect(page.url()).toContain('view=detail');

		// 消えないことの確認なので、一定時間待ってから見る
		await new Promise((resolve) => setTimeout(resolve, 1_500));

		const afterSpaNavigation = await readStoredMedia(harness, tabId);
		expect(afterSpaNavigation?.length ?? 0).toBeGreaterThan(0);

		await page.close();
	});
});

describe('バッジ表示', () => {
	it('検出件数をバッジへ表示し、未検出では非表示にする', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-mp4.html`);
		const tabId = await resolveTabId(harness, 'media-mp4.html');

		const worker = harness.context.serviceWorkers()[0];
		if (!worker) throw new Error('service worker not found');

		const badgeWithMedia = await waitFor(
			() => worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId),
			(text) => text !== '',
			{ label: 'バッジ表示' },
		);
		expect(badgeWithMedia).toBe('1');

		await page.goto(`${harness.server.origin}/basic.html`);

		const badgeWithoutMedia = await waitFor(
			() => worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId),
			(text) => text === '',
			{ label: 'バッジ非表示' },
		);
		expect(badgeWithoutMedia).toBe('');

		await page.close();
	});
});
