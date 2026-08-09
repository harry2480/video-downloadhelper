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
};

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
			const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
			const resolved = path.resolve(FIXTURES_DIR, `.${requestPath}`);

			// フィクスチャディレクトリの外を読ませない
			if (!resolved.startsWith(FIXTURES_DIR)) {
				response.writeHead(403).end('forbidden');
				return;
			}

			try {
				const body = await readFile(resolved);
				const contentType = CONTENT_TYPES[path.extname(resolved)] ?? 'application/octet-stream';
				response.writeHead(200, {
					'content-type': contentType,
					'content-length': String(body.byteLength),
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
