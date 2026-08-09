import { describe, expect, it } from 'vitest';
import {
	detectMediaType,
	isBlobUrl,
	isFetchableUrl,
	isSupportedMediaType,
	normalizeMimeType,
	requiresVariantSelection,
} from './media-type';

describe('normalizeMimeType', () => {
	it('パラメータを落とす', () => {
		expect(normalizeMimeType('application/x-mpegURL; charset=utf-8')).toBe('application/x-mpegurl');
	});

	it('前後の空白を落とす', () => {
		expect(normalizeMimeType('  video/mp4  ')).toBe('video/mp4');
	});

	it('空文字を許容する', () => {
		expect(normalizeMimeType('')).toBe('');
	});
});

describe('detectMediaType', () => {
	describe('Content-Type による判定', () => {
		it.each([
			['application/vnd.apple.mpegurl', 'hls'],
			['application/x-mpegURL', 'hls'],
			['application/dash+xml', 'dash'],
			['video/mp4', 'direct'],
			['video/webm', 'direct'],
			['video/quicktime', 'direct'],
			['audio/mpeg', 'audio'],
			['audio/mp4', 'audio'],
			['audio/aac', 'audio'],
			['audio/ogg', 'audio'],
		])('%s → %s', (contentType, expected) => {
			expect(detectMediaType({ url: 'https://a.example.com/stream', contentType })).toBe(expected);
		});

		it('大文字小文字を問わない', () => {
			expect(detectMediaType({ url: 'https://a.example.com/s', contentType: 'VIDEO/MP4' })).toBe(
				'direct',
			);
		});
	});

	describe('拡張子による判定', () => {
		it.each([
			['https://a.example.com/v.m3u8', 'hls'],
			['https://a.example.com/v.mpd', 'dash'],
			['https://a.example.com/v.mp4', 'direct'],
			['https://a.example.com/v.webm', 'direct'],
			['https://a.example.com/v.mov', 'direct'],
			['https://a.example.com/v.m4v', 'direct'],
			['https://a.example.com/a.mp3', 'audio'],
			['https://a.example.com/a.m4a', 'audio'],
			['https://a.example.com/a.aac', 'audio'],
			['https://a.example.com/a.opus', 'audio'],
		])('%s → %s', (url, expected) => {
			expect(detectMediaType({ url })).toBe(expected);
		});

		it('クエリ付きでも拡張子で判定できる', () => {
			expect(detectMediaType({ url: 'https://a.example.com/v.m3u8?token=abc&e=123' })).toBe('hls');
		});
	});

	describe('フォールバック', () => {
		it('Content-Type が octet-stream なら拡張子で判定する', () => {
			expect(
				detectMediaType({
					url: 'https://a.example.com/v.m3u8',
					contentType: 'application/octet-stream',
				}),
			).toBe('hls');
		});

		it('Content-Type が text/plain でも拡張子で判定する（誤った配信設定への耐性）', () => {
			expect(
				detectMediaType({ url: 'https://a.example.com/v.mpd', contentType: 'text/plain' }),
			).toBe('dash');
		});

		it('Content-Type を優先する（拡張子が実体と食い違う場合）', () => {
			expect(
				detectMediaType({ url: 'https://a.example.com/playlist.txt', contentType: 'video/mp4' }),
			).toBe('direct');
		});

		it('どちらからも判定できなければ unknown', () => {
			expect(detectMediaType({ url: 'https://a.example.com/stream' })).toBe('unknown');
			expect(detectMediaType({ url: 'https://a.example.com/page', contentType: 'text/html' })).toBe(
				'unknown',
			);
		});
	});
});

describe('isSupportedMediaType', () => {
	it('unknown 以外を対象とする', () => {
		expect(isSupportedMediaType('hls')).toBe(true);
		expect(isSupportedMediaType('direct')).toBe(true);
		expect(isSupportedMediaType('audio')).toBe(true);
		expect(isSupportedMediaType('unknown')).toBe(false);
	});
});

describe('requiresVariantSelection', () => {
	it('HLS と DASH のみ品質選択が必要', () => {
		expect(requiresVariantSelection('hls')).toBe(true);
		expect(requiresVariantSelection('dash')).toBe(true);
		expect(requiresVariantSelection('direct')).toBe(false);
		expect(requiresVariantSelection('audio')).toBe(false);
	});
});

describe('isBlobUrl', () => {
	it('blob URL を判別する', () => {
		expect(isBlobUrl('blob:https://a.example.com/8f3a-...')).toBe(true);
		expect(isBlobUrl('https://a.example.com/v.mp4')).toBe(false);
	});
});

describe('isFetchableUrl', () => {
	it('http/https のみ再取得可能とする', () => {
		expect(isFetchableUrl('https://a.example.com/v.mp4')).toBe(true);
		expect(isFetchableUrl('http://a.example.com/v.mp4')).toBe(true);
	});

	it('blob / data / filesystem は対象外', () => {
		expect(isFetchableUrl('blob:https://a.example.com/8f3a')).toBe(false);
		expect(isFetchableUrl('data:video/mp4;base64,AAAA')).toBe(false);
		expect(isFetchableUrl('filesystem:https://a.example.com/temporary/v.mp4')).toBe(false);
	});
});
