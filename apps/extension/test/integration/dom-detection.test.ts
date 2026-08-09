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
 * Content Script による DOM 検出の Integration テスト。
 *
 * ネットワーク検出との統合（要件定義 2.1）が実際に効くかを、
 * 実 Chrome 上で確認する。
 */

let harness: Harness;

beforeAll(async () => {
	harness = await startHarness();
}, 60_000);

afterAll(async () => {
	await stopHarness(harness);
});

describe('DOM 検出', () => {
	it('ネットワークリクエストが発生しない video を検出する', async () => {
		// preload="none" のため、DOM 検出が動いていなければ何も見つからない
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-dom-only.html`);

		const tabId = await resolveTabId(harness, 'media-dom-only.html');
		const stored = await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => (media?.length ?? 0) > 0,
			{ label: 'DOM 検出', diagnose: () => snapshot(harness) },
		);

		expect(stored).toHaveLength(1);
		expect(stored?.[0]).toMatchObject({
			type: 'direct',
			detectedBy: 'video-element',
			title: 'DOM だけで見つかる動画',
		});
		expect(stored?.[0]?.sourceUrl).toContain('dom-only.mp4');

		await page.close();
	});

	it('<source> 要素の候補をすべて検出する', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-source-elements.html`);

		const tabId = await resolveTabId(harness, 'media-source-elements.html');
		const stored = await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => (media?.length ?? 0) >= 2,
			{ label: '<source> の検出', diagnose: () => snapshot(harness) },
		);

		const urls = (stored ?? []).map((media) => media.sourceUrl);
		expect(urls.some((url) => url.includes('alt-a.webm'))).toBe(true);
		expect(urls.some((url) => url.includes('alt-b.mp4'))).toBe(true);

		await page.close();
	});

	it('blob URL を保存対象にしない', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-blob.html`);

		const tabId = await resolveTabId(harness, 'media-blob.html');
		// 検出されないことの確認なので、一定時間待ってから見る
		await new Promise((resolve) => setTimeout(resolve, 2_000));

		expect(await readStoredMedia(harness, tabId)).toBeUndefined();

		await page.close();
	});

	it('メタデータ読み込み後に再生時間・解像度を送り直す', async () => {
		// duration / videoWidth は loadedmetadata の後にしか取れない。
		// 重複判定を URL だけで行うと、この更新が Background へ届かない
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-metadata.html`);

		const tabId = await resolveTabId(harness, 'media-metadata.html');

		const stored = await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => media?.[0]?.width !== undefined,
			{ label: 'メタデータの反映', diagnose: () => snapshot(harness) },
		);

		// この動画は実際に取得されるためネットワーク検出も働き、そちらが優先される。
		// それでも DOM 側にしかない情報は統合で失われない（要件定義 2.1）
		expect(stored).toHaveLength(1);
		expect(stored?.[0]).toMatchObject({ detectedBy: 'network' });
		expect(stored?.[0]?.width).toBe(320);
		expect(stored?.[0]?.height).toBe(240);
		expect(stored?.[0]?.duration).toBeGreaterThan(0);

		await page.close();
	});

	it('動的に追加された video を検出する', async () => {
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/spa.html`);
		const tabId = await resolveTabId(harness, 'spa.html');

		await page.click('#load-media');

		const stored = await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => (media?.length ?? 0) > 0,
			{ label: 'MutationObserver による検出', diagnose: () => snapshot(harness) },
		);

		expect(stored?.[0]?.sourceUrl).toContain('sample.mp4');

		await page.close();
	});
});

describe('ネットワーク検出との統合', () => {
	it('同一メディアを 1 件へ統合し、ネットワーク検出の情報を優先する', async () => {
		// media-mp4.html は video 要素と実際のリクエストの両方から検出される
		const page = await harness.context.newPage();
		await page.goto(`${harness.server.origin}/media-mp4.html`);

		const tabId = await resolveTabId(harness, 'media-mp4.html');
		const stored = await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => (media?.length ?? 0) > 0,
			{ label: '統合の確認', diagnose: () => snapshot(harness) },
		);

		// 両方から検出されても 1 件のまま
		expect(stored).toHaveLength(1);
		// Content-Type を持つネットワーク検出が優先される（要件定義 2.1）
		expect(stored?.[0]).toMatchObject({
			detectedBy: 'network',
			mimeType: 'video/mp4',
		});

		await page.close();
	});
});
