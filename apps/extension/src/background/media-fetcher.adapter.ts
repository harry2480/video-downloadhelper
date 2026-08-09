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

/**
 * 上限を超えない範囲で本文を読む。
 *
 * **`response.text()` を使わないこと。** 本文全体をメモリへ読み込んでから
 * 返るため、読み終えた後に大きさを判定しても手遅れになる。Content-Length を
 * 返さない応答や、圧縮後のサイズだけが小さい応答では事前チェックも働かない。
 *
 * バイト数で数えることも重要。文字列長は UTF-16 コードユニット数であって
 * バイト数ではない。
 */
async function readTextWithinLimit(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
	if (body === null) return { ok: true, text: '' };

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value === undefined) continue;

		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return { ok: false };
		}
		chunks.push(value);
	}

	// 連結してから一度に復号する。チャンク境界でマルチバイト文字が
	// 割れていても正しく戻る
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return { ok: true, text: new TextDecoder().decode(merged) };
}

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

				if (!response.ok) return { ok: false, reason: 'http-error', status: response.status };

				// 明らかに大きいものは読む前に弾く。ただしこれだけに頼らない
				const declaredLength = Number(response.headers.get('content-length'));
				if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
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
