import type { SegmentFetcherPort } from '../shared/ports/segment-fetcher.port';
import { readBytesWithinLimit, readTextWithinLimit } from '../shared/stream';
import { err, isHttpUrl, isPrivateHostUrl, ok } from '../shared/utils';

/**
 * セグメント取得の実装。
 *
 * `credentials: 'include'` を指定する。マニフェスト再フェッチと同じ理由で、
 * Cookie 付きで配信されるセグメントは付けないと 403 になる
 * （`background/media-fetcher.adapter.ts` を参照）。
 *
 * 取得した内容は保存にのみ使い、外部へ送信しない（要件定義 12 章）。
 *
 * **リダイレクトの着地点も確かめる。** 計画の時点で宛先を絞っても、
 * `redirect: 'follow'` のままではリダイレクトでループバックや LAN へ
 * 連れて行かれる。最終 URL が方針から外れていれば結果を捨てる。
 */

/** 1 セグメントの上限。TS セグメントは通常 10 秒で数 MB に収まる。 */
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

/** マニフェストとして妥当な上限。Background 側の再フェッチと揃える。 */
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

/** 応答が返らないまま待ち続けないための上限。 */
const TIMEOUT_MS = 30_000;

type OffscreenFetcher = SegmentFetcherPort & {
	/** マニフェストの取得。Media Playlist を読むために使う */
	fetchText: (url: string) => Promise<{ ok: true; text: string } | { ok: false }>;
};

type FetcherOptions = {
	/** プライベートネットワーク宛を許すか。組み立ての依頼ごとに決まる */
	allowPrivateHosts?: boolean;
	/** テストでは fetch を差し替える */
	fetchImpl?: typeof fetch;
};

export function createSegmentFetcher(options: FetcherOptions = {}): OffscreenFetcher {
	const fetchImpl = options.fetchImpl ?? fetch;

	/** 取得してよい宛先か。リダイレクトの着地点にも同じ物差しを当てる。 */
	function isAllowed(url: string): boolean {
		if (!isHttpUrl(url)) return false;
		return options.allowPrivateHosts === true || !isPrivateHostUrl(url);
	}

	async function request(url: string): Promise<Response | undefined> {
		const response = await fetchImpl(url, {
			credentials: 'include',
			redirect: 'follow',
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});

		// リダイレクトで方針の外へ出ていたら、本文を読まずに捨てる
		if (response.url !== '' && !isAllowed(response.url)) {
			await response.body?.cancel();
			return undefined;
		}

		return response;
	}

	return {
		async fetchBytes(url) {
			if (!isAllowed(url)) return err({ reason: 'network' });

			try {
				const response = await request(url);
				if (response === undefined) return err({ reason: 'network' });

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

				// 読みながら測る。Content-Length を返さない応答では
				// 確保してから測っても手遅れになる
				const read = await readBytesWithinLimit(response.body, MAX_SEGMENT_BYTES);
				if (!read.ok) return err({ reason: 'too-large' });

				return ok(read.bytes);
			} catch {
				// タイムアウト・DNS・CORS 等
				return err({ reason: 'network' });
			}
		},

		async fetchText(url) {
			if (!isAllowed(url)) return { ok: false };

			try {
				const response = await request(url);
				if (response === undefined) return { ok: false };

				if (!response.ok) {
					await response.body?.cancel();
					return { ok: false };
				}

				const declared = Number(response.headers.get('content-length'));
				if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
					await response.body?.cancel();
					return { ok: false };
				}

				// 上限を超えた時点で打ち切る。読み切ってから測っても手遅れになる
				return await readTextWithinLimit(response.body, MAX_MANIFEST_BYTES);
			} catch {
				return { ok: false };
			}
		},
	};
}
