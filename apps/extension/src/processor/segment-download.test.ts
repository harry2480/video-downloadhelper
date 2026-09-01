import { describe, expect, it } from 'vitest';
import type { DecryptorPort } from '../shared/ports/decryptor.port';
import type { SegmentFetcherPort, SegmentFetchOptions } from '../shared/ports/segment-fetcher.port';
import { err, ok } from '../shared/utils';
import type { PlannedSegment } from './download-plan';
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
	const ranges: (SegmentFetchOptions['range'] | undefined)[] = [];
	const limits: (number | undefined)[] = [];
	let running = 0;
	let peak = 0;

	const fetcher: SegmentFetcherPort = {
		async fetchBytes(url, fetchOptions) {
			requested.push(url);
			ranges.push(fetchOptions?.range);
			limits.push(fetchOptions?.maxBytes);
			running += 1;
			peak = Math.max(peak, running);

			const delay = options.delays?.[url] ?? 0;
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

			running -= 1;

			if (options.fail?.has(url)) return err({ reason: 'network' as const });

			// 鍵は AES-128 の 16 バイト。短い鍵を返す経路も試せるようにする
			if (url.includes('key') && !url.includes('short')) return ok(bytes(16, 0xa5));

			// URL の末尾の数字で中身を区別できるようにする
			const marker = Number(url.match(/(\d+)/)?.[1] ?? 0);
			return ok(bytes(4, marker));
		},
	};

	return { fetcher, requested, ranges, limits, peak: () => peak };
}

const urls = (count: number) =>
	Array.from({ length: count }, (_, index) => `https://cdn.example.com/seg${index}.ts`);

/** 平文のセグメント一覧。既存の検証はこの形で足りる。 */
const plain = (count: number): PlannedSegment[] => urls(count).map((url) => ({ url }));

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

		const result = await downloadSegments({ segments: plain(3), fetcher, maxBytes: 1_000 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.map((part) => part[0])).toEqual([0, 1, 2]);
	});

	it('同時接続数を超えて取りにいかない', async () => {
		const { fetcher, peak } = createFetcher({
			delays: Object.fromEntries(urls(8).map((url) => [url, 10])),
		});

		await downloadSegments({ segments: plain(8), fetcher, maxBytes: 1_000, concurrency: 2 });

		expect(peak()).toBeLessThanOrEqual(2);
	});

	it('セグメント数が同時接続数より少なくても取得できる', async () => {
		const { fetcher, requested } = createFetcher();

		const result = await downloadSegments({
			segments: plain(2),
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
			segments: plain(3),
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
			segments: plain(3),
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

		await downloadSegments({ segments: plain(10), fetcher, maxBytes: 1_000, concurrency: 1 });

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
			segments: plain(9),
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
			segments: plain(5),
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
			segments: plain(10),
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

		const result = await downloadSegments({ segments: [], fetcher, maxBytes: 1_000 });

		expect(result).toEqual({ ok: true, value: [] });
		expect(requested).toHaveLength(0);
	});
});

describe('バイトレンジ', () => {
	it('範囲を Port へそのまま渡す', async () => {
		// 1 つのファイルを複数セグメントで共有する。範囲を落とすと
		// 同じ内容を繰り返した壊れたファイルになる
		const { fetcher, requested, ranges } = createFetcher();

		await downloadSegments({
			segments: [
				{ url: 'https://cdn.example.com/all.ts', byteRange: { length: 100, offset: 0 } },
				{ url: 'https://cdn.example.com/all.ts', byteRange: { length: 120, offset: 100 } },
			],
			fetcher,
			maxBytes: 1_000,
			concurrency: 1,
		});

		expect(requested).toEqual(['https://cdn.example.com/all.ts', 'https://cdn.example.com/all.ts']);
		expect(ranges).toEqual([
			{ offset: 0, length: 100 },
			{ offset: 100, length: 120 },
		]);
	});

	it('1 本ぶんの上限を Port へ渡す', async () => {
		// SegmentBase の DASH は 1 ファイルで全体を成す。セグメント 1 本ぶんの
		// 上限では大きな動画が必ず失敗する
		const { fetcher, limits } = createFetcher();

		await downloadSegments({
			segments: [{ url: 'https://cdn.example.com/whole.mp4', maxBytes: 2_000 }],
			fetcher,
			maxBytes: 10_000,
		});

		expect(limits).toEqual([2_000]);
	});

	it('範囲が無ければ渡さない', async () => {
		const { fetcher, ranges } = createFetcher();

		await downloadSegments({ segments: plain(1), fetcher, maxBytes: 1_000 });

		expect(ranges).toEqual([undefined]);
	});
});

describe('AES-128 の復号', () => {
	const KEY_URL = 'https://cdn.example.com/key.bin';
	const iv = () => new Uint8Array(new ArrayBuffer(16));

	function createDecryptor(options: { fail?: boolean } = {}) {
		const calls: { data: number; key: number }[] = [];

		const decryptor: DecryptorPort = {
			async decryptAesCbc(data, key) {
				calls.push({ data: data[0] ?? -1, key: key[0] ?? -1 });
				if (options.fail === true) return err({ reason: 'decrypt-failed' as const });

				// 復号したことが分かるよう中身を変える
				return ok(new Uint8Array(new ArrayBuffer(2)).fill(0xff));
			},
		};

		return { decryptor, calls };
	}

	function encrypted(count: number): PlannedSegment[] {
		return urls(count).map((url) => ({ url, decryption: { keyUrl: KEY_URL, iv: iv() } }));
	}

	it('鍵を取得して復号した結果を並べる', async () => {
		const { fetcher } = createFetcher();
		const { decryptor, calls } = createDecryptor();

		const result = await downloadSegments({
			segments: encrypted(2),
			fetcher,
			decryptor,
			maxBytes: 1_000,
			concurrency: 1,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.map((part) => part[0])).toEqual([0xff, 0xff]);
		expect(calls).toHaveLength(2);
	});

	it('鍵の取得に 16 バイトの上限を渡す', async () => {
		// 読み切ってから長さを見ると、巨大な応答を返す鍵 URL で
		// メモリを食い潰される
		const { fetcher, requested, limits } = createFetcher();
		const { decryptor } = createDecryptor();

		await downloadSegments({ segments: encrypted(1), fetcher, decryptor, maxBytes: 1_000 });

		expect(limits[requested.indexOf(KEY_URL)]).toBe(16);
	});

	it('同じ鍵は 1 回しか取得しない', async () => {
		// セグメント本数ぶん取りに行くと、配信側から見て不自然な量になる
		const { fetcher, requested } = createFetcher();
		const { decryptor } = createDecryptor();

		await downloadSegments({
			segments: encrypted(5),
			fetcher,
			decryptor,
			maxBytes: 1_000,
			concurrency: 3,
		});

		expect(requested.filter((url) => url === KEY_URL)).toHaveLength(1);
	});

	it('鍵を取得できなければ失敗にする', async () => {
		const { fetcher } = createFetcher({ fail: new Set([KEY_URL]) });
		const { decryptor } = createDecryptor();

		const result = await downloadSegments({
			segments: encrypted(1),
			fetcher,
			decryptor,
			maxBytes: 1_000,
		});

		expect(result).toEqual({
			ok: false,
			error: { type: 'key-failed', index: 0, failure: { reason: 'network' } },
		});
	});

	it('鍵の長さが 16 バイトでなければ復号しない', async () => {
		// AES-128 の鍵として使えない長さ。復号を試みる前に落とす
		const { fetcher } = createFetcher();
		const { decryptor, calls } = createDecryptor();

		const result = await downloadSegments({
			segments: [
				{
					url: urls(1)[0] as string,
					decryption: { keyUrl: 'https://cdn.example.com/short-key.bin', iv: iv() },
				},
			],
			fetcher,
			decryptor,
			maxBytes: 1_000,
		});

		expect(result).toEqual({ ok: false, error: { type: 'decrypt-failed', index: 0 } });
		expect(calls).toHaveLength(0);
	});

	it('復号に失敗したら暗号文を返さない', async () => {
		const { fetcher } = createFetcher();
		const { decryptor } = createDecryptor({ fail: true });

		const result = await downloadSegments({
			segments: [{ url: urls(1)[0] as string, decryption: { keyUrl: KEY_URL, iv: iv() } }],
			fetcher,
			decryptor,
			maxBytes: 1_000,
		});

		expect(result).toEqual({ ok: false, error: { type: 'decrypt-failed', index: 0 } });
	});

	it('復号器が無ければ暗号文を平文として返さない', async () => {
		// ここで通してしまうと、再生できないファイルが「保存できた」として残る
		const { fetcher } = createFetcher();

		const result = await downloadSegments({
			segments: encrypted(1),
			fetcher,
			maxBytes: 1_000,
		});

		expect(result).toEqual({ ok: false, error: { type: 'decrypt-failed', index: 0 } });
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
