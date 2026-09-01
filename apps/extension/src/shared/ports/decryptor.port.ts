import type { Result } from '../utils';

/**
 * 復号。
 *
 * HLS の AES-128 は「鍵を取得して CBC で復号する」だけだが、暗号演算は
 * 実行環境の API（WebCrypto）に依存する。コアロジック層はこの interface
 * だけを知り、実装は実行コンテキスト層が注入する。
 */

export type DecryptFailure = { reason: 'decrypt-failed' };

export type DecryptorPort = {
	/**
	 * AES-128-CBC で復号する。鍵と IV はいずれも 16 バイト。
	 *
	 * PKCS#7 のパディングは実装側で外す。長さが 16 の倍数でない、
	 * 鍵が違う、といった場合は**例外にせず失敗として返す**。
	 * 途中の 1 本で例外が飛ぶと、取得済みの他のセグメントを解放できない。
	 */
	decryptAesCbc: (
		data: Uint8Array<ArrayBuffer>,
		key: Uint8Array<ArrayBuffer>,
		iv: Uint8Array<ArrayBuffer>,
	) => Promise<Result<Uint8Array<ArrayBuffer>, DecryptFailure>>;
};
