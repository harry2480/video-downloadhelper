import { describe, expect, it } from 'vitest';
import type { Result } from '../../shared/utils';
import {
	detectPlaylistKind,
	detectSegmentFormat,
	parseAttributeList,
	parseByteRange,
	parseMasterPlaylist,
	parseMediaPlaylist,
} from './parser';
import type { HlsParseError } from './types';

const BASE_URL = 'https://cdn.example.com/hls/master.m3u8';

function unwrap<T>(result: Result<T, HlsParseError>): T {
	if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
	return result.value;
}

describe('parseAttributeList', () => {
	it('単純な key=value を解析する', () => {
		expect(parseAttributeList('BANDWIDTH=5000000,RESOLUTION=1920x1080')).toEqual({
			BANDWIDTH: '5000000',
			RESOLUTION: '1920x1080',
		});
	});

	it('引用符内のカンマで分割しない', () => {
		// 単純な split(',') ではここが壊れる
		expect(parseAttributeList('CODECS="avc1.64001f,mp4a.40.2",BANDWIDTH=100')).toEqual({
			CODECS: 'avc1.64001f,mp4a.40.2',
			BANDWIDTH: '100',
		});
	});

	it('キーを大文字に正規化する', () => {
		expect(parseAttributeList('bandwidth=100')).toEqual({ BANDWIDTH: '100' });
	});

	it('引用符内の値はそのまま保つ', () => {
		expect(parseAttributeList('URI="https://a.example.com/key?x=1&y=2"')).toEqual({
			URI: 'https://a.example.com/key?x=1&y=2',
		});
	});

	it('閉じ引用符がない壊れた属性でも例外を投げない', () => {
		expect(parseAttributeList('URI="unterminated')).toEqual({ URI: 'unterminated' });
	});

	it('空文字を許容する', () => {
		expect(parseAttributeList('')).toEqual({});
	});

	it('= を含まない入力で無限ループしない', () => {
		expect(parseAttributeList('GARBAGE')).toEqual({});
	});
});

describe('parseByteRange', () => {
	it('length@offset を解析する', () => {
		expect(parseByteRange('1024@2048', undefined)).toEqual({ length: 1024, offset: 2048 });
	});

	it('オフセット省略時は直前の終端から続ける', () => {
		expect(parseByteRange('1024', 5000)).toEqual({ length: 1024, offset: 5000 });
	});

	it('オフセット省略かつ直前がなければ範囲を決められない', () => {
		expect(parseByteRange('1024', undefined)).toBeUndefined();
	});

	it('数値でない入力を拒否する', () => {
		expect(parseByteRange('abc@0', undefined)).toBeUndefined();
		expect(parseByteRange('100@xyz', undefined)).toBeUndefined();
	});

	it('負の値を拒否する', () => {
		expect(parseByteRange('-1@0', undefined)).toBeUndefined();
	});
});

describe('detectPlaylistKind', () => {
	it('#EXT-X-STREAM-INF があれば master', () => {
		const content = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nv.m3u8';
		expect(detectPlaylistKind(content)).toBe('master');
	});

	it('#EXTINF があれば media', () => {
		const content = '#EXTM3U\n#EXTINF:9.0,\nseg.ts';
		expect(detectPlaylistKind(content)).toBe('media');
	});

	it('#EXT-X-MEDIA だけの master も判定する', () => {
		const content = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="ja",URI="a.m3u8"';
		expect(detectPlaylistKind(content)).toBe('master');
	});

	it('#EXTM3U がなければ undefined', () => {
		expect(detectPlaylistKind('not a playlist')).toBeUndefined();
	});

	it('判断材料がなければ undefined', () => {
		expect(detectPlaylistKind('#EXTM3U\n#EXT-X-VERSION:3')).toBeUndefined();
	});
});

describe('parseMasterPlaylist', () => {
	const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="日本語",LANGUAGE="ja",DEFAULT=YES,CHANNELS="2",URI="audio/ja.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=NO,CHANNELS="2",URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5200000,AVERAGE-BANDWIDTH=4800000,RESOLUTION=1920x1080,FRAME-RATE=29.970,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aac"
480p/index.m3u8
`;

	it('Variant Stream を解析する', () => {
		const parsed = unwrap(parseMasterPlaylist(MASTER, BASE_URL));

		expect(parsed.kind).toBe('master');
		expect(parsed.variants).toHaveLength(3);
		expect(parsed.variants[0]).toEqual({
			uri: 'https://cdn.example.com/hls/1080p/index.m3u8',
			bandwidth: 5_200_000,
			averageBandwidth: 4_800_000,
			width: 1920,
			height: 1080,
			codecs: ['avc1.640028', 'mp4a.40.2'],
			frameRate: 29.97,
			audioGroupId: 'aac',
		});
	});

	it('相対 URI を baseUrl で絶対 URL に解決する', () => {
		const parsed = unwrap(parseMasterPlaylist(MASTER, BASE_URL));

		for (const variant of parsed.variants) {
			expect(variant.uri.startsWith('https://cdn.example.com/hls/')).toBe(true);
		}
	});

	it('音声トラックを解析する', () => {
		const parsed = unwrap(parseMasterPlaylist(MASTER, BASE_URL));

		expect(parsed.audioRenditions).toHaveLength(2);
		expect(parsed.audioRenditions[0]).toEqual({
			groupId: 'aac',
			name: '日本語',
			language: 'ja',
			uri: 'https://cdn.example.com/hls/audio/ja.m3u8',
			isDefault: true,
			channels: '2',
		});
		expect(parsed.audioRenditions[1]?.isDefault).toBe(false);
	});

	it('URI を持たない多重化済み音声トラックを許容する', () => {
		const content = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="main",DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="a"
v.m3u8`;
		const parsed = unwrap(parseMasterPlaylist(content, BASE_URL));

		expect(parsed.audioRenditions[0]?.uri).toBeUndefined();
	});

	it('絶対 URL の Variant をそのまま扱う', () => {
		const content = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100
https://other.example.com/v.m3u8`;
		const parsed = unwrap(parseMasterPlaylist(content, BASE_URL));

		expect(parsed.variants[0]?.uri).toBe('https://other.example.com/v.m3u8');
	});

	it('コメント行を無視する', () => {
		const content = `#EXTM3U
# これはコメント
#EXT-X-STREAM-INF:BANDWIDTH=100
v.m3u8`;
		expect(unwrap(parseMasterPlaylist(content, BASE_URL)).variants).toHaveLength(1);
	});

	it('CRLF 改行を扱える', () => {
		const content = '#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=100\r\nv.m3u8\r\n';
		expect(unwrap(parseMasterPlaylist(content, BASE_URL)).variants).toHaveLength(1);
	});

	describe('DRM 判定', () => {
		it('Widevine の SESSION-KEY を DRM とみなす', () => {
			const content = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="skd://x"
#EXT-X-STREAM-INF:BANDWIDTH=100
v.m3u8`;
			expect(unwrap(parseMasterPlaylist(content, BASE_URL)).drmReason).toBeDefined();
		});

		it('FairPlay の KEYFORMAT を DRM とみなす', () => {
			const content = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://x"
#EXT-X-STREAM-INF:BANDWIDTH=100
v.m3u8`;
			expect(unwrap(parseMasterPlaylist(content, BASE_URL)).drmReason).toBeDefined();
		});

		it('DRM でなければ drmReason を持たない', () => {
			expect(unwrap(parseMasterPlaylist(MASTER, BASE_URL)).drmReason).toBeUndefined();
		});
	});

	describe('異常系', () => {
		it('#EXTM3U で始まらなければ not-a-playlist', () => {
			expect(parseMasterPlaylist('<html></html>', BASE_URL)).toEqual({
				ok: false,
				error: { type: 'not-a-playlist' },
			});
		});

		it('空文字は empty-playlist', () => {
			expect(parseMasterPlaylist('', BASE_URL)).toEqual({
				ok: false,
				error: { type: 'empty-playlist' },
			});
		});

		it('Variant が 1 件もなければ no-variants', () => {
			expect(parseMasterPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n', BASE_URL)).toEqual({
				ok: false,
				error: { type: 'no-variants' },
			});
		});

		it('BANDWIDTH を欠く Variant を採用しない', () => {
			const content = `#EXTM3U
#EXT-X-STREAM-INF:RESOLUTION=1920x1080
broken.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=100
ok.m3u8`;
			const parsed = unwrap(parseMasterPlaylist(content, BASE_URL));

			expect(parsed.variants).toHaveLength(1);
			expect(parsed.variants[0]?.uri).toContain('ok.m3u8');
		});

		it('RESOLUTION が壊れていても Variant 自体は採用する', () => {
			const content = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=broken
v.m3u8`;
			const parsed = unwrap(parseMasterPlaylist(content, BASE_URL));

			expect(parsed.variants).toHaveLength(1);
			expect(parsed.variants[0]?.width).toBeUndefined();
		});

		it('URI 行が解決できなければ invalid-uri', () => {
			const content = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nv.m3u8';
			expect(parseMasterPlaylist(content, 'not a url')).toEqual({
				ok: false,
				error: { type: 'invalid-uri', input: 'v.m3u8' },
			});
		});
	});
});

describe('parseMediaPlaylist', () => {
	const MEDIA_BASE = 'https://cdn.example.com/hls/1080p/index.m3u8';

	const VOD_TS = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:9.009,
seg0.ts
#EXTINF:9.009,
seg1.ts
#EXTINF:4.500,
seg2.ts
#EXT-X-ENDLIST
`;

	it('セグメントを解析する', () => {
		const parsed = unwrap(parseMediaPlaylist(VOD_TS, MEDIA_BASE));

		expect(parsed.segments).toHaveLength(3);
		expect(parsed.segments[0]).toEqual({
			uri: 'https://cdn.example.com/hls/1080p/seg0.ts',
			duration: 9.009,
		});
	});

	it('合計再生時間を算出する', () => {
		expect(unwrap(parseMediaPlaylist(VOD_TS, MEDIA_BASE)).totalDuration).toBeCloseTo(22.518, 3);
	});

	it('#EXT-X-TARGETDURATION を取り出す', () => {
		expect(unwrap(parseMediaPlaylist(VOD_TS, MEDIA_BASE)).targetDuration).toBe(10);
	});

	it('#EXTINF のタイトル部分を無視する', () => {
		const content = '#EXTM3U\n#EXTINF:9.0,segment title here\nseg.ts\n#EXT-X-ENDLIST';
		expect(unwrap(parseMediaPlaylist(content, MEDIA_BASE)).segments[0]?.duration).toBe(9);
	});

	describe('VOD / LIVE 判定', () => {
		it('#EXT-X-ENDLIST があれば VOD', () => {
			expect(unwrap(parseMediaPlaylist(VOD_TS, MEDIA_BASE)).isLive).toBe(false);
		});

		it('#EXT-X-ENDLIST がなければ LIVE', () => {
			const content = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg.ts';
			expect(unwrap(parseMediaPlaylist(content, MEDIA_BASE)).isLive).toBe(true);
		});

		it('#EXT-X-PLAYLIST-TYPE:VOD があれば ENDLIST がなくても VOD', () => {
			const content = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.0,\nseg.ts';
			expect(unwrap(parseMediaPlaylist(content, MEDIA_BASE)).isLive).toBe(false);
		});
	});

	describe('セグメント形式判定', () => {
		it('.ts セグメントを ts と判定する', () => {
			expect(unwrap(parseMediaPlaylist(VOD_TS, MEDIA_BASE)).segmentFormat).toBe('ts');
		});

		it('#EXT-X-MAP があれば fmp4 と判定する', () => {
			const content = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
seg0.m4s
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segmentFormat).toBe('fmp4');
			expect(parsed.initSegment).toEqual({
				uri: 'https://cdn.example.com/hls/1080p/init.mp4',
			});
		});

		it('#EXT-X-MAP の BYTERANGE を解析する', () => {
			const content = `#EXTM3U
#EXT-X-MAP:URI="stream.mp4",BYTERANGE="720@0"
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@720
stream.mp4
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.initSegment?.byteRange).toEqual({ length: 720, offset: 0 });
		});

		it('MAP なしでも .m4s 拡張子なら fmp4 と判定する', () => {
			const content = '#EXTM3U\n#EXTINF:6.0,\nseg0.m4s\n#EXT-X-ENDLIST';
			expect(unwrap(parseMediaPlaylist(content, MEDIA_BASE)).segmentFormat).toBe('fmp4');
		});

		it('判定できない拡張子は unknown', () => {
			const content = '#EXTM3U\n#EXTINF:6.0,\nseg0.bin\n#EXT-X-ENDLIST';
			expect(unwrap(parseMediaPlaylist(content, MEDIA_BASE)).segmentFormat).toBe('unknown');
		});
	});

	describe('#EXT-X-BYTERANGE', () => {
		it('オフセット指定ありを解析する', () => {
			const content = `#EXTM3U
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@0
stream.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.byteRange).toEqual({ length: 1000, offset: 0 });
		});

		it('オフセット省略時は同一 URI の直前の終端から続ける', () => {
			const content = `#EXTM3U
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@0
stream.ts
#EXTINF:6.0,
#EXT-X-BYTERANGE:2000
stream.ts
#EXTINF:6.0,
#EXT-X-BYTERANGE:500
stream.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.byteRange).toEqual({ length: 1000, offset: 0 });
			expect(parsed.segments[1]?.byteRange).toEqual({ length: 2000, offset: 1000 });
			expect(parsed.segments[2]?.byteRange).toEqual({ length: 500, offset: 3000 });
		});

		it('URI ごとに独立してオフセットを追跡する', () => {
			const content = `#EXTM3U
#EXTINF:6.0,
#EXT-X-BYTERANGE:100@0
a.ts
#EXTINF:6.0,
#EXT-X-BYTERANGE:200@0
b.ts
#EXTINF:6.0,
#EXT-X-BYTERANGE:300
a.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			// a.ts の 3 件目は a.ts の終端(100)から続く。b.ts の 200 に引きずられない
			expect(parsed.segments[2]?.byteRange).toEqual({ length: 300, offset: 100 });
		});

		it('BYTERANGE のないセグメントは byteRange を持たない', () => {
			expect(unwrap(parseMediaPlaylist(VOD_TS, MEDIA_BASE)).segments[0]?.byteRange).toBeUndefined();
		});
	});

	describe('暗号化', () => {
		it('#EXT-X-KEY がなければ none', () => {
			expect(unwrap(parseMediaPlaylist(VOD_TS, MEDIA_BASE)).encryption).toEqual({
				method: 'none',
			});
		});

		it('AES-128 の鍵 URI を解決する', () => {
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin",IV=0x00000000000000000000000000000001
#EXTINF:6.0,
seg.ts
#EXT-X-ENDLIST`;
			expect(unwrap(parseMediaPlaylist(content, MEDIA_BASE)).encryption).toEqual({
				method: 'aes-128',
				keyUri: 'https://cdn.example.com/hls/keys/key.bin',
				iv: '0x00000000000000000000000000000001',
			});
		});

		it('METHOD=NONE を none として扱う', () => {
			const content = '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6.0,\nseg.ts\n#EXT-X-ENDLIST';
			expect(unwrap(parseMediaPlaylist(content, MEDIA_BASE)).encryption).toEqual({
				method: 'none',
			});
		});

		it('SAMPLE-AES を DRM として扱う', () => {
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
seg.ts
#EXT-X-ENDLIST`;
			const encryption = unwrap(parseMediaPlaylist(content, MEDIA_BASE)).encryption;

			expect(encryption.method).toBe('drm');
		});

		it('Widevine の KEYFORMAT を DRM として扱う', () => {
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="data:x"
#EXTINF:6.0,
seg.ts
#EXT-X-ENDLIST`;
			expect(unwrap(parseMediaPlaylist(content, MEDIA_BASE)).encryption.method).toBe('drm');
		});
	});

	describe('異常系', () => {
		it('#EXTM3U で始まらなければ not-a-playlist', () => {
			expect(parseMediaPlaylist('garbage', MEDIA_BASE)).toEqual({
				ok: false,
				error: { type: 'not-a-playlist' },
			});
		});

		it('セグメントが 1 件もなければ no-segments', () => {
			expect(parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:10\n', MEDIA_BASE)).toEqual({
				ok: false,
				error: { type: 'no-segments' },
			});
		});

		it('#EXTINF のないセグメント行も拾う（duration は 0 とする）', () => {
			const content = '#EXTM3U\nseg.ts\n#EXT-X-ENDLIST';
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments).toHaveLength(1);
			expect(parsed.segments[0]?.duration).toBe(0);
		});

		it('#EXTINF の値が壊れていても 0 として続行する', () => {
			const content = '#EXTM3U\n#EXTINF:broken,\nseg.ts\n#EXT-X-ENDLIST';
			expect(unwrap(parseMediaPlaylist(content, MEDIA_BASE)).segments[0]?.duration).toBe(0);
		});
	});
});

describe('detectSegmentFormat', () => {
	it('初期化セグメントがあれば拡張子によらず fmp4', () => {
		expect(detectSegmentFormat('https://a.example.com/seg.ts', true)).toBe('fmp4');
	});

	it.each(['ts', 'mts', 'm2ts'])('.%s を ts と判定する', (extension) => {
		expect(detectSegmentFormat(`https://a.example.com/seg.${extension}`, false)).toBe('ts');
	});

	it.each(['mp4', 'm4s', 'cmfv'])('.%s を fmp4 と判定する', (extension) => {
		expect(detectSegmentFormat(`https://a.example.com/seg.${extension}`, false)).toBe('fmp4');
	});

	it('セグメントがなければ unknown', () => {
		expect(detectSegmentFormat(undefined, false)).toBe('unknown');
	});

	it('拡張子がなければ unknown', () => {
		expect(detectSegmentFormat('https://a.example.com/seg', false)).toBe('unknown');
	});
});
