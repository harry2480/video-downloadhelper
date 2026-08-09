import { describe, expect, it } from 'vitest';
import { formatBadgeText } from './badge-text';

describe('formatBadgeText', () => {
	it('未検出のときは空文字（バッジ非表示）', () => {
		expect(formatBadgeText(0)).toBe('');
	});

	it('負の値も空文字として扱う', () => {
		expect(formatBadgeText(-1)).toBe('');
	});

	it('件数をそのまま表示する', () => {
		expect(formatBadgeText(1)).toBe('1');
		expect(formatBadgeText(42)).toBe('42');
		expect(formatBadgeText(99)).toBe('99');
	});

	it('99 を超えたら 99+ にまとめる', () => {
		// バッジは 4 文字程度しか表示できないため
		expect(formatBadgeText(100)).toBe('99+');
		expect(formatBadgeText(1000)).toBe('99+');
	});
});
