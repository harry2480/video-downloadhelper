import type { HlsSegmentKey } from './types';

/**
 * AES-128 で暗号化された HLS の復号材料（RFC 8216 5.2）。
 *
 * **鍵の取得も復号も行わない。** ここはプレイリストの記述を
 * 「鍵の URL と 16 バイトの IV」へ翻訳するだけの純粋なロジックで、
 * 通信と暗号演算は Port の実装が担う。
 */

/** AES-128 の鍵長・ブロック長（バイト）。 */
export const AES_BLOCK_BYTES = 16;

/**
 * `0x` 付き 16 進表記の IV をバイト列へ直す。
 *
 * **32 桁未満は左を 0 で埋める。** RFC 8216 の IV は 128 bit の数値であり、
 * `IV=0x1` のような短い表記も妥当。桁数ちょうどを要求すると、正しい
 * プレイリストを「鍵の情報が無い」として弾いてしまう。
 *
 * 16 進以外を含む、32 桁を超える、空、といった値は復号に使えない。
 * 黙って 0 埋めすると、復号できたように見えて中身が壊れる。
 */
export function parseHexIv(value: string): Uint8Array<ArrayBuffer> | undefined {
	const hex = value.trim().replace(/^0x/i, '');
	if (hex.length === 0 || hex.length > AES_BLOCK_BYTES * 2) return undefined;
	if (!/^[0-9a-f]+$/i.test(hex)) return undefined;

	const padded = hex.padStart(AES_BLOCK_BYTES * 2, '0');
	const bytes = new Uint8Array(new ArrayBuffer(AES_BLOCK_BYTES));
	for (let index = 0; index < AES_BLOCK_BYTES; index += 1) {
		bytes[index] = Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

/**
 * メディアシーケンス番号から IV を導出する。
 *
 * IV 属性が無い場合、シーケンス番号を 128 bit のビッグエンディアンとして
 * 使う（RFC 8216 5.2）。番号は 2^53 を超えないため下位 8 バイトで足りる。
 */
export function ivFromSequenceNumber(sequenceNumber: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(new ArrayBuffer(AES_BLOCK_BYTES));
	new DataView(bytes.buffer).setBigUint64(
		AES_BLOCK_BYTES - 8,
		BigInt(Math.max(0, Math.trunc(sequenceNumber))),
	);
	return bytes;
}

/** 計画が持つ復号材料。PlannedSegment からのみ参照する */
type SegmentDecryption = {
	/** 鍵の取得先 */
	keyUrl: string;
	iv: Uint8Array<ArrayBuffer>;
};

/**
 * セグメント 1 本ぶんの復号材料を決める。
 *
 * 鍵の URL が無い、IV が壊れている、といった「復号できない」場合は
 * `undefined` を返す。**呼び出し側はこれを平文として扱ってはいけない。**
 * 保存できるかの判定は `processor/hls-download.ts` が先に行う。
 */
export function resolveSegmentDecryption(
	key: HlsSegmentKey | undefined,
	sequenceNumber: number,
): SegmentDecryption | undefined {
	if (key?.keyUri === undefined) return undefined;

	const iv = key.iv === undefined ? ivFromSequenceNumber(sequenceNumber) : parseHexIv(key.iv);
	if (iv === undefined) return undefined;

	return { keyUrl: key.keyUri, iv };
}
