import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** E2E で使うテストページの配信元。 */
export const FIXTURES_DIR = path.resolve(here, '../fixtures/pages');

const CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.m3u8': 'application/vnd.apple.mpegurl',
	'.mpd': 'application/dash+xml',
	'.ts': 'video/mp2t',
	'.m4s': 'video/iso.segment',
	'.m4a': 'audio/mp4',
};

/**
 * `Range: bytes=<start>-<end>` を解析する（両端を含む）。
 *
 * 単一範囲のみ扱う。複数範囲は multipart 応答になり、テストで使う予定がない。
 */
function parseRange(
	header: string | undefined,
	size: number,
): { start: number; end: number } | 'invalid' | undefined {
	if (header === undefined) return undefined;

	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null) return 'invalid';

	const [, startText, endText] = match;
	if (startText === '' && endText === '') return 'invalid';

	// 末尾から N バイト（`bytes=-500`）
	if (startText === '') {
		const suffix = Number(endText);
		if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}

	const start = Number(startText);
	const end = endText === '' ? size - 1 : Number(endText);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
	if (start > end || start >= size) return 'invalid';

	return { start, end: Math.min(end, size - 1) };
}

export type StaticServer = {
	/** 例: http://127.0.0.1:53210 */
	origin: string;
	close: () => Promise<void>;
};

/**
 * テストページを配信するローカル静的サーバーを起動する。
 *
 * E2E / Integration テストは外部ネットワークへ出ない（docs/テストガイドライン.md）。
 * ポートは 0 を指定して OS に空きを割り当てさせ、並列実行時の衝突を避ける。
 */
export async function startStaticServer(): Promise<StaticServer> {
	const server = createServer((request, response) => {
		void (async () => {
			const requestUrl = new URL(request.url ?? '/', 'http://localhost');
			const resolved = path.resolve(FIXTURES_DIR, `.${requestUrl.pathname}`);

			// `?delayMs=N` で応答を遅らせる。
			// 「メタデータ読み込みが後から起きる」順序を確定させるために使う
			const delayMs = Number(requestUrl.searchParams.get('delayMs'));
			if (Number.isFinite(delayMs) && delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 10_000)));
			}

			// フィクスチャディレクトリの外を読ませない
			if (!resolved.startsWith(FIXTURES_DIR)) {
				response.writeHead(403).end('forbidden');
				return;
			}

			try {
				const body = await readFile(resolved);
				const contentType = CONTENT_TYPES[path.extname(resolved)] ?? 'application/octet-stream';

				// **Range に応える。** #EXT-X-BYTERANGE のセグメントは 1 つの
				// ファイルの一部を取りに来る。拡張機能側は 206 でなければ
				// 失敗にするため、200 で全体を返すとその経路を検証できない
				const range = parseRange(request.headers.range, body.byteLength);
				if (range === 'invalid') {
					response
						.writeHead(416, { 'content-range': `bytes */${body.byteLength}` })
						.end('range not satisfiable');
					return;
				}

				if (range !== undefined) {
					const part = body.subarray(range.start, range.end + 1);
					response.writeHead(206, {
						'content-type': contentType,
						'content-length': String(part.byteLength),
						'content-range': `bytes ${range.start}-${range.end}/${body.byteLength}`,
						'accept-ranges': 'bytes',
						'cache-control': 'no-store',
					});
					response.end(part);
					return;
				}

				response.writeHead(200, {
					'content-type': contentType,
					'content-length': String(body.byteLength),
					'accept-ranges': 'bytes',
					// 検出結果のリセット規則を検証するため、キャッシュを効かせない
					'cache-control': 'no-store',
				});
				response.end(body);
			} catch {
				response.writeHead(404).end('not found');
			}
		})();
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	return {
		origin: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
