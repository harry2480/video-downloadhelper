import { describe, expect, it } from 'vitest';
import { createMediaFetcher } from './media-fetcher.adapter';

/**
 * fetch を差し替えられるため Node.js 上で検証できる。
 *
 * サイズ制限は「読み終えてから判定する」と意味がないため、
 * Content-Length のない応答での挙動を重点的に確認する。
 */

const MAX_BYTES = 5 * 1024 * 1024;

/** cancel されたことを観測できる Response を作る。 */
function cancellableResponse(options: {
	status?: number;
	contentLength?: string;
	onCancel?: () => void;
	cancelThrows?: boolean;
}): { response: Response; wasCancelled: () => boolean } {
	let cancelled = false;

	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			// 読み切られない本文。捨てていなければ開いたまま残る
			controller.enqueue(new Uint8Array(16).fill(0x41));
		},
		cancel() {
			cancelled = true;
			options.onCancel?.();
			if (options.cancelThrows === true) throw new Error('cancel failed');
		},
	});

	const headers = new Headers();
	if (options.contentLength !== undefined) headers.set('content-length', options.contentLength);

	return {
		response: new Response(stream, { status: options.status ?? 200, headers }),
		wasCancelled: () => cancelled,
	};
}

/** 指定バイト列をチャンクに分けて返す Response を作る。 */
function streamedResponse(
	bytes: Uint8Array,
	options: { chunkSize?: number; contentLength?: string | null; status?: number } = {},
): Response {
	const chunkSize = options.chunkSize ?? 64 * 1024;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
				controller.enqueue(bytes.slice(offset, offset + chunkSize));
			}
			controller.close();
		},
	});

	const headers = new Headers();
	if (options.contentLength !== null) {
		headers.set('content-length', options.contentLength ?? String(bytes.byteLength));
	}

	return new Response(stream, { status: options.status ?? 200, headers });
}

function fetcherReturning(response: Response | (() => never)) {
	return createMediaFetcher((async () => {
		if (typeof response === 'function') response();
		return response;
	}) as typeof fetch);
}

describe('fetchText', () => {
	it('マニフェストを文字列として返す', async () => {
		const body = new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n');
		const fetcher = fetcherReturning(streamedResponse(body));

		expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
			ok: true,
			text: '#EXTM3U\n#EXT-X-VERSION:3\n',
		});
	});

	it('2xx 以外は http-error として返す', async () => {
		const fetcher = fetcherReturning(
			streamedResponse(new Uint8Array(0), { status: 403, contentLength: null }),
		);

		expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
			ok: false,
			reason: 'http-error',
			status: 403,
		});
	});

	it('通信に失敗したら network として返す', async () => {
		const fetcher = fetcherReturning(() => {
			throw new TypeError('failed to fetch');
		});

		expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
			ok: false,
			reason: 'network',
		});
	});

	it('本文がない応答を空文字として扱う', async () => {
		const fetcher = createMediaFetcher(
			(async () => new Response(null, { status: 200 })) as typeof fetch,
		);

		expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
			ok: true,
			text: '',
		});
	});

	describe('読まない本文の破棄', () => {
		it('HTTP エラーなら本文を捨てる', async () => {
			// 読まないまま放置すると、ストリームと接続が GC まで解放されない。
			// 検出のたびに再フェッチする経路なので積み上がる
			const { response, wasCancelled } = cancellableResponse({ status: 403 });
			const fetcher = fetcherReturning(response);

			expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
				ok: false,
				reason: 'http-error',
				status: 403,
			});
			expect(wasCancelled()).toBe(true);
		});

		it('Content-Length で弾いたときも本文を捨てる', async () => {
			const { response, wasCancelled } = cancellableResponse({
				contentLength: String(MAX_BYTES + 1),
			});
			const fetcher = fetcherReturning(response);

			expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
				ok: false,
				reason: 'too-large',
			});
			expect(wasCancelled()).toBe(true);
		});

		it('破棄自体が失敗しても理由をすり替えない', async () => {
			// 素の body.cancel() を try の中で待つと、既に壊れている
			// ストリームで例外が飛び、http-error が network になる
			const { response } = cancellableResponse({ status: 500, cancelThrows: true });
			const fetcher = fetcherReturning(response);

			expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
				ok: false,
				reason: 'http-error',
				status: 500,
			});
		});
	});

	describe('サイズ上限', () => {
		it('Content-Length が上限を超えていれば読まずに弾く', async () => {
			const body = new TextEncoder().encode('#EXTM3U');
			const fetcher = fetcherReturning(
				streamedResponse(body, { contentLength: String(MAX_BYTES + 1) }),
			);

			expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
				ok: false,
				reason: 'too-large',
			});
		});

		it('Content-Length がなくても本文のバイト数で弾く', async () => {
			// 圧縮応答や chunked では Content-Length が当てにならない。
			// 読みながら数えないと上限が機能しない
			const body = new Uint8Array(MAX_BYTES + 1024).fill(0x41);
			const fetcher = fetcherReturning(streamedResponse(body, { contentLength: null }));

			expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
				ok: false,
				reason: 'too-large',
			});
		});

		it('上限を超えた時点で読み込みを打ち切る', async () => {
			let enqueued = 0;
			let cancelled = false;

			// 上限の 4 倍まで流せるようにしておく。打ち切っていなければ
			// 全部読み込んでしまい cancel されない
			const maxChunks = 20;
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (enqueued >= maxChunks) {
						controller.close();
						return;
					}
					enqueued += 1;
					controller.enqueue(new Uint8Array(1024 * 1024).fill(0x41));
				},
				cancel() {
					cancelled = true;
				},
			});
			const fetcher = createMediaFetcher(
				(async () => new Response(stream, { status: 200 })) as typeof fetch,
			);

			expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
				ok: false,
				reason: 'too-large',
			});
			expect(cancelled).toBe(true);
			// 無限に生成されるストリームでも 6MB 程度で止まる
			expect(enqueued).toBeLessThan(10);
		});

		it('上限ちょうどは通す', async () => {
			const body = new Uint8Array(MAX_BYTES).fill(0x41);
			const fetcher = fetcherReturning(streamedResponse(body, { contentLength: null }));

			const result = await fetcher.fetchText('https://cdn.example.com/v.m3u8');
			expect(result.ok).toBe(true);
		});
	});

	describe('マルチバイト文字', () => {
		it('チャンク境界で割れても正しく復号する', async () => {
			// 「あ」は UTF-8 で 3 バイト。1 バイトずつ流して境界を跨がせる
			const text = '#EXTM3U\n#あいうえお\n';
			const body = new TextEncoder().encode(text);
			const fetcher = fetcherReturning(streamedResponse(body, { chunkSize: 1 }));

			expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
				ok: true,
				text,
			});
		});

		it('文字数ではなくバイト数で判定する', async () => {
			// 3 バイト文字が上限を超える数だけあれば、文字数が上限未満でも弾く
			const characters = Math.floor(MAX_BYTES / 3) + 10;
			const body = new TextEncoder().encode('あ'.repeat(characters));
			expect(body.byteLength).toBeGreaterThan(MAX_BYTES);

			const fetcher = fetcherReturning(streamedResponse(body, { contentLength: null }));

			expect(await fetcher.fetchText('https://cdn.example.com/v.m3u8')).toEqual({
				ok: false,
				reason: 'too-large',
			});
		});
	});
});
