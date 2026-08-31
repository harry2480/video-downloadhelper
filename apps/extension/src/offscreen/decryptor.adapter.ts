import type { DecryptorPort } from '../shared/ports/decryptor.port';
import { err, ok } from '../shared/utils';

/**
 * AES-128-CBC の復号（WebCrypto）。
 *
 * HLS の AES-128 は「セグメント全体を AES-128-CBC + PKCS#7 で暗号化する」
 * 方式で、WebCrypto がそのまま扱える。**追加のライブラリを持ち込まない**
 * （リモートコードを実行しない方針。要件定義 12 章）。
 */

const ALGORITHM = 'AES-CBC';

export function createDecryptor(): DecryptorPort {
	return {
		async decryptAesCbc(data, key, iv) {
			try {
				const cryptoKey = await crypto.subtle.importKey(
					'raw',
					// 鍵は使い回さない。取り違えを避けるため毎回 import する
					key.slice().buffer,
					ALGORITHM,
					false,
					['decrypt'],
				);

				// WebCrypto は PKCS#7 のパディングを外して返す
				const decrypted = await crypto.subtle.decrypt(
					{ name: ALGORITHM, iv: iv.slice().buffer },
					cryptoKey,
					data.slice().buffer,
				);

				return ok(new Uint8Array(decrypted));
			} catch {
				// 鍵長・IV 長の誤り、パディング不正、長さが 16 の倍数でない等。
				// 呼び出し側は取得済みの他のセグメントを片付ける必要があるため、
				// 例外ではなく失敗として返す
				return err({ reason: 'decrypt-failed' });
			}
		},
	};
}
