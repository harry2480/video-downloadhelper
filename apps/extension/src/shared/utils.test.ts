import { describe, expect, it } from 'vitest';
import { type Result, err, isHttpUrl, isOk, isPrivateHostUrl, ok } from './utils';

type ParseError = { type: 'invalid' };

describe('Result', () => {
	it('成功と失敗を同じ型で表現できる', () => {
		const results: Result<number, ParseError>[] = [ok(1), err({ type: 'invalid' })];

		expect(results.filter(isOk).map((r) => r.value)).toEqual([1]);
	});

	describe('ok', () => {
		it('成功値を保持する', () => {
			const result = ok(42);
			expect(result.ok).toBe(true);
			expect(result).toEqual({ ok: true, value: 42 });
		});

		it('undefined も成功値として扱える', () => {
			expect(ok(undefined)).toEqual({ ok: true, value: undefined });
		});
	});

	describe('err', () => {
		it('失敗値を保持する', () => {
			const result = err({ type: 'not-found' });
			expect(result.ok).toBe(false);
			expect(result).toEqual({ ok: false, error: { type: 'not-found' } });
		});
	});

	describe('isOk', () => {
		it('成功のとき true を返す', () => {
			expect(isOk(ok('value'))).toBe(true);
		});

		it('失敗のとき false を返す', () => {
			expect(isOk(err('error'))).toBe(false);
		});
	});
});

describe('isHttpUrl', () => {
	it('http(s) だけを通す', () => {
		expect(isHttpUrl('https://cdn.example.com/v.mp4')).toBe(true);
		expect(isHttpUrl('http://cdn.example.com/v.mp4')).toBe(true);
	});

	it('取得してはいけないスキームを弾く', () => {
		// ページ由来の文字列が URL として流れてくる箇所すべての関門になる
		expect(isHttpUrl('file:///etc/passwd')).toBe(false);
		expect(isHttpUrl('data:video/mp4;base64,AAAA')).toBe(false);
		expect(isHttpUrl('blob:https://example.com/abc')).toBe(false);
		expect(isHttpUrl('filesystem:https://example.com/temp/a')).toBe(false);
		expect(isHttpUrl('javascript:alert(1)')).toBe(false);
		expect(isHttpUrl('/relative/path.ts')).toBe(false);
	});
});

describe('isPrivateHostUrl', () => {
	it('ループバックとプライベートアドレスを見分ける', () => {
		expect(isPrivateHostUrl('http://localhost:8080/a.ts')).toBe(true);
		expect(isPrivateHostUrl('http://127.0.0.1/a.ts')).toBe(true);
		expect(isPrivateHostUrl('http://10.0.0.5/a.ts')).toBe(true);
		expect(isPrivateHostUrl('http://172.16.0.1/a.ts')).toBe(true);
		expect(isPrivateHostUrl('http://172.31.255.255/a.ts')).toBe(true);
		expect(isPrivateHostUrl('http://192.168.1.1/a.ts')).toBe(true);
		expect(isPrivateHostUrl('http://[::1]/a.ts')).toBe(true);
		expect(isPrivateHostUrl('http://nas.local/a.ts')).toBe(true);
		expect(isPrivateHostUrl('http://x.internal/a.ts')).toBe(true);
		expect(isPrivateHostUrl('http://[fd00::1]/a.ts')).toBe(true);
	});

	it('クラウドのメタデータ宛を弾く', () => {
		expect(isPrivateHostUrl('http://169.254.169.254/latest/meta-data/')).toBe(true);
	});

	it('公開ホストは通す', () => {
		expect(isPrivateHostUrl('https://cdn.example.com/a.ts')).toBe(false);
		expect(isPrivateHostUrl('https://172.32.0.1/a.ts')).toBe(false);
		expect(isPrivateHostUrl('https://192.169.0.1/a.ts')).toBe(false);
		expect(isPrivateHostUrl('https://8.8.8.8/a.ts')).toBe(false);
	});

	it('URL として壊れていれば安全側へ倒す', () => {
		expect(isPrivateHostUrl('not a url')).toBe(true);
	});
});
