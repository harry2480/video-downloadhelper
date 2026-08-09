import type { FetchTextResult, MediaFetcherPort } from '../shared/ports/media-fetcher.port';

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

export function createMediaFetcher(): MediaFetcherPort {
	return {
		async fetchText(url: string): Promise<FetchTextResult> {
			try {
				const response = await fetch(url, {
					credentials: 'include',
					redirect: 'follow',
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});

				if (!response.ok) return { ok: false, reason: 'http-error', status: response.status };

				const declaredLength = Number(response.headers.get('content-length'));
				if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
					return { ok: false, reason: 'too-large' };
				}

				const text = await response.text();
				// Content-Length を返さないサーバーがあるため、本文でも確かめる
				if (text.length > MAX_MANIFEST_BYTES) return { ok: false, reason: 'too-large' };

				return { ok: true, text };
			} catch {
				// タイムアウト・DNS・CORS 等。理由の細分化はユーザーへの表示に寄与しない
				return { ok: false, reason: 'network' };
			}
		},
	};
}
