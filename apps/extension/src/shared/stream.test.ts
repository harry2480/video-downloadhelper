import { describe, expect, it } from 'vitest';
import { readTextWithinLimit } from './stream';

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
