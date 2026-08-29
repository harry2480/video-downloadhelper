import { describe, expect, it } from 'vitest';
import type { DetectionInput } from '../media/detected-media.model';
import type { FetchTextResult, MediaFetcherPort } from '../shared/ports/media-fetcher.port';
import type { DetectedMediaRepository } from '../shared/storage/detected-media.repository';
import type { DetectedMedia } from '../shared/types';
import { ManifestResolver } from './manifest-resolver';
import { MediaRegistry } from './media-registry';

/**
 * ManifestResolver は chrome.* に触れず、取得を Port 経由で受け取るため
 * Node.js 上でそのまま検証できる。
 *
 * ここで押さえるのは「行き詰まらないこと」。一時的な通信失敗やページ遷移との
 * 競合で、再解析の契機が永久に失われる状態を作らないことを確かめる。
 */

const TAB_ID = 1;
const HLS_URL = 'https://example.com/video/master.m3u8';
const OTHER_HLS_URL = 'https://example.com/video/other.m3u8';

const MASTER_PLAYLIST = [
	'#EXTM3U',
	'#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
	'low.m3u8',
	'#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
	'high.m3u8',
].join('\n');

function input(sourceUrl: string): DetectionInput {
	return {
		tabId: TAB_ID,
		pageUrl: 'https://example.com/watch',
		sourceUrl,
		detectedBy: 'network',
		detectedAt: 1_000,
	};
}

function createHarness() {
	const store = new Map<number, DetectedMedia[]>();

	const repository: DetectedMediaRepository = {
		async findByTab(tabId) {
			return store.get(tabId) ?? [];
		},
		async saveForTab(tabId, media) {
			store.set(tabId, [...media]);
		},
		async clearTab(tabId) {
			store.delete(tabId);
		},
	};

	const registry = new MediaRegistry(repository, (tabId, media) => {
		// Service Worker と同じ配線。遷移でクリアされたら抑止も解く
		if (media.length === 0) resolver.forgetTab(tabId);
	});

	const requested: string[] = [];
	let respond: (url: string) => Promise<FetchTextResult> = async () => ({
		ok: true,
		text: MASTER_PLAYLIST,
	});

	const fetcher: MediaFetcherPort = {
		async fetchText(url) {
			requested.push(url);
			return respond(url);
		},
	};

	const resolver = new ManifestResolver(fetcher, registry);

	return {
		registry,
		resolver,
		requested,
		respondWith(next: (url: string) => Promise<FetchTextResult>) {
			respond = next;
		},
		/** 検出 → 解析までを Service Worker と同じ順序で 1 往復させる */
		async detect(sourceUrl: string) {
			await registry.register(input(sourceUrl), registry.currentGeneration(TAB_ID));
			await this.resolveNow();
		},
		async resolveNow() {
			const generation = registry.currentGeneration(TAB_ID);
			await resolver.resolvePending(TAB_ID, await registry.list(TAB_ID), generation);
		},
		async find(sourceUrl: string): Promise<DetectedMedia | undefined> {
			const media = await registry.list(TAB_ID);
			return media.find((item) => item.sourceUrl === sourceUrl);
		},
	};
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

const networkFailure = async (): Promise<FetchTextResult> => ({ ok: false, reason: 'network' });

describe('resolvePending', () => {
	it('未解析の HLS を解析して品質一覧を反映する', async () => {
		const harness = createHarness();
		await harness.detect(HLS_URL);

		const media = await harness.find(HLS_URL);
		expect(media?.manifestResolved).toBe(true);
		expect(media?.variants).toHaveLength(2);
	});

	it('解析済みのマニフェストを取り直さない', async () => {
		const harness = createHarness();
		await harness.detect(HLS_URL);
		await harness.resolveNow();

		expect(harness.requested).toHaveLength(1);
	});

	it('HLS 以外は取得しない', async () => {
		const harness = createHarness();
		await harness.detect('https://example.com/video/movie.mp4');

		expect(harness.requested).toHaveLength(0);
	});
});

describe('一時的な失敗', () => {
	it('理由を出しつつ解析済みにはしない', async () => {
		const harness = createHarness();
		harness.respondWith(networkFailure);
		await harness.detect(HLS_URL);

		const media = await harness.find(HLS_URL);
		expect(media?.unsupportedReason).toMatch(/取得できませんでした/);
		expect(media?.manifestResolved).toBeUndefined();
	});

	it('次の契機で再試行し、成功すれば解析済みになる', async () => {
		const harness = createHarness();
		harness.respondWith(networkFailure);
		await harness.detect(HLS_URL);

		harness.respondWith(async () => ({ ok: true, text: MASTER_PLAYLIST }));
		await harness.resolveNow();

		expect(harness.requested).toHaveLength(2);
		const media = await harness.find(HLS_URL);
		expect(media?.manifestResolved).toBe(true);
		expect(media?.unsupportedReason).toBeUndefined();
	});

	it('自動の再試行は上限で打ち切る', async () => {
		const harness = createHarness();
		harness.respondWith(networkFailure);
		await harness.detect(HLS_URL);

		for (let i = 0; i < 5; i += 1) await harness.resolveNow();

		expect(harness.requested).toHaveLength(3);
	});

	it('更新操作で打ち切りを解除する', async () => {
		const harness = createHarness();
		harness.respondWith(networkFailure);
		await harness.detect(HLS_URL);
		for (let i = 0; i < 5; i += 1) await harness.resolveNow();

		harness.resolver.resetFailures(TAB_ID);
		harness.respondWith(async () => ({ ok: true, text: MASTER_PLAYLIST }));
		await harness.resolveNow();

		expect(await harness.find(HLS_URL)).toMatchObject({ manifestResolved: true });
	});

	it('ページを開き直せば試行回数はリセットされる', async () => {
		const harness = createHarness();
		harness.respondWith(networkFailure);
		await harness.detect(HLS_URL);
		for (let i = 0; i < 5; i += 1) await harness.resolveNow();

		await harness.registry.clearTab(TAB_ID);
		await harness.detect(HLS_URL);

		expect(harness.requested).toHaveLength(4);
	});
});

describe('再試行しない失敗', () => {
	it('マニフェストとして解析できなければ打ち切る', async () => {
		const harness = createHarness();
		harness.respondWith(async () => ({ ok: true, text: '<html>not a playlist</html>' }));
		await harness.detect(HLS_URL);
		await harness.resolveNow();

		expect(harness.requested).toHaveLength(1);
		const media = await harness.find(HLS_URL);
		expect(media?.manifestResolved).toBe(true);
		expect(media?.unsupportedReason).toMatch(/解析できませんでした/);
	});

	it('大きすぎるレスポンスは打ち切る', async () => {
		const harness = createHarness();
		harness.respondWith(async () => ({ ok: false, reason: 'too-large' }));
		await harness.detect(HLS_URL);
		await harness.resolveNow();

		expect(harness.requested).toHaveLength(1);
		const media = await harness.find(HLS_URL);
		expect(media?.manifestResolved).toBe(true);
		expect(media?.unsupportedReason).toMatch(/大きすぎます/);
	});
});

describe('ページ遷移との競合', () => {
	it('取得中に遷移したら残りの項目へ進まない', async () => {
		const harness = createHarness();
		const started = deferred<void>();
		const held = deferred<FetchTextResult>();
		harness.respondWith(async (url) => {
			if (url !== HLS_URL) return { ok: true, text: MASTER_PLAYLIST };
			started.resolve();
			return held.promise;
		});

		await harness.registry.register(input(HLS_URL), harness.registry.currentGeneration(TAB_ID));
		await harness.registry.register(
			input(OTHER_HLS_URL),
			harness.registry.currentGeneration(TAB_ID),
		);

		const pending = harness.resolveNow();
		await started.promise;

		// 取得中に再読み込みが起きる
		await harness.registry.clearTab(TAB_ID);
		held.resolve({ ok: true, text: MASTER_PLAYLIST });
		await pending;

		// 2 件目は旧ページ由来。遷移後の集合へ入れ直さない
		expect(harness.requested).toEqual([HLS_URL]);
	});

	it('遷移前の取得が遷移後の解析を止めない', async () => {
		const harness = createHarness();
		const started = deferred<void>();
		const held = deferred<FetchTextResult>();
		harness.respondWith(async () => {
			if (harness.requested.length > 1) return { ok: true, text: MASTER_PLAYLIST };
			started.resolve();
			return held.promise;
		});

		await harness.registry.register(input(HLS_URL), harness.registry.currentGeneration(TAB_ID));
		const pending = harness.resolveNow();
		await started.promise;

		await harness.registry.clearTab(TAB_ID);
		held.resolve({ ok: true, text: MASTER_PLAYLIST });
		await pending;

		// 遷移後のページで同じ URL を検出したら、抑止に引っかからず解析される
		await harness.detect(HLS_URL);

		expect(harness.requested).toEqual([HLS_URL, HLS_URL]);
		expect(await harness.find(HLS_URL)).toMatchObject({ manifestResolved: true });
	});
});
