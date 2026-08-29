import { describe, expect, it } from 'vitest';
import type { SegmentFetcherPort } from '../shared/ports/segment-fetcher.port';
import { err, ok } from '../shared/utils';
import { downloadSegments, totalByteLength } from './segment-download';

/**
 * 取得制御は Port の実装を差し替えれば Node.js 上で検証できる。
 *
 * ここで押さえるのは「順序が狂わないこと」「同時接続数を守ること」
 * 「諦めどきを間違えないこと」。連結して 1 本の動画にする以上、
 * 順序の乱れは即座に壊れたファイルになる。
 */

function bytes(size: number, fill: number): Uint8Array<ArrayBuffer> {
	return new Uint8Array(new ArrayBuffer(size)).fill(fill);
}

/**
 * 取得の遅さを URL ごとに変えられる Fake。
 *
 * 同時接続数の検証のため、走行中の本数の最大値を記録する。
 */
function createFetcher(options: { delays?: Record<string, number>; fail?: Set<string> } = {}) {
	const requested: string[] = [];
	let running = 0;
	let peak = 0;

	const fetcher: SegmentFetcherPort = {
		async fetchBytes(url) {
			requested.push(url);
			running += 1;
			peak = Math.max(peak, running);

			const delay = options.delays?.[url] ?? 0;
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

			running -= 1;

			if (options.fail?.has(url)) return err({ reason: 'network' as const });

			// URL の末尾の数字で中身を区別できるようにする
			const marker = Number(url.match(/(\d+)/)?.[1] ?? 0);
			return ok(bytes(4, marker));
		},
	};

	return { fetcher, requested, peak: () => peak };
}

const urls = (count: number) =>
	Array.from({ length: count }, (_, index) => `https://cdn.example.com/seg${index}.ts`);

describe('downloadSegments', () => {
	it('取得したセグメントを元の順に並べる', async () => {
		// 遅い順に返ってくる状況を作る。完了順に並べる実装なら壊れる
		const { fetcher } = createFetcher({
			delays: {
				'https://cdn.example.com/seg0.ts': 30,
				'https://cdn.example.com/seg1.ts': 10,
				'https://cdn.example.com/seg2.ts': 0,
			},
		});

		const result = await downloadSegments({ urls: urls(3), fetcher, maxBytes: 1_000 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.map((part) => part[0])).toEqual([0, 1, 2]);
	});

	it('同時接続数を超えて取りにいかない', async () => {
		const { fetcher, peak } = createFetcher({
			delays: Object.fromEntries(urls(8).map((url) => [url, 10])),
		});

		await downloadSegments({ urls: urls(8), fetcher, maxBytes: 1_000, concurrency: 2 });

		expect(peak()).toBeLessThanOrEqual(2);
	});

	it('セグメント数が同時接続数より少なくても取得できる', async () => {
		const { fetcher, requested } = createFetcher();

		const result = await downloadSegments({
			urls: urls(2),
			fetcher,
			maxBytes: 1_000,
			concurrency: 6,
		});

		expect(result.ok).toBe(true);
		expect(requested).toHaveLength(2);
	});

	it('進捗を本数と累計バイト数で伝える', async () => {
		const { fetcher } = createFetcher();
		const progress: { completed: number; bytes: number }[] = [];

		await downloadSegments({
			urls: urls(3),
			fetcher,
			maxBytes: 1_000,
			concurrency: 1,
			onProgress: (completed, bytes) => progress.push({ completed, bytes }),
		});

		expect(progress).toEqual([
			{ completed: 1, bytes: 4 },
			{ completed: 2, bytes: 8 },
			{ completed: 3, bytes: 12 },
		]);
	});

	it('取得に失敗したら何本目かを添えて返す', async () => {
		const { fetcher } = createFetcher({ fail: new Set(['https://cdn.example.com/seg1.ts']) });

		const result = await downloadSegments({
			urls: urls(3),
			fetcher,
			maxBytes: 1_000,
			concurrency: 1,
		});

		expect(result).toEqual({
			ok: false,
			error: { type: 'fetch-failed', index: 1, failure: { reason: 'network' } },
		});
	});

	it('失敗したら残りを取りにいかない', async () => {
		// 失敗が分かった後も取り続けると、無駄な通信で配信側に負荷をかける
		const { fetcher, requested } = createFetcher({
			fail: new Set(['https://cdn.example.com/seg0.ts']),
		});

		await downloadSegments({ urls: urls(10), fetcher, maxBytes: 1_000, concurrency: 1 });

		expect(requested).toHaveLength(1);
	});

	it('並行して走っている取得も失敗が分かった時点で降りる', async () => {
		// 失敗が確定した後も取り続けると、無駄な通信で配信側に負荷をかける
		const { fetcher, requested } = createFetcher({
			fail: new Set(['https://cdn.example.com/seg0.ts']),
			delays: {
				'https://cdn.example.com/seg1.ts': 20,
				'https://cdn.example.com/seg2.ts': 20,
			},
		});

		const result = await downloadSegments({
			urls: urls(9),
			fetcher,
			maxBytes: 1_000,
			concurrency: 3,
		});

		expect(result.ok).toBe(false);
		// 走り出していた 3 本で止まる
		expect(requested).toHaveLength(3);
	});

	it('合計が上限を超えたら打ち切る', async () => {
		// Blob 組み立て方式のため、際限なく積むとメモリを食い潰す
		const { fetcher } = createFetcher();

		const result = await downloadSegments({
			urls: urls(5),
			fetcher,
			maxBytes: 7,
			concurrency: 1,
		});

		expect(result).toEqual({ ok: false, error: { type: 'too-large', limitBytes: 7 } });
	});

	it('中止されたら取得を止める', async () => {
		const { fetcher, requested } = createFetcher();
		let cancelled = false;

		const result = await downloadSegments({
			urls: urls(10),
			fetcher,
			maxBytes: 1_000,
			concurrency: 1,
			onProgress: () => {
				cancelled = true;
			},
			isCancelled: () => cancelled,
		});

		expect(result).toEqual({ ok: false, error: { type: 'cancelled' } });
		expect(requested).toHaveLength(1);
	});

	it('セグメントが 0 本なら空で返す', async () => {
		const { fetcher, requested } = createFetcher();

		const result = await downloadSegments({ urls: [], fetcher, maxBytes: 1_000 });

		expect(result).toEqual({ ok: true, value: [] });
		expect(requested).toHaveLength(0);
	});
});

describe('totalByteLength', () => {
	it('合計バイト数を返す', () => {
		expect(totalByteLength([bytes(3, 1), bytes(5, 2)])).toBe(8);
	});

	it('空なら 0 を返す', () => {
		expect(totalByteLength([])).toBe(0);
	});
});
