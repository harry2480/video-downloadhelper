import { describe, expect, it } from 'vitest';
import { type Result, err, isOk, ok } from './utils';

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
