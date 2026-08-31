/**
 * 応答本文の読み取り。
 *
 * **`response.text()` を使わないこと。** 本文全体をメモリへ読み込んでから
 * 返るため、読み終えた後に大きさを判定しても手遅れになる。Content-Length を
 * 返さない応答や、圧縮後のサイズだけが小さい応答では事前チェックも働かない。
 *
 * バイト数で数えることも重要。文字列長は UTF-16 コードユニット数であって
 * バイト数ではない。
 */

/**
 * 読まない本文を捨てる。
 *
 * 早期 return で本文を放置すると、ストリームと接続が GC まで解放されない。
 * 検出のたびに再フェッチする経路では積み上がる。
 *
 * **cancel 自体の失敗で呼び出し側の結果を塗り替えないこと。** try の中で
 * 素の `body.cancel()` を待つと、既にエラーになっているストリームで例外が
 * 飛び、`http-error` が `network` にすり替わる。
 */
export async function discardBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
	try {
		await body?.cancel();
	} catch {
		// 既に壊れているストリーム。捨てるという目的は果たされている
	}
}

/**
 * 上限を超えない範囲で本文をテキストとして読む。
 *
 * 上限を超えた時点で読み取りを打ち切り、失敗として返す。
 */
export async function readTextWithinLimit(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
	if (body === null) return { ok: true, text: '' };

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	for (;;) {
		// 分割代入で受けると done による絞り込みが効かず、value が
		// undefined になり得る型のままになる
		const result = await reader.read();
		if (result.done) break;

		const value = result.value;
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

/**
 * 上限を超えない範囲で本文をバイト列として読む。
 *
 * **`response.arrayBuffer()` を使わないこと。** Content-Length を返さない応答では
 * 本文全体を確保してから返るため、確保後に大きさを判定しても手遅れになる。
 */
export async function readBytesWithinLimit(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false }> {
	if (body === null) return { ok: true, bytes: new Uint8Array(new ArrayBuffer(0)) };

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	for (;;) {
		const result = await reader.read();
		if (result.done) break;

		const value = result.value;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return { ok: false };
		}
		chunks.push(value);
	}

	const merged = new Uint8Array(new ArrayBuffer(total));
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return { ok: true, bytes: merged };
}
