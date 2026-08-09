import { describe, expect, it } from 'vitest';
import type { DetectedMedia } from '../shared/types';
import {
	formatBitrate,
	formatBytes,
	formatDuration,
	formatHost,
	formatMediaType,
	formatResolution,
	formatSummary,
	formatTitle,
	formatUrlForDisplay,
} from './format';

function media(overrides: Partial<DetectedMedia> = {}): DetectedMedia {
	return {
		id: '1:https://cdn.example.com/v.mp4',
		tabId: 1,
		pageUrl: 'https://example.com/watch',
		sourceUrl: 'https://cdn.example.com/v.mp4',
		dedupeKey: 'https://cdn.example.com/v.mp4',
		type: 'direct',
		detectedBy: 'network',
		detectedAt: 1_000,
		...overrides,
	};
}

describe('formatBytes', () => {
	it.each([
		[500, '500 B'],
		[1_024, '1 KB'],
		[1_536, '2 KB'],
		[1_048_576, '1.0 MB'],
		[440_401_920, '420.0 MB'],
		[1_073_741_824, '1.0 GB'],
	])('%d → %s', (bytes, expected) => {
		expect(formatBytes(bytes)).toBe(expected);
	});

	it('B と KB では小数を出さない', () => {
		expect(formatBytes(1_500)).not.toContain('.');
	});

	it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		'%s は undefined を返す',
		(value) => {
			expect(formatBytes(value)).toBeUndefined();
		},
	);
});

describe('formatBitrate', () => {
	it.each([
		[5_200_000, '5.2 Mbps'],
		[1_000_000, '1.0 Mbps'],
		[128_000, '128 kbps'],
		[999_999, '1000 kbps'],
	])('%d → %s', (bitrate, expected) => {
		expect(formatBitrate(bitrate)).toBe(expected);
	});

	it.each([undefined, 0, -1, Number.NaN])('%s は undefined を返す', (value) => {
		expect(formatBitrate(value)).toBeUndefined();
	});
});

describe('formatResolution', () => {
	it('横長は縦の画素数で呼称する', () => {
		expect(formatResolution(1920, 1080)).toBe('1080p');
		expect(formatResolution(3840, 2160)).toBe('2160p');
	});

	it('幅が不明でも高さがあれば呼称する', () => {
		expect(formatResolution(undefined, 720)).toBe('720p');
	});

	it('縦長は呼称が実態と合わないため実寸で出す', () => {
		expect(formatResolution(1080, 1920)).toBe('1080x1920');
	});

	it.each([undefined, 0, -1, Number.NaN])('高さが %s なら undefined', (value) => {
		expect(formatResolution(1920, value)).toBeUndefined();
	});
});

describe('formatDuration', () => {
	it.each([
		[30, '0:30'],
		[90, '1:30'],
		[3_600, '1:00:00'],
		[3_725, '1:02:05'],
		[59.6, '1:00'],
	])('%s 秒 → %s', (seconds, expected) => {
		expect(formatDuration(seconds)).toBe(expected);
	});

	it.each([undefined, 0, -1, Number.POSITIVE_INFINITY])('%s は undefined を返す', (value) => {
		expect(formatDuration(value)).toBeUndefined();
	});
});

describe('formatMediaType', () => {
	it('種別ごとの表示名を返す', () => {
		expect(formatMediaType('hls')).toBe('HLS');
		expect(formatMediaType('direct')).toBe('動画ファイル');
		expect(formatMediaType('audio')).toBe('音声');
	});
});

describe('formatTitle', () => {
	it('動画タイトルを優先する', () => {
		expect(formatTitle(media({ title: '動画', pageTitle: 'ページ' }))).toBe('動画');
	});

	it('動画タイトルがなければページタイトルを使う', () => {
		expect(formatTitle(media({ pageTitle: 'ページ' }))).toBe('ページ');
	});

	it('空白だけのタイトルを採用しない', () => {
		expect(formatTitle(media({ title: '   ', pageTitle: 'ページ' }))).toBe('ページ');
	});

	it('どちらもなければファイル名を使う', () => {
		expect(formatTitle(media())).toBe('v.mp4');
	});

	it('URL として壊れていれば URL をそのまま出す', () => {
		expect(formatTitle(media({ sourceUrl: 'broken' }))).toBe('broken');
	});
});

describe('formatHost', () => {
	it('ホスト名を返す', () => {
		expect(formatHost('https://cdn.example.com/v.mp4')).toBe('cdn.example.com');
	});

	it('壊れた URL では undefined', () => {
		expect(formatHost('broken')).toBeUndefined();
	});
});

describe('formatUrlForDisplay', () => {
	it('認証トークンをマスキングする', () => {
		expect(formatUrlForDisplay('https://cdn.example.com/v.m3u8?token=secret')).toBe(
			'https://cdn.example.com/v.m3u8?token=***',
		);
	});
});

describe('formatSummary', () => {
	it('取れた情報だけを並べる', () => {
		expect(
			formatSummary(
				media({ width: 1920, height: 1080, bitrate: 5_200_000, estimatedSize: 440_401_920 }),
			),
		).toBe('1080p / 5.2 Mbps / 420.0 MB');
	});

	it('何も取れなければ空文字', () => {
		expect(formatSummary(media())).toBe('');
	});

	it('一部だけでも並べる', () => {
		expect(formatSummary(media({ height: 720 }))).toBe('720p');
	});
});
