import { describe, expect, it } from 'vitest';
import { analyzeHlsManifest, estimateVariantSize, withEstimatedSizes } from './analysis';

const BASE_URL = 'https://cdn.example.com/hls/master.m3u8';

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
	if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
	return result.value;
}

describe('estimateVariantSize', () => {
	it('BANDWIDTH（bit/s）と再生時間からバイト数を出す', () => {
		// 8 Mbps × 10 秒 = 10MB
		expect(estimateVariantSize(8_000_000, 10)).toBe(10_000_000);
	});

	it.each([
		[undefined, 10],
		[0, 10],
		[8_000_000, undefined],
		[8_000_000, 0],
		[8_000_000, Number.POSITIVE_INFINITY],
	])('bandwidth=%s duration=%s では推定しない', (bandwidth, duration) => {
		expect(estimateVariantSize(bandwidth, duration)).toBeUndefined();
	});
});

describe('analyzeHlsManifest', () => {
	const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,FRAME-RATE=29.97,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480,CODECS="avc1.64001e,mp4a.40.2"
480p/index.m3u8`;

	describe('Master Playlist', () => {
		it('取得できないスキームの Variant を捨てる', () => {
			// マニフェストの中身はページ側が決められる。相対 URL の解決結果として
			// file: や data: が現れうるため、保存対象へ入れない
			const manifest = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080
file:///etc/passwd
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
data:application/x-mpegurl;base64,QUJD
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480
480p/index.m3u8`;

			const analysis = unwrap(analyzeHlsManifest(manifest, BASE_URL));

			expect(analysis.variants).toHaveLength(1);
			expect(analysis.variants?.[0]?.url).toBe('https://cdn.example.com/hls/480p/index.m3u8');
		});

		it('Variant を高画質順に並べる', () => {
			// 既定で最高品質を選ばせるため（要件定義 4.4）
			const analysis = unwrap(analyzeHlsManifest(MASTER, BASE_URL));

			expect(analysis.variants?.map((variant) => variant.height)).toEqual([1080, 720, 480]);
		});

		it('コーデック・FPS・URL を取り出す', () => {
			const analysis = unwrap(analyzeHlsManifest(MASTER, BASE_URL));

			expect(analysis.variants?.[0]).toMatchObject({
				url: 'https://cdn.example.com/hls/1080p/index.m3u8',
				width: 1920,
				height: 1080,
				bandwidth: 5_200_000,
				fps: 29.97,
				videoCodec: 'avc1.640028',
				audioCodec: 'mp4a.40.2',
			});
		});

		it('CODECS の並び順に依存せず映像・音声を振り分ける', () => {
			// CODECS は順不同（RFC 8216）。位置で決めると入れ替わる
			const content = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="mp4a.40.2,avc1.4d401e"
720p/index.m3u8`;
			const analysis = unwrap(analyzeHlsManifest(content, BASE_URL));

			expect(analysis.variants?.[0]).toMatchObject({
				videoCodec: 'avc1.4d401e',
				audioCodec: 'mp4a.40.2',
			});
		});

		it('音声のみの Variant を映像コーデックとして扱わない', () => {
			const content = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"
audio/index.m3u8`;
			const variant = unwrap(analyzeHlsManifest(content, BASE_URL)).variants?.[0];

			expect(variant?.audioCodec).toBe('mp4a.40.2');
			expect(variant).not.toHaveProperty('videoCodec');
		});

		it('解像度がなければ BANDWIDTH で並べる', () => {
			const content = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000
high.m3u8`;
			const analysis = unwrap(analyzeHlsManifest(content, BASE_URL));

			expect(analysis.variants?.map((variant) => variant.bandwidth)).toEqual([
				5_000_000, 1_000_000,
			]);
		});

		it('DRM を検出したら対応外として理由を付ける', () => {
			const content = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://x"
#EXT-X-STREAM-INF:BANDWIDTH=100
v.m3u8`;
			const analysis = unwrap(analyzeHlsManifest(content, BASE_URL));

			expect(analysis.drm).toBe(true);
			expect(analysis.unsupportedReason).toContain('DRM');
			// DRM なら品質を出さない
			expect(analysis.variants).toBeUndefined();
		});
	});

	describe('Media Playlist', () => {
		it('再生時間を取り出す', () => {
			const content = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:9.0,
a.ts
#EXTINF:9.0,
b.ts
#EXT-X-ENDLIST`;
			expect(unwrap(analyzeHlsManifest(content, BASE_URL)).duration).toBe(18);
		});

		it('TS セグメントの VOD は対応外にしない', () => {
			const content = '#EXTM3U\n#EXTINF:9.0,\na.ts\n#EXT-X-ENDLIST';
			expect(unwrap(analyzeHlsManifest(content, BASE_URL)).unsupportedReason).toBeUndefined();
		});

		it('fMP4 セグメントも対応外にしない', () => {
			// 初期化セグメントを先頭に置いて結合すれば mp4 として保存できる
			const content = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
a.m4s
#EXT-X-ENDLIST`;
			expect(unwrap(analyzeHlsManifest(content, BASE_URL)).unsupportedReason).toBeUndefined();
		});

		it('AES-128 も対応外にしない', () => {
			// 鍵を取得して復号する。復号できない場合は保存計画の側で弾く
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:6.0,
a.ts
#EXT-X-ENDLIST`;
			expect(unwrap(analyzeHlsManifest(content, BASE_URL)).unsupportedReason).toBeUndefined();
		});

		it('ライブは対応外', () => {
			const content = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\na.ts';
			expect(unwrap(analyzeHlsManifest(content, BASE_URL)).unsupportedReason).toContain('ライブ');
		});

		it('DRM はライブより優先して理由にする', () => {
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://x"
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
a.m4s`;
			const analysis = unwrap(analyzeHlsManifest(content, BASE_URL));

			expect(analysis.drm).toBe(true);
			expect(analysis.unsupportedReason).toContain('DRM');
		});
	});

	describe('異常系', () => {
		it('プレイリストでなければ not-a-playlist', () => {
			expect(analyzeHlsManifest('<html></html>', BASE_URL)).toEqual({
				ok: false,
				error: { type: 'not-a-playlist' },
			});
		});

		it('判断材料のないプレイリストも not-a-playlist', () => {
			expect(analyzeHlsManifest('#EXTM3U\n#EXT-X-VERSION:3', BASE_URL)).toEqual({
				ok: false,
				error: { type: 'not-a-playlist' },
			});
		});

		it('セグメント URI を欠く Media Playlist は unparsable', () => {
			// #EXTINF があるため media と判定されるが、セグメントがない
			const content = '#EXTM3U\n#EXTINF:6.0,\n#EXT-X-ENDLIST';
			expect(analyzeHlsManifest(content, BASE_URL)).toEqual({
				ok: false,
				error: { type: 'unparsable' },
			});
		});

		it('再生時間が 0 なら duration を持たない', () => {
			const content = '#EXTM3U\n#EXTINF:0,\na.ts\n#EXT-X-ENDLIST';
			const analysis = analyzeHlsManifest(content, BASE_URL);

			expect(analysis.ok && analysis.value).not.toHaveProperty('duration');
		});

		it('Variant を持たない Master は unparsable', () => {
			const content = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="ja",URI="a.m3u8"';
			expect(analyzeHlsManifest(content, BASE_URL)).toEqual({
				ok: false,
				error: { type: 'unparsable' },
			});
		});
	});
});

describe('withEstimatedSizes', () => {
	const variants = [
		{ id: 'v0', url: 'https://a.example.com/1080.m3u8', bandwidth: 5_200_000 },
		{ id: 'v1', url: 'https://a.example.com/720.m3u8', bandwidth: 2_500_000 },
	];

	it('再生時間から各 Variant の推定サイズを付ける', () => {
		const result = withEstimatedSizes(variants, 600);

		expect(result[0]?.estimatedSize).toBe(390_000_000);
		expect(result[1]?.estimatedSize).toBe(187_500_000);
	});

	it('再生時間が不明なら付けない', () => {
		const result = withEstimatedSizes(variants, undefined);

		expect(result[0]).not.toHaveProperty('estimatedSize');
	});

	it('元の配列を変更しない', () => {
		withEstimatedSizes(variants, 600);

		expect(variants[0]).not.toHaveProperty('estimatedSize');
	});
});
