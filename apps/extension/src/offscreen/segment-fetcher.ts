import type { SegmentFetcherPort } from '../shared/ports/segment-fetcher.port';
import { err, ok } from '../shared/utils';

/**
 * セグメント取得の実装。
 *
 * `credentials: 'include'` を指定する。マニフェスト再フェッチと同じ理由で、
 * Cookie 付きで配信されるセグメントは付けないと 403 になる
 * （`background/media-fetcher.adapter.ts` を参照）。
 *
 * 取得した内容は保存にのみ使い、外部へ送信しない（要件定義 12 章）。
 */

/** 1 セグメントの上限。TS セグメントは通常 10 秒で数 MB に収まる。 */
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

/** 応答が返らないまま待ち続けないための上限。 */
const TIMEOUT_MS = 30_000;

type OffscreenFetcher = SegmentFetcherPort & {
	/** マニフェストの取得。Media Playlist を読むために使う */
	fetchText: (url: string) => Promise<{ ok: true; text: string } | { ok: false }>;
};

/** テストでは fetch を差し替える。 */
export function createSegmentFetcher(fetchImpl: typeof fetch = fetch): OffscreenFetcher {
	async function request(url: string): Promise<Response> {
		return fetchImpl(url, {
			credentials: 'include',
			redirect: 'follow',
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	}

	return {
		async fetchBytes(url) {
			try {
				const response = await request(url);
				if (!response.ok) {
					// ボディを捨てて接続を解放する。読まないまま放置しない
					await response.body?.cancel();
					return err({ reason: 'http-error', status: response.status });
				}

				const declared = Number(response.headers.get('content-length'));
				if (Number.isFinite(declared) && declared > MAX_SEGMENT_BYTES) {
					await response.body?.cancel();
					return err({ reason: 'too-large' });
				}

				const buffer = await response.arrayBuffer();
				if (buffer.byteLength > MAX_SEGMENT_BYTES) return err({ reason: 'too-large' });

				return ok(new Uint8Array(buffer));
			} catch {
				// タイムアウト・DNS・CORS 等
				return err({ reason: 'network' });
			}
		},

		async fetchText(url) {
			try {
				const response = await request(url);
				if (!response.ok) {
					await response.body?.cancel();
					return { ok: false };
				}
				return { ok: true, text: await response.text() };
			} catch {
				return { ok: false };
			}
		},
	};
}
