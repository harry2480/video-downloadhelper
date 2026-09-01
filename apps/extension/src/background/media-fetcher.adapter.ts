import type { FetchTextResult, MediaFetcherPort } from '../shared/ports/media-fetcher.port';
import { discardBody, readTextWithinLimit } from '../shared/stream';

/**
 * マニフェスト再フェッチの実装。
 *
 * `credentials: 'include'` を指定する。ページが取得できたマニフェストは
 * Cookie 付きで配信されていることがあり、付けないと 403 になる。
 * ホスト権限があるため送信でき、これはページが行ったのと同じリクエスト。
 *
 * 取得した内容は解析にのみ使い、外部へ送信しない（要件定義 12 章）。
 */

/** マニフェストとして妥当な上限。超える場合は取り違えの可能性が高い。 */
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

/** 応答が返らないまま待ち続けないための上限。 */
const TIMEOUT_MS = 10_000;

/** テストでは fetch を差し替える。 */
export function createMediaFetcher(fetchImpl: typeof fetch = fetch): MediaFetcherPort {
	return {
		async fetchText(url: string): Promise<FetchTextResult> {
			try {
				const response = await fetchImpl(url, {
					credentials: 'include',
					redirect: 'follow',
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});

				if (!response.ok) {
					await discardBody(response.body);
					return { ok: false, reason: 'http-error', status: response.status };
				}

				// 明らかに大きいものは読む前に弾く。ただしこれだけに頼らない
				const declaredLength = Number(response.headers.get('content-length'));
				if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
					await discardBody(response.body);
					return { ok: false, reason: 'too-large' };
				}

				const read = await readTextWithinLimit(response.body, MAX_MANIFEST_BYTES);
				if (!read.ok) return { ok: false, reason: 'too-large' };

				return { ok: true, text: read.text };
			} catch {
				// タイムアウト・DNS・CORS 等。理由の細分化はユーザーへの表示に寄与しない
				return { ok: false, reason: 'network' };
			}
		},
	};
}
