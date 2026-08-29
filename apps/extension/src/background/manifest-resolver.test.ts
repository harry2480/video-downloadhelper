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
 * ここで押さえるのは「行き詰まらないこと」と「増幅しないこと」。
 * 一時的な通信失敗・ページ遷移との競合・storage の失敗で再解析の契機が
 * 永久に失われないこと、逆に検出のたびに取得が膨らまないことを確かめる。
 */

const TAB_ID = 1;
const HLS_URL = 'https://example.com/video/master.m3u8';
const OTHER_HLS_URL = 'https://example.com/video/other.m3u8';

/** 実装の `RETRY_INTERVAL_MS` を跨ぐ時間。 */
const PAST_RETRY_INTERVAL = 10_000;

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

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function createHarness(options: { autoResolve?: boolean } = {}) {
	const autoResolve = options.autoResolve ?? true;
	const store = new Map<number, DetectedMedia[]>();
	let saveCount = 0;
	let failSaveAt: number | undefined;
	let time = 1_000;

	const repository: DetectedMediaRepository = {
		async findByTab(tabId) {
			return store.get(tabId) ?? [];
		},
		async saveForTab(tabId, media) {
			saveCount += 1;
			if (saveCount === failSaveAt) throw new Error('storage の書き込みに失敗しました');
			store.set(tabId, [...media]);
		},
		async clearTab(tabId) {
			store.delete(tabId);
		},
	};

	// Service Worker と同じ配線にする。解析結果の反映が次の解析を呼ぶ再入経路まで
	// 再現しないと、検出が高頻度なときの取得回数を検証できない。
	// 逐次ループそのものを見たいケースだけ `autoResolve: false` で切る
	const running: Promise<unknown>[] = [];
	const registry = new MediaRegistry(repository, (tabId, media) => {
		if (media.length === 0) {
			resolver.forgetTab(tabId);
			return;
		}
		if (!autoResolve) return;
		running.push(
			resolver.resolvePending(tabId, media, registry.currentGeneration(tabId)).catch(() => {
				// 本番では fireAndForget が記録する
			}),
		);
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

	const resolver = new ManifestResolver(fetcher, registry, () => time);

	const harness = {
		registry,
		resolver,
		requested,
		respondWith(next: (url: string) => Promise<FetchTextResult>) {
			respond = next;
		},
		/** n 回目の保存だけ失敗させる。1 回目は検出結果の登録 */
		failSaveAtCall(n: number) {
			failSaveAt = n;
		},
		advance(ms: number) {
			time += ms;
		},
		/** 再入で走った解析がすべて終わるまで待つ */
		async settle() {
			while (running.length > 0) await Promise.all(running.splice(0));
		},
		/** 検出 → 解析までを Service Worker と同じ順序で 1 往復させる */
		async detect(sourceUrl: string) {
			await registry.register(input(sourceUrl), registry.currentGeneration(TAB_ID));
			await harness.resolveNow();
		},
		async resolveNow() {
			const generation = registry.currentGeneration(TAB_ID);
			await resolver.resolvePending(TAB_ID, await registry.list(TAB_ID), generation);
			await harness.settle();
		},
		async find(sourceUrl: string): Promise<DetectedMedia | undefined> {
			const media = await registry.list(TAB_ID);
			return media.find((item) => item.sourceUrl === sourceUrl);
		},
	};

	return harness;
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

	it('間隔を空けて再試行し、成功すれば解析済みになる', async () => {
		const harness = createHarness();
		harness.respondWith(networkFailure);
		await harness.detect(HLS_URL);

		harness.respondWith(async () => ({ ok: true, text: MASTER_PLAYLIST }));
		harness.advance(PAST_RETRY_INTERVAL);
		await harness.resolveNow();

		expect(harness.requested).toHaveLength(2);
		const media = await harness.find(HLS_URL);
		expect(media?.manifestResolved).toBe(true);
		expect(media?.unsupportedReason).toBeUndefined();
	});

	it('契機が連続しても間隔を置くまで再試行しない', async () => {
		// ライブ HLS は数百 ms 間隔で検出が届く。ここで消費すると
		// 数秒の瞬断で上限を使い切ってしまう
		const harness = createHarness();
		harness.respondWith(networkFailure);
		await harness.detect(HLS_URL);

		for (let i = 0; i < 5; i += 1) await harness.resolveNow();

		expect(harness.requested).toHaveLength(1);
	});

	it('自動の再試行は上限で打ち切る', async () => {
		const harness = createHarness();
		harness.respondWith(networkFailure);
		await harness.detect(HLS_URL);

		for (let i = 0; i < 5; i += 1) {
			harness.advance(PAST_RETRY_INTERVAL);
			await harness.resolveNow();
		}

		expect(harness.requested).toHaveLength(3);
	});

	it('更新操作で打ち切りを解除する', async () => {
		const harness = createHarness();
		harness.respondWith(networkFailure);
		await harness.detect(HLS_URL);
		for (let i = 0; i < 5; i += 1) {
			harness.advance(PAST_RETRY_INTERVAL);
			await harness.resolveNow();
		}

		harness.resolver.resetFailures(TAB_ID);
		harness.respondWith(async () => ({ ok: true, text: MASTER_PLAYLIST }));
		await harness.resolveNow();

		expect(await harness.find(HLS_URL)).toMatchObject({ manifestResolved: true });
	});

	it('ページを開き直せば試行回数はリセットされる', async () => {
		const harness = createHarness();
		harness.respondWith(networkFailure);
		await harness.detect(HLS_URL);
		for (let i = 0; i < 5; i += 1) {
			harness.advance(PAST_RETRY_INTERVAL);
			await harness.resolveNow();
		}

		await harness.registry.clearTab(TAB_ID);
		await harness.detect(HLS_URL);

		expect(harness.requested).toHaveLength(4);
	});

	it('タブあたりの再試行総数に上限がある', async () => {
		// 1 件あたりの上限だけでは、URL を並べられると総量が抑えられない
		const harness = createHarness();
		harness.respondWith(networkFailure);

		for (let i = 0; i < 26; i += 1) {
			await harness.registry.register(
				input(`https://example.com/video/${i}.m3u8`),
				harness.registry.currentGeneration(TAB_ID),
			);
		}
		await harness.resolveNow();

		const firstAttempts = harness.requested.length;
		for (let i = 0; i < 3; i += 1) {
			harness.advance(PAST_RETRY_INTERVAL);
			await harness.resolveNow();
		}

		expect(firstAttempts).toBe(26);
		// 初回 26 件 + 再試行 50 件（タブあたりの上限）
		expect(harness.requested).toHaveLength(76);
	});
});

describe('再試行しない失敗', () => {
	it('マニフェストとして解析できなければ打ち切る', async () => {
		const harness = createHarness();
		harness.respondWith(async () => ({ ok: true, text: '<html>not a playlist</html>' }));
		await harness.detect(HLS_URL);
		harness.advance(PAST_RETRY_INTERVAL);
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
		harness.advance(PAST_RETRY_INTERVAL);
		await harness.resolveNow();

		expect(harness.requested).toHaveLength(1);
		const media = await harness.find(HLS_URL);
		expect(media?.manifestResolved).toBe(true);
		expect(media?.unsupportedReason).toMatch(/大きすぎます/);
	});
});

describe('保存に失敗したとき', () => {
	it('取得中のまま固定せず、次の契機で再試行する', async () => {
		// storage のクォータ超過などで enrich が投げる。ここで取得中のまま残すと
		// `resetFailures` の対象にもならず、ページを開き直すまで
		// 「画質を確認しています…」から復帰できない
		const harness = createHarness();
		// 1 回目は検出結果の登録。2 回目（解析結果の反映）を失敗させる
		harness.failSaveAtCall(2);

		await harness.registry.register(input(HLS_URL), harness.registry.currentGeneration(TAB_ID));
		await harness.settle();
		expect(harness.requested).toHaveLength(1);

		harness.advance(PAST_RETRY_INTERVAL);
		await harness.resolveNow();

		expect(harness.requested).toHaveLength(2);
		expect(await harness.find(HLS_URL)).toMatchObject({ manifestResolved: true });
	});
});

describe('ページ遷移との競合', () => {
	it('取得中に遷移したら残りの項目へ進まない', async () => {
		// 逐次ループの打ち切りだけを見たいので、検出ごとの再入は切る
		const harness = createHarness({ autoResolve: false });
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

	it('遷移前の取得が、遷移後に始まった取得の状態を壊さない', async () => {
		// 壊すと同じ URL への取得が二重に走る
		const harness = createHarness();
		const first = deferred<FetchTextResult>();
		const firstStarted = deferred<void>();
		const second = deferred<FetchTextResult>();
		const secondStarted = deferred<void>();

		harness.respondWith(async () => {
			if (harness.requested.length === 1) {
				firstStarted.resolve();
				return first.promise;
			}
			if (harness.requested.length === 2) {
				secondStarted.resolve();
				return second.promise;
			}
			return { ok: true, text: MASTER_PLAYLIST };
		});

		await harness.registry.register(input(HLS_URL), harness.registry.currentGeneration(TAB_ID));
		const beforeReload = harness.resolveNow();
		await firstStarted.promise;

		// 再読み込み後、同じ URL を検出して 2 本目の取得が始まる
		await harness.registry.clearTab(TAB_ID);
		await harness.registry.register(input(HLS_URL), harness.registry.currentGeneration(TAB_ID));
		const afterReload = harness.resolveNow();
		await secondStarted.promise;

		// 遅れて 1 本目が完了する。ここで 2 本目の「取得中」を消してしまうと…
		first.resolve({ ok: true, text: MASTER_PLAYLIST });
		await beforeReload;

		// …次の契機で 3 本目の取得が始まってしまう
		const duringSecond = harness.resolveNow();

		second.resolve({ ok: true, text: MASTER_PLAYLIST });
		await afterReload;
		await duringSecond;

		expect(harness.requested).toHaveLength(2);
		expect(await harness.find(HLS_URL)).toMatchObject({ manifestResolved: true });
	});
});
