import { describe, expect, it } from 'vitest';
import type { ParsedMediaPlaylist } from '../media/hls/types';
import { planHlsDownload } from './hls-download';

/**
 * 未対応の条件は取りかかる前に返す。取得を始めてから気づくと、
 * 通信を無駄にしたうえでユーザーを待たせる。
 */

function playlist(overrides: Partial<ParsedMediaPlaylist> = {}): ParsedMediaPlaylist {
	return {
		kind: 'media',
		segments: [
			{ uri: 'https://cdn.example.com/seg0.ts', duration: 9.009 },
			{ uri: 'https://cdn.example.com/seg1.ts', duration: 9.009 },
		],
		totalDuration: 18.018,
		isLive: false,
		segmentFormat: 'ts',
		encryption: { method: 'none' },
		...overrides,
	};
}

describe('planHlsDownload', () => {
	it('TS セグメントを順番どおりに並べる', () => {
		const plan = planHlsDownload(playlist());

		expect(plan).toEqual({
			ok: true,
			value: {
				segmentUrls: ['https://cdn.example.com/seg0.ts', 'https://cdn.example.com/seg1.ts'],
				totalDuration: 18.018,
			},
		});
	});

	it('DRM は対応しない', () => {
		const rejected = planHlsDownload(
			playlist({ encryption: { method: 'drm', reason: 'widevine' } }),
		);

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('DRM');
	});

	it('AES-128 の暗号化は Phase 1 では対応しない', () => {
		const rejected = planHlsDownload(
			playlist({ encryption: { method: 'aes-128', keyUri: 'https://cdn.example.com/key' } }),
		);

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('暗号化');
	});

	it('ライブ配信は対応しない', () => {
		const rejected = planHlsDownload(playlist({ isLive: true }));

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('ライブ');
	});

	it('fMP4 セグメントは対応しない', () => {
		const rejected = planHlsDownload(playlist({ segmentFormat: 'fmp4' }));

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('fMP4');
	});

	it('バイトレンジ指定のセグメントは対応しない', () => {
		// 範囲を無視して連結すると、同じ内容を繰り返した壊れたファイルになる
		const rejected = planHlsDownload(
			playlist({
				segments: [
					{
						uri: 'https://cdn.example.com/all.ts',
						duration: 9,
						byteRange: { length: 100, offset: 0 },
					},
				],
			}),
		);

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('バイトレンジ');
	});

	it('セグメントが無ければ対応しない', () => {
		const rejected = planHlsDownload(playlist({ segments: [] }));

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('セグメント');
	});
});
