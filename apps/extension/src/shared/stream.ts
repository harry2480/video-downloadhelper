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
