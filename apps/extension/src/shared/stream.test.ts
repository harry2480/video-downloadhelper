import { describe, expect, it } from 'vitest';
import { discardBody, readBytesWithinLimit, readTextWithinLimit } from './stream';

/**
 * マニフェスト取得の入口。上限を超えたものを読み切らないことが要点で、
 * ここを緩めると巨大な応答でメモリを食い潰される。
 */

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

const encode = (text: string) => new TextEncoder().encode(text);

describe('readTextWithinLimit', () => {
	it('本文をテキストとして読む', async () => {
		const read = await readTextWithinLimit(streamOf(encode('#EXTM3U')), 100);

		expect(read).toEqual({ ok: true, text: '#EXTM3U' });
	});

	it('チャンクを跨いだマルチバイト文字を壊さない', async () => {
		// 連結してから復号しないと、境界で割れた文字が化ける
		const bytes = encode('あいう');
		const read = await readTextWithinLimit(streamOf(bytes.subarray(0, 4), bytes.subarray(4)), 100);

		expect(read).toEqual({ ok: true, text: 'あいう' });
	});

	it('上限を超えたら読み切らずに失敗させる', async () => {
		const read = await readTextWithinLimit(streamOf(encode('0123456789')), 5);

		expect(read).toEqual({ ok: false });
	});

	it('本文が無ければ空文字にする', async () => {
		expect(await readTextWithinLimit(null, 100)).toEqual({ ok: true, text: '' });
	});
});

describe('readBytesWithinLimit', () => {
	it('本文をバイト列として読む', async () => {
		const read = await readBytesWithinLimit(streamOf(encode('ab'), encode('cd')), 100);

		expect(read).toEqual({ ok: true, bytes: encode('abcd') });
	});

	it('上限を超えたら確保しきる前に打ち切る', async () => {
		// Content-Length を返さない応答では、確保してから測っても手遅れになる
		let delivered = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				delivered += 1;
				controller.enqueue(new Uint8Array(new ArrayBuffer(4)));
				if (delivered > 100) controller.close();
			},
		});

		const read = await readBytesWithinLimit(stream, 8);

		expect(read).toEqual({ ok: false });
		// 上限ぶんを少し超えた時点で止まる。全部は読まない
		expect(delivered).toBeLessThan(10);
	});

	it('本文が無ければ空にする', async () => {
		const read = await readBytesWithinLimit(null, 100);

		expect(read).toEqual({ ok: true, bytes: new Uint8Array(new ArrayBuffer(0)) });
	});
});

describe('discardBody', () => {
	it('本文を cancel する', async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(encode('x'));
			},
			cancel() {
				cancelled = true;
			},
		});

		await discardBody(body);

		expect(cancelled).toBe(true);
	});

	it('本文が無くても落ちない', async () => {
		await expect(discardBody(null)).resolves.toBeUndefined();
	});

	it('cancel が失敗しても例外を出さない', async () => {
		// 呼び出し側は try の中でこれを待つ。ここで投げると
		// http-error が network にすり替わる
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(encode('x'));
			},
			cancel() {
				throw new Error('cancel failed');
			},
		});

		await expect(discardBody(body)).resolves.toBeUndefined();
	});
});
