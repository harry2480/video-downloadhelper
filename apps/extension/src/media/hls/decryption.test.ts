import { describe, expect, it } from 'vitest';
import {
	AES_BLOCK_BYTES,
	ivFromSequenceNumber,
	parseHexIv,
	resolveSegmentDecryption,
} from './decryption';

/**
 * IV を取り違えると、復号は成功したように見えて中身が壊れる。
 * 「揃わないなら undefined を返す」ことが最も重要な性質。
 */

const hex = (bytes: Uint8Array) =>
	[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('parseHexIv', () => {
	it('0x 付きの 32 桁を読む', () => {
		const iv = parseHexIv('0x000102030405060708090a0b0c0d0e0f');

		expect(iv).toBeDefined();
		expect(hex(iv as Uint8Array)).toBe('000102030405060708090a0b0c0d0e0f');
	});

	it('0x が無くても読む', () => {
		expect(parseHexIv('000102030405060708090a0b0c0d0e0f')).toBeDefined();
	});

	it('大文字小文字を問わない', () => {
		expect(hex(parseHexIv('0xABCDEF00000000000000000000000000') as Uint8Array)).toBe(
			'abcdef00000000000000000000000000',
		);
	});

	it('32 桁未満は左を 0 で埋める', () => {
		// RFC 8216 の IV は 128 bit の数値。`IV=0x1` のような短い表記も妥当で、
		// 桁数ちょうどを要求すると正しいプレイリストを弾いてしまう
		expect(hex(parseHexIv('0x1') as Uint8Array)).toBe('00000000000000000000000000000001');
		expect(hex(parseHexIv('0xff') as Uint8Array)).toBe('000000000000000000000000000000ff');
	});

	it('32 桁を超えれば受け取らない', () => {
		// 上位を捨てて通すと、復号できたように見えて中身が壊れる
		expect(parseHexIv('0x000102030405060708090a0b0c0d0e0f00')).toBeUndefined();
	});

	it('16 進以外を含めば受け取らない', () => {
		expect(parseHexIv('0xzz0102030405060708090a0b0c0d0e0f')).toBeUndefined();
	});

	it('空文字を受け取らない', () => {
		expect(parseHexIv('')).toBeUndefined();
	});
});

describe('ivFromSequenceNumber', () => {
	it('16 バイトのビッグエンディアンにする', () => {
		expect(hex(ivFromSequenceNumber(1))).toBe('00000000000000000000000000000001');
		expect(hex(ivFromSequenceNumber(0x0102))).toBe('00000000000000000000000000000102');
	});

	it('0 は全て 0 になる', () => {
		expect(hex(ivFromSequenceNumber(0))).toBe('0'.repeat(AES_BLOCK_BYTES * 2));
	});

	it('大きな番号でも桁が溢れない', () => {
		expect(hex(ivFromSequenceNumber(Number.MAX_SAFE_INTEGER))).toBe(
			'0000000000000000001fffffffffffff',
		);
	});

	it('負の番号や小数でも 16 バイトを返す', () => {
		// BigInt へ渡す前に丸める。例外で落ちると保存全体が止まる
		expect(ivFromSequenceNumber(-1)).toHaveLength(AES_BLOCK_BYTES);
		expect(hex(ivFromSequenceNumber(1.9))).toBe('00000000000000000000000000000001');
	});
});

describe('resolveSegmentDecryption', () => {
	const KEY_URL = 'https://cdn.example.com/key.bin';

	it('鍵が無ければ平文として扱う', () => {
		expect(resolveSegmentDecryption(undefined, 0)).toBeUndefined();
	});

	it('IV があればそれを使う', () => {
		const resolved = resolveSegmentDecryption(
			{ keyUri: KEY_URL, iv: '0x000000000000000000000000000000ff' },
			5,
		);

		expect(resolved?.keyUrl).toBe(KEY_URL);
		expect(hex(resolved?.iv as Uint8Array)).toBe('000000000000000000000000000000ff');
	});

	it('IV が無ければシーケンス番号から導出する', () => {
		const resolved = resolveSegmentDecryption({ keyUri: KEY_URL }, 5);

		expect(resolved?.iv).toEqual(ivFromSequenceNumber(5));
	});

	it('鍵の URI が無ければ復号材料を返さない', () => {
		// 平文として扱うと暗号文をそのまま保存してしまう。
		// 呼び出し側はこれを「保存できない」として扱う
		expect(resolveSegmentDecryption({}, 0)).toBeUndefined();
	});

	it('IV が壊れていれば復号材料を返さない', () => {
		expect(resolveSegmentDecryption({ keyUri: KEY_URL, iv: '0xzz' }, 0)).toBeUndefined();
	});
});
