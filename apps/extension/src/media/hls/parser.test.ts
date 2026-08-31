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

	it('音声以外の #EXT-X-MEDIA を音声トラックとして扱わない', () => {
		const content = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="日本語",URI="sub/ja.m3u8"
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC1"
#EXT-X-MEDIA:GROUP-ID="x",NAME="TYPE なし"
#EXT-X-STREAM-INF:BANDWIDTH=100
v.m3u8`;
		expect(unwrap(parseMasterPlaylist(content, BASE_URL)).audioRenditions).toEqual([]);
	});

	it('GROUP-ID や NAME を欠く #EXT-X-MEDIA を採用しない', () => {
		const content = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,NAME="GROUP-ID なし"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="NAME なし"
#EXT-X-STREAM-INF:BANDWIDTH=100
v.m3u8`;
		expect(unwrap(parseMasterPlaylist(content, BASE_URL)).audioRenditions).toEqual([]);
	});

	it('対応する #EXT-X-STREAM-INF を持たない URI 行を無視する', () => {
		const content = `#EXTM3U
orphan.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=100
v.m3u8`;
		const parsed = unwrap(parseMasterPlaylist(content, BASE_URL));

		expect(parsed.variants).toHaveLength(1);
		expect(parsed.variants[0]?.uri).toContain('v.m3u8');
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

		it('桁数が過大な RESOLUTION を採用しない', () => {
			// 正規表現は数字であることしか保証しない。桁が多すぎると
			// Number() が Infinity になり、そのまま UI へ流れてしまう
			const huge = '9'.repeat(400);
			const content = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=${huge}x1080
v.m3u8`;
			const parsed = unwrap(parseMasterPlaylist(content, BASE_URL));

			expect(parsed.variants).toHaveLength(1);
			expect(parsed.variants[0]?.width).toBeUndefined();
			expect(parsed.variants[0]?.height).toBeUndefined();
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
			sequenceNumber: 0,
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
			expect(parsed.segments[0]?.initSegment).toEqual({
				uri: 'https://cdn.example.com/hls/1080p/init.mp4',
			});
		});

		it('BYTERANGE を解決できなければ失敗させる', () => {
			// **範囲なしへ落とさない。** 落とすと計画も取得も「範囲指定なし」
			// としか見えず、エラーにならないままファイル全体を取得して連結する
			const content = '#EXTM3U\n#EXTINF:6.0,\n#EXT-X-BYTERANGE:abc@0\nseg.ts\n#EXT-X-ENDLIST';

			expect(parseMediaPlaylist(content, MEDIA_BASE)).toEqual({
				ok: false,
				error: { type: 'invalid-byterange', input: 'abc@0' },
			});
		});

		it('直前の終端が分からないオフセット省略形も失敗させる', () => {
			const content = '#EXTM3U\n#EXTINF:6.0,\n#EXT-X-BYTERANGE:100\nseg.ts\n#EXT-X-ENDLIST';

			expect(parseMediaPlaylist(content, MEDIA_BASE)).toEqual({
				ok: false,
				error: { type: 'invalid-byterange', input: '100' },
			});
		});

		it('#EXT-X-MAP の終端からオフセット省略形が続く', () => {
			// 初期化セグメントと本体が同じファイルを共有する構成。
			// MAP の終端を覚えていないと、続く省略形が解決できない
			const content = `#EXTM3U
#EXT-X-MAP:URI="all.mp4",BYTERANGE="800@0"
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000
all.mp4
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.byteRange).toEqual({ length: 1000, offset: 800 });
		});

		it('#EXT-X-MAP の BYTERANGE が壊れていれば失敗させる', () => {
			const content = `#EXTM3U
#EXT-X-MAP:URI="all.mp4",BYTERANGE="xyz"
#EXTINF:6.0,
seg.m4s
#EXT-X-ENDLIST`;

			expect(parseMediaPlaylist(content, MEDIA_BASE)).toEqual({
				ok: false,
				error: { type: 'invalid-byterange', input: 'xyz' },
			});
		});

		it('#EXT-X-MAP の切り替わりをセグメントごとに追う', () => {
			// 不連続点をまたいで初期化セグメントが変わる構成がある
			const content = `#EXTM3U
#EXT-X-MAP:URI="init-a.mp4"
#EXTINF:6.0,
a.m4s
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="init-b.mp4"
#EXTINF:6.0,
b.m4s
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments.map((segment) => segment.initSegment?.uri)).toEqual([
				'https://cdn.example.com/hls/1080p/init-a.mp4',
				'https://cdn.example.com/hls/1080p/init-b.mp4',
			]);
		});

		it('#EXT-X-MAP より前のセグメントには適用しない', () => {
			const content = `#EXTM3U
#EXTINF:6.0,
plain.ts
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
seg.m4s
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.initSegment).toBeUndefined();
			expect(parsed.segments[1]?.initSegment?.uri).toBe(
				'https://cdn.example.com/hls/1080p/init.mp4',
			);
		});

		it('#EXT-X-MAP の BYTERANGE を解析する', () => {
			const content = `#EXTM3U
#EXT-X-MAP:URI="stream.mp4",BYTERANGE="720@0"
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@720
stream.mp4
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.initSegment?.byteRange).toEqual({ length: 720, offset: 0 });
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

	describe('メディアシーケンス', () => {
		it('#EXT-X-MEDIA-SEQUENCE を起点に番号を振る', () => {
			// IV 省略時の導出に使う。ずれると復号結果が壊れる
			const content = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:6.0,
a.ts
#EXTINF:6.0,
b.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.mediaSequence).toBe(10);
			expect(parsed.segments.map((segment) => segment.sequenceNumber)).toEqual([10, 11]);
		});

		it('値が壊れていれば 0 として扱う', () => {
			// 導出した IV がずれるより、既定の 0 から数え直す方が読みやすい
			const content = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:abc\n#EXTINF:6.0,\na.ts\n#EXT-X-ENDLIST';
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.mediaSequence).toBe(0);
			expect(parsed.segments[0]?.sequenceNumber).toBe(0);
		});

		it('先頭セグメントより後ろにあっても番号を揃える', () => {
			// RFC は先頭より前に置くことを求めるが、違反していても
			// 番号がずれると復号は通るのに中身が壊れる
			const content = `#EXTM3U
#EXTINF:6.0,
a.ts
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:6.0,
b.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments.map((segment) => segment.sequenceNumber)).toEqual([10, 11]);
		});

		it('省略時は 0 から始める', () => {
			const parsed = unwrap(parseMediaPlaylist(VOD_TS, MEDIA_BASE));

			expect(parsed.mediaSequence).toBe(0);
			expect(parsed.segments.map((segment) => segment.sequenceNumber)).toEqual([0, 1, 2]);
		});
	});

	describe('暗号化', () => {
		it('#EXT-X-KEY がなければ none', () => {
			expect(unwrap(parseMediaPlaylist(VOD_TS, MEDIA_BASE)).encryption).toEqual({
				method: 'none',
			});
		});

		it('AES-128 の鍵 URI を解決し、セグメントへ結び付ける', () => {
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin",IV=0x00000000000000000000000000000001
#EXTINF:6.0,
seg.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.encryption).toEqual({ method: 'aes-128' });
			expect(parsed.segments[0]?.key).toEqual({
				keyUri: 'https://cdn.example.com/hls/keys/key.bin',
				iv: '0x00000000000000000000000000000001',
			});
		});

		it('#EXT-X-KEY はそれ以降のセグメントにだけ効く', () => {
			// プレイリストの途中から暗号化される構成がある。全体へ遡って
			// 適用すると、平文のセグメントを復号しようとして失敗する
			const content = `#EXTM3U
#EXTINF:6.0,
plain.ts
#EXT-X-KEY:METHOD=AES-128,URI="k1.bin"
#EXTINF:6.0,
enc.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.key).toBeUndefined();
			expect(parsed.segments[1]?.key?.keyUri).toBe('https://cdn.example.com/hls/1080p/k1.bin');
			// 1 つでも暗号化されていれば、要約は暗号化として扱う
			expect(parsed.encryption).toEqual({ method: 'aes-128' });
		});

		it('鍵の切り替えをセグメントごとに追う', () => {
			// 1 つだけ覚えると、鍵が回るストリームで一部が復号できない
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="k1.bin"
#EXTINF:6.0,
a.ts
#EXT-X-KEY:METHOD=AES-128,URI="k2.bin"
#EXTINF:6.0,
b.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments.map((segment) => segment.key?.keyUri)).toEqual([
				'https://cdn.example.com/hls/1080p/k1.bin',
				'https://cdn.example.com/hls/1080p/k2.bin',
			]);
		});

		it('METHOD=NONE で以降の暗号化が解ける', () => {
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="k1.bin"
#EXTINF:6.0,
enc.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:6.0,
plain.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.key).toBeDefined();
			expect(parsed.segments[1]?.key).toBeUndefined();
			// 途中まで暗号化されていた事実は要約に残す
			expect(parsed.encryption).toEqual({ method: 'aes-128' });
		});

		it('#EXT-X-MAP にもその時点の鍵を適用する', () => {
			// RFC 8216 は初期化セグメントにも直前の #EXT-X-KEY を適用する。
			// 平文として扱うと、結合したファイルの先頭だけが壊れる
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="k1.bin"
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
seg.m4s
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.initSegment?.key?.keyUri).toBe(
				'https://cdn.example.com/hls/1080p/k1.bin',
			);
		});

		it('URI を欠く #EXT-X-KEY でも平文として扱わない', () => {
			// 復号できないことに変わりはない。鍵なしで通すと暗号文を保存する
			const content = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:6.0,\nseg.ts\n#EXT-X-ENDLIST';
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.key).toEqual({});
			expect(parsed.encryption).toEqual({ method: 'aes-128' });
		});

		it('KEYFORMAT が identity 以外なら鍵を取りにいかない', () => {
			// 既定の identity は「URI が 16 バイトの鍵そのもの」。別形式の
			// 鍵サーバーへ Cookie 付きで取りに行っても復号できない
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://drm.example.com/k",KEYFORMAT="com.example.drm"
#EXTINF:6.0,
seg.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.key).toEqual({});
		});

		it('KEYFORMAT=identity は鍵として扱う', () => {
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="k.bin",KEYFORMAT="identity"
#EXTINF:6.0,
seg.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.key?.keyUri).toBe('https://cdn.example.com/hls/1080p/k.bin');
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

		it('KEYFORMAT が DRM でなくても METHOD=SAMPLE-AES なら DRM として扱う', () => {
			// SAMPLE-AES はサンプル単位の暗号化で、AES-128 の標準的な再構成では復号できない
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://cdn.example.com/keys/k.bin",KEYFORMAT="identity"
#EXTINF:6.0,
seg.ts
#EXT-X-ENDLIST`;
			const encryption = unwrap(parseMediaPlaylist(content, MEDIA_BASE)).encryption;

			expect(encryption).toEqual({ method: 'drm', reason: 'METHOD=SAMPLE-AES' });
		});

		it('AES-128 で URI を欠く鍵指定も暗号化として扱う', () => {
			// 復号できないことに変わりはない。none のまま通すと
			// 暗号文をそのまま連結して保存してしまう
			const content = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128
#EXTINF:6.0,
seg.ts
#EXT-X-ENDLIST`;
			expect(unwrap(parseMediaPlaylist(content, MEDIA_BASE)).encryption).toEqual({
				method: 'aes-128',
			});
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

		it('空文字は empty-playlist', () => {
			expect(parseMediaPlaylist('', MEDIA_BASE)).toEqual({
				ok: false,
				error: { type: 'empty-playlist' },
			});
			expect(parseMediaPlaylist('   \n\n  \n', MEDIA_BASE)).toEqual({
				ok: false,
				error: { type: 'empty-playlist' },
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

		it('URI を欠く #EXT-X-MAP を無視して続行する', () => {
			const content = `#EXTM3U
#EXT-X-MAP:BYTERANGE="720@0"
#EXTINF:6.0,
seg.ts
#EXT-X-ENDLIST`;
			const parsed = unwrap(parseMediaPlaylist(content, MEDIA_BASE));

			expect(parsed.segments[0]?.initSegment).toBeUndefined();
			expect(parsed.segmentFormat).toBe('ts');
		});

		describe('baseUrl が不正で相対 URI を解決できない場合', () => {
			it('セグメント URI で invalid-uri を返す', () => {
				const content = '#EXTM3U\n#EXTINF:6.0,\nseg.ts\n#EXT-X-ENDLIST';
				expect(parseMediaPlaylist(content, 'not a url')).toEqual({
					ok: false,
					error: { type: 'invalid-uri', input: 'seg.ts' },
				});
			});

			it('AES-128 の鍵 URI で invalid-uri を返す', () => {
				const content = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="keys/k.bin"
#EXTINF:6.0,
seg.ts
#EXT-X-ENDLIST`;
				expect(parseMediaPlaylist(content, 'not a url')).toEqual({
					ok: false,
					error: { type: 'invalid-uri', input: 'keys/k.bin' },
				});
			});

			it('#EXT-X-MAP の URI で invalid-uri を返す', () => {
				const content = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
seg.m4s
#EXT-X-ENDLIST`;
				expect(parseMediaPlaylist(content, 'not a url')).toEqual({
					ok: false,
					error: { type: 'invalid-uri', input: 'init.mp4' },
				});
			});

			it('#EXT-X-MEDIA の URI で invalid-uri を返す', () => {
				const content = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="ja",URI="audio/ja.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="a"
v.m3u8`;
				expect(parseMasterPlaylist(content, 'not a url')).toEqual({
					ok: false,
					error: { type: 'invalid-uri', input: 'audio/ja.m3u8' },
				});
			});
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
