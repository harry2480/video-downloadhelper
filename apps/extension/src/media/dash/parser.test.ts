import { describe, expect, it } from 'vitest';
import { fillTemplate, parseIso8601Duration, parseMpd } from './parser';

/**
 * MPD の中身はページ側が決められる。**壊れた入力で例外を出さないこと**と、
 * セグメントの URL と順序を取り違えないことが要点。
 */

const BASE = 'https://cdn.example.com/dash/manifest.mpd';

function unwrap(result: ReturnType<typeof parseMpd>) {
	if (!result.ok) throw new Error(`parse failed: ${JSON.stringify(result.error)}`);
	return result.value;
}

/** 1 つの Representation を持つ最小の MPD。 */
function mpd(body: string, attributes = 'type="static" mediaPresentationDuration="PT20S"'): string {
	return `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${attributes}>
	<Period>${body}</Period>
</MPD>`;
}

describe('parseIso8601Duration', () => {
	it('時・分・秒を読む', () => {
		expect(parseIso8601Duration('PT1H2M3S')).toBe(3_723);
		expect(parseIso8601Duration('PT30.5S')).toBe(30.5);
		expect(parseIso8601Duration('PT2M')).toBe(120);
	});

	it('日を含む表記も読む', () => {
		expect(parseIso8601Duration('P1DT2H')).toBe(86_400 + 7_200);
	});

	it('桁あふれする値は undefined', () => {
		expect(parseIso8601Duration(`PT${'9'.repeat(400)}S`)).toBeUndefined();
	});

	it('妥当でない表記は undefined', () => {
		expect(parseIso8601Duration('20S')).toBeUndefined();
		expect(parseIso8601Duration('PT')).toBeUndefined();
		expect(parseIso8601Duration('P')).toBeUndefined();
		expect(parseIso8601Duration('')).toBeUndefined();
		expect(parseIso8601Duration(undefined)).toBeUndefined();
	});
});

describe('fillTemplate', () => {
	it('変数を埋める', () => {
		expect(
			fillTemplate('$RepresentationID$/$Number$.m4s', { RepresentationID: 'v0', Number: 3 }),
		).toBe('v0/3.m4s');
	});

	it('書式指定に従って 0 埋めする', () => {
		expect(fillTemplate('seg-$Number%05d$.m4s', { Number: 7 })).toBe('seg-00007.m4s');
	});

	it('$$ はドル記号そのもの', () => {
		expect(fillTemplate('a$$b', {})).toBe('a$b');
	});

	it('値が無い変数はそのまま残す', () => {
		// 埋められないまま取得しに行っても 404 になるだけ。黙って消さない
		expect(fillTemplate('$Time$.m4s', { Number: 1 })).toBe('$Time$.m4s');
	});

	it('$Bandwidth$ と $Time$ も埋める', () => {
		expect(fillTemplate('$Bandwidth$/$Time$.m4s', { Bandwidth: 800_000, Time: 12 })).toBe(
			'800000/12.m4s',
		);
	});

	it('桁指定が大きすぎれば書式を無視する', () => {
		// 制限しないと 1 本の URL で数百 MB の文字列を作られ、
		// さらに大きな値では padStart が RangeError を投げる
		expect(fillTemplate('seg-$Number%0999999999d$.m4s', { Number: 7 })).toBe('seg-7.m4s');
		expect(fillTemplate('seg-$Number%017d$.m4s', { Number: 7 })).toBe('seg-7.m4s');
		// 現実的な桁は従来どおり
		expect(fillTemplate('seg-$Number%016d$.m4s', { Number: 7 })).toBe('seg-0000000000000007.m4s');
	});

	it('Object.prototype のキーを変数として拾わない', () => {
		expect(fillTemplate('$constructor$-$Number$.m4s', { Number: 3 })).toBe('$constructor$-3.m4s');
		expect(fillTemplate('$toString$.m4s', {})).toBe('$toString$.m4s');
	});
});

describe('parseMpd', () => {
	describe('SegmentTemplate', () => {
		it('duration から本数を割り出す', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video" mimeType="video/mp4">
	<Representation id="v0" bandwidth="800000" width="1280" height="720" codecs="avc1.64001f">
		<SegmentTemplate initialization="init-$RepresentationID$.mp4" media="$RepresentationID$-$Number%03d$.m4s" duration="5" startNumber="1" />
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			const representation = parsed.adaptationSets[0]?.representations[0];
			expect(representation?.initSegment?.uri).toBe('https://cdn.example.com/dash/init-v0.mp4');
			expect(representation?.segments.map((segment) => segment.uri)).toEqual([
				'https://cdn.example.com/dash/v0-001.m4s',
				'https://cdn.example.com/dash/v0-002.m4s',
				'https://cdn.example.com/dash/v0-003.m4s',
				'https://cdn.example.com/dash/v0-004.m4s',
			]);
			expect(representation).toMatchObject({ bandwidth: 800_000, width: 1280, height: 720 });
			expect(representation?.codecs).toEqual(['avc1.64001f']);
		});

		it('timescale を考慮して本数を割り出す', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentTemplate media="$Number$.m4s" duration="90000" timescale="90000" />
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			// 1 秒セグメント × 20 秒
			expect(parsed.adaptationSets[0]?.representations[0]?.segments).toHaveLength(20);
		});

		it('SegmentTimeline を展開する', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentTemplate media="$Time$.m4s" startNumber="1">
			<SegmentTimeline>
				<S t="0" d="100" r="2" />
				<S d="50" />
			</SegmentTimeline>
		</SegmentTemplate>
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			// r="2" は「追加で 2 回」なので 3 本、そのあと 1 本
			expect(parsed.adaptationSets[0]?.representations[0]?.segments.map((s) => s.uri)).toEqual([
				'https://cdn.example.com/dash/0.m4s',
				'https://cdn.example.com/dash/100.m4s',
				'https://cdn.example.com/dash/200.m4s',
				'https://cdn.example.com/dash/300.m4s',
			]);
		});

		it('継承は属性ごとに効く', () => {
			// **丸ごと置き換えない。** 親が media/initialization を、子が
			// duration だけを持つ MPD は珍しくない。置き換えるとセグメントが
			// 1 本も作れなくなる
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<SegmentTemplate initialization="init-$RepresentationID$.mp4" media="$RepresentationID$-$Number$.m4s" startNumber="1" />
	<Representation id="v0"><SegmentTemplate duration="5" /></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			const representation = parsed.adaptationSets[0]?.representations[0];
			expect(representation?.initSegment?.uri).toBe('https://cdn.example.com/dash/init-v0.mp4');
			expect(representation?.segments.map((segment) => segment.uri)).toEqual([
				'https://cdn.example.com/dash/v0-1.m4s',
				'https://cdn.example.com/dash/v0-2.m4s',
				'https://cdn.example.com/dash/v0-3.m4s',
				'https://cdn.example.com/dash/v0-4.m4s',
			]);
		});

		it('子の属性が親を上書きする', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<SegmentTemplate media="parent-$Number$.m4s" duration="10" startNumber="1" />
	<Representation id="v0"><SegmentTemplate media="child-$Number$.m4s" startNumber="7" /></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments[0]?.uri).toBe(
				'https://cdn.example.com/dash/child-7.m4s',
			);
		});

		it('子が SegmentTimeline を持てば親のものを使わない', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<SegmentTemplate media="$Time$.m4s">
		<SegmentTimeline><S t="0" d="10" r="9" /></SegmentTimeline>
	</SegmentTemplate>
	<Representation id="v0">
		<SegmentTemplate><SegmentTimeline><S t="0" d="10" /></SegmentTimeline></SegmentTemplate>
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments).toHaveLength(1);
		});

		it('子が SegmentTimeline を持たなければ親のものを使う', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<SegmentTemplate media="$Time$.m4s">
		<SegmentTimeline><S t="0" d="10" r="2" /></SegmentTimeline>
	</SegmentTemplate>
	<Representation id="v0"><SegmentTemplate startNumber="1" /></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments).toHaveLength(3);
		});

		it('AdaptationSet の SegmentList / SegmentBase も引き継ぐ', () => {
			const withList = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<SegmentList><SegmentURL media="a.m4s" /></SegmentList>
	<Representation id="v0" />
</AdaptationSet>`),
					BASE,
				),
			);
			expect(withList.adaptationSets[0]?.representations[0]?.segments[0]?.uri).toBe(
				'https://cdn.example.com/dash/a.m4s',
			);

			const withBase = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<SegmentBase indexRange="0-99" />
	<Representation id="v0"><BaseURL>whole.mp4</BaseURL></Representation>
</AdaptationSet>`),
					BASE,
				),
			);
			expect(withBase.adaptationSets[0]?.representations[0]?.segments[0]?.uri).toBe(
				'https://cdn.example.com/dash/whole.mp4',
			);
		});

		it('SegmentTimeline でも初期化セグメントを持つ', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentTemplate initialization="init.mp4" media="$Time$.m4s">
			<SegmentTimeline><S t="0" d="10" /></SegmentTimeline>
		</SegmentTemplate>
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.initSegment?.uri).toBe(
				'https://cdn.example.com/dash/init.mp4',
			);
		});

		it('AdaptationSet の SegmentTemplate を引き継ぐ', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<SegmentTemplate initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s" duration="10" />
	<Representation id="hi" bandwidth="2000000" />
	<Representation id="lo" bandwidth="500000" />
</AdaptationSet>`),
					BASE,
				),
			);

			const representations = parsed.adaptationSets[0]?.representations ?? [];
			expect(representations).toHaveLength(2);
			expect(representations[0]?.initSegment?.uri).toBe('https://cdn.example.com/dash/hi/init.mp4');
			expect(representations[1]?.segments[0]?.uri).toBe('https://cdn.example.com/dash/lo/1.m4s');
		});

		it('media が無ければセグメントを持たない', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0"><SegmentTemplate initialization="init.mp4" /></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments).toEqual([]);
		});

		it('本数が多すぎれば too-many-segments', () => {
			// duration が極端に小さい MPD で無限に近い本数を作らせない
			const content = mpd(
				`<AdaptationSet contentType="video">
	<Representation id="v0"><SegmentTemplate media="$Number$.m4s" duration="1" timescale="100000" /></Representation>
</AdaptationSet>`,
				'type="static" mediaPresentationDuration="PT1H"',
			);

			expect(parseMpd(content, BASE)).toEqual({
				ok: false,
				error: { type: 'too-many-segments' },
			});
		});
	});

	describe('属性の解析', () => {
		it('frameRate の分数表記を読む', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="a" frameRate="30000/1001" />
	<Representation id="b" frameRate="25" />
	<Representation id="c" frameRate="30/0" />
	<Representation id="d" frameRate="abc" />
</AdaptationSet>`),
					BASE,
				),
			);

			const rates = parsed.adaptationSets[0]?.representations.map((r) => r.frameRate);
			expect(rates?.[0]).toBeCloseTo(29.97, 2);
			expect(rates?.[1]).toBe(25);
			// 0 除算・数値でない値は「不明」として落とす
			expect(rates?.[2]).toBeUndefined();
			expect(rates?.[3]).toBeUndefined();
		});

		it('コーデックでも判別できなければ unknown', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(
						`<AdaptationSet><Representation id="t" codecs="wvtt"><BaseURL>t.vtt</BaseURL></Representation></AdaptationSet>`,
					),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.contentType).toBe('unknown');
		});

		it('コーデックから種別を判別する', () => {
			// contentType も mimeType も無い AdaptationSet は実在する。
			// unknown に落とすと、音声が別立ての MPD で分離判定をすり抜け、
			// 無音の動画が出来上がる
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet><Representation id="v" codecs="avc1.640028"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet>
<AdaptationSet><Representation id="a" codecs="mp4a.40.2"><BaseURL>a.mp4</BaseURL></Representation></AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets.map((set) => set.contentType)).toEqual(['video', 'audio']);
		});

		it('種別の手がかりが無ければ unknown', () => {
			const parsed = unwrap(
				parseMpd(mpd('<AdaptationSet><Representation id="x" /></AdaptationSet>'), BASE),
			);

			expect(parsed.adaptationSets[0]?.contentType).toBe('unknown');
		});

		it('Representation の mimeType を持ち越す', () => {
			const parsed = unwrap(
				parseMpd(
					mpd('<AdaptationSet><Representation id="x" mimeType="video/mp4" /></AdaptationSet>'),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.contentType).toBe('video');
			expect(parsed.adaptationSets[0]?.representations[0]?.mimeType).toBe('video/mp4');
		});

		it('id が無くても解析を続ける', () => {
			const parsed = unwrap(
				parseMpd(
					mpd('<AdaptationSet contentType="video"><Representation /></AdaptationSet>'),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.id).toBe('');
		});

		it('種別が分からなければ unknown', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(
						'<AdaptationSet mimeType="application/xml"><Representation id="x" /></AdaptationSet>',
					),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.contentType).toBe('unknown');
		});

		it('桁数が多すぎる range は無視する', () => {
			// Number() が Infinity になり、`Range: bytes=Infinity-NaN` を作ってしまう
			const huge = '9'.repeat(400);
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentList><SegmentURL media="a.m4s" mediaRange="0-${huge}" /></SegmentList>
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments[0]?.byteRange).toBeUndefined();
		});

		it('startNumber が整数でなければ 1 として扱う', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0"><SegmentTemplate media="s$Number$.m4s" duration="10" startNumber="-5" /></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments[0]?.uri).toBe(
				'https://cdn.example.com/dash/s1.m4s',
			);
		});

		it('壊れた range は無視する', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentList>
			<Initialization range="abc" />
			<SegmentURL media="a.m4s" mediaRange="900-100" />
		</SegmentList>
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			const representation = parsed.adaptationSets[0]?.representations[0];
			expect(representation?.initSegment?.byteRange).toBeUndefined();
			expect(representation?.segments[0]?.byteRange).toBeUndefined();
		});

		it('再生時間が 0 ならセグメントを作らない', () => {
			// 初期化セグメントの指定があっても、本数が 0 なら並びは空
			const content = mpd(
				`<AdaptationSet contentType="video">
	<Representation id="v0"><SegmentTemplate initialization="init.mp4" media="$Number$.m4s" duration="10" /></Representation>
</AdaptationSet>`,
				'type="static" mediaPresentationDuration="PT0S"',
			);
			const representation = unwrap(parseMpd(content, BASE)).adaptationSets[0]?.representations[0];

			expect(representation?.segments).toEqual([]);
			expect(representation?.initSegment?.uri).toBe('https://cdn.example.com/dash/init.mp4');
		});

		it('全体長が分からなければセグメントを作らない', () => {
			// 本数が決まらないまま取得を始めない
			const content = mpd(
				`<AdaptationSet contentType="video">
	<Representation id="v0"><SegmentTemplate media="$Number$.m4s" duration="10" /></Representation>
</AdaptationSet>`,
				'type="static"',
			);

			expect(
				unwrap(parseMpd(content, BASE)).adaptationSets[0]?.representations[0]?.segments,
			).toEqual([]);
		});
	});

	describe('複数 Period', () => {
		it('複数 Period を持つ MPD は弾く', () => {
			// **平坦化しない。** 先頭の Period だけを保存して全長は合計を出す、
			// という「黙って切り詰めたファイル」になる
			const content = `<MPD type="static" mediaPresentationDuration="PT20S">
	<Period duration="PT10S"><AdaptationSet contentType="video">
		<Representation id="a"><BaseURL>a.mp4</BaseURL></Representation>
	</AdaptationSet></Period>
	<Period duration="PT10S"><AdaptationSet contentType="video">
		<Representation id="b"><BaseURL>b.mp4</BaseURL></Representation>
	</AdaptationSet></Period>
</MPD>`;

			expect(parseMpd(content, BASE)).toEqual({
				ok: false,
				error: { type: 'multiple-periods' },
			});
		});

		it('Period 直下のセグメント指定を引き継ぐ', () => {
			// DASH-IF のライブプロファイル等で使われる。読み損ねると
			// Representation が「指定なし」になり、マニフェスト自身の URL を
			// 1 本のメディアとして扱ってしまう
			const content = `<MPD type="static" mediaPresentationDuration="PT20S">
	<Period>
		<SegmentTemplate initialization="init-$RepresentationID$.mp4" media="$RepresentationID$-$Number$.m4s" duration="10" />
		<AdaptationSet contentType="video"><Representation id="v0" /></AdaptationSet>
	</Period>
</MPD>`;
			const parsed = unwrap(parseMpd(content, BASE));

			const representation = parsed.adaptationSets[0]?.representations[0];
			expect(representation?.initSegment?.uri).toBe('https://cdn.example.com/dash/init-v0.mp4');
			expect(representation?.segments.map((segment) => segment.uri)).toEqual([
				'https://cdn.example.com/dash/v0-1.m4s',
				'https://cdn.example.com/dash/v0-2.m4s',
			]);
		});

		it('セグメント指定も BaseURL も無ければセグメントを持たない', () => {
			// **マニフェスト自身の URL を 1 本のメディアにしない。**
			// MPD の XML を .mp4 として保存する経路になる
			const parsed = unwrap(
				parseMpd(
					mpd('<AdaptationSet contentType="video"><Representation id="v" /></AdaptationSet>'),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments).toEqual([]);
		});
	});

	describe('SegmentList', () => {
		it('SegmentURL を順に並べる', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentList>
			<Initialization sourceURL="init.mp4" />
			<SegmentURL media="a.m4s" />
			<SegmentURL media="b.m4s" />
		</SegmentList>
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			const representation = parsed.adaptationSets[0]?.representations[0];
			expect(representation?.initSegment?.uri).toBe('https://cdn.example.com/dash/init.mp4');
			expect(representation?.segments.map((segment) => segment.uri)).toEqual([
				'https://cdn.example.com/dash/a.m4s',
				'https://cdn.example.com/dash/b.m4s',
			]);
		});

		it('SegmentURL が多すぎれば too-many-segments', () => {
			const many = '<SegmentURL media="a.m4s" />'.repeat(50_001);
			const content = mpd(`<AdaptationSet contentType="video">
	<Representation id="v0"><SegmentList>${many}</SegmentList></Representation>
</AdaptationSet>`);

			expect(parseMpd(content, BASE)).toEqual({
				ok: false,
				error: { type: 'too-many-segments' },
			});
		});

		it('解決できない SegmentURL は invalid-uri', () => {
			const content = `<MPD type="static"><BaseURL>not a url</BaseURL><Period>
	<AdaptationSet contentType="video">
		<Representation id="v0"><SegmentList><SegmentURL media="a.m4s" /></SegmentList></Representation>
	</AdaptationSet>
</Period></MPD>`;

			expect(parseMpd(content, 'also not a url').ok).toBe(false);
		});

		it('media が無い SegmentURL は基準 URL 自体を指す', () => {
			// 範囲だけで切り分ける構成。URL は BaseURL のまま
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<BaseURL>all.mp4</BaseURL>
		<SegmentList><SegmentURL mediaRange="0-99" /></SegmentList>
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments[0]).toEqual({
				uri: 'https://cdn.example.com/dash/all.mp4',
				byteRange: { offset: 0, length: 100 },
			});
		});

		it('バイトレンジを読む', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentList>
			<Initialization range="0-799" />
			<SegmentURL mediaRange="800-1799" />
		</SegmentList>
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			const representation = parsed.adaptationSets[0]?.representations[0];
			// range は両端を含む
			expect(representation?.initSegment?.byteRange).toEqual({ offset: 0, length: 800 });
			expect(representation?.segments[0]?.byteRange).toEqual({ offset: 800, length: 1_000 });
		});
	});

	describe('SegmentBase', () => {
		it('BaseURL 自体を 1 本として扱う', () => {
			// 初期化部分も本体も同じファイルに入っている
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<BaseURL>video.mp4</BaseURL>
		<SegmentBase indexRange="0-999"><Initialization range="0-799" /></SegmentBase>
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments).toEqual([
				{ uri: 'https://cdn.example.com/dash/video.mp4' },
			]);
		});

		it('BaseURL が無い SegmentBase はセグメントを持たない', () => {
			// **マニフェスト自身の URL を 1 本のメディアにしない。**
			// MPD の XML を .mp4 として保存する経路になる
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0"><SegmentBase indexRange="0-999" /></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments).toEqual([]);
		});

		it('継承した SegmentBase でも BaseURL が無ければセグメントを持たない', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<SegmentBase indexRange="0-999" />
	<Representation id="v0" />
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments).toEqual([]);
		});

		it('上位の BaseURL でも 1 本として扱える', () => {
			// Representation 直下でなくても、どこかで宣言されていればよい
			const content = `<MPD type="static" mediaPresentationDuration="PT20S">
	<BaseURL>https://cdn.example.com/whole.mp4</BaseURL>
	<Period><AdaptationSet contentType="video">
		<Representation id="v0"><SegmentBase indexRange="0-999" /></Representation>
	</AdaptationSet></Period>
</MPD>`;
			const parsed = unwrap(parseMpd(content, BASE));

			expect(parsed.adaptationSets[0]?.representations[0]?.segments).toEqual([
				{ uri: 'https://cdn.example.com/whole.mp4' },
			]);
		});

		it('セグメント指定が無ければ BaseURL 自体を 1 本として扱う', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0"><BaseURL>whole.mp4</BaseURL></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.representations[0]?.segments[0]?.uri).toBe(
				'https://cdn.example.com/dash/whole.mp4',
			);
		});
	});

	describe('BaseURL の積み上げ', () => {
		it('MPD / Period / AdaptationSet / Representation の順に解決する', () => {
			const content = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT10S">
	<BaseURL>https://cdn.example.com/root/</BaseURL>
	<Period>
		<BaseURL>period/</BaseURL>
		<AdaptationSet contentType="video">
			<BaseURL>set/</BaseURL>
			<Representation id="v0">
				<BaseURL>rep/</BaseURL>
				<SegmentTemplate media="$Number$.m4s" duration="10" />
			</Representation>
		</AdaptationSet>
	</Period>
</MPD>`;
			const parsed = unwrap(parseMpd(content, BASE));

			expect(parsed.adaptationSets[0]?.representations[0]?.segments[0]?.uri).toBe(
				'https://cdn.example.com/root/period/set/rep/1.m4s',
			);
		});

		it('内側が絶対 URL なら外側を上書きする', () => {
			const content = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT10S">
	<BaseURL>https://a.example.com/</BaseURL>
	<Period>
		<AdaptationSet contentType="video">
			<Representation id="v0">
				<BaseURL>https://b.example.com/x/</BaseURL>
				<SegmentTemplate media="$Number$.m4s" duration="10" />
			</Representation>
		</AdaptationSet>
	</Period>
</MPD>`;
			const parsed = unwrap(parseMpd(content, BASE));

			expect(parsed.adaptationSets[0]?.representations[0]?.segments[0]?.uri).toBe(
				'https://b.example.com/x/1.m4s',
			);
		});
	});

	describe('AdaptationSet の種別', () => {
		it('contentType から映像・音声を判別する', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video"><Representation id="v" /></AdaptationSet>
<AdaptationSet contentType="audio" lang="ja"><Representation id="a" /></AdaptationSet>
<AdaptationSet contentType="text"><Representation id="t" /></AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets.map((set) => set.contentType)).toEqual([
				'video',
				'audio',
				'text',
			]);
			expect(parsed.adaptationSets[1]?.lang).toBe('ja');
		});

		it('contentType が無ければ mimeType から判別する', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet mimeType="audio/mp4"><Representation id="a" /></AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets[0]?.contentType).toBe('audio');
		});

		it('Representation が無い AdaptationSet は落とす', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video" />
<AdaptationSet contentType="audio"><Representation id="a" /></AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.adaptationSets).toHaveLength(1);
			expect(parsed.adaptationSets[0]?.contentType).toBe('audio');
		});
	});

	describe('DRM', () => {
		it('Widevine を検出する', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<ContentProtection schemeIdUri="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED" />
	<Representation id="v0" />
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.drmReason).toBe('Widevine');
		});

		it('PlayReady / FairPlay も検出する', () => {
			for (const [uuid, label] of [
				['9a04f079-9840-4286-ab92-e65be0885f95', 'PlayReady'],
				['94ce86fb-07ff-4f43-adb8-93d2fa968ca2', 'FairPlay'],
			]) {
				const parsed = unwrap(
					parseMpd(
						mpd(`<AdaptationSet contentType="video">
	<ContentProtection schemeIdUri="urn:uuid:${uuid}" />
	<Representation id="v0" />
</AdaptationSet>`),
						BASE,
					),
				);

				expect(parsed.drmReason).toBe(label);
			}
		});

		it('Representation 直下の ContentProtection も見る', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" />
	</Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.drmReason).toBe('MP4 Protection');
		});

		it('知らない保護方式は DRM として扱わない', () => {
			// 対応できるかは別として、DRM だと断定はしない
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video">
	<ContentProtection schemeIdUri="urn:example:unknown" />
	<ContentProtection />
	<Representation id="v0" />
</AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.drmReason).toBeUndefined();
		});

		it('保護が無ければ drmReason を持たない', () => {
			const parsed = unwrap(
				parseMpd(
					mpd(`<AdaptationSet contentType="video"><Representation id="v" /></AdaptationSet>`),
					BASE,
				),
			);

			expect(parsed.drmReason).toBeUndefined();
		});
	});

	describe('ライブ配信', () => {
		it('type="dynamic" をライブとして扱う', () => {
			const content = mpd(
				`<AdaptationSet contentType="video"><Representation id="v" /></AdaptationSet>`,
				'type="dynamic"',
			);

			expect(unwrap(parseMpd(content, BASE)).isLive).toBe(true);
		});

		it('type の指定が無ければ static として扱う', () => {
			const content = mpd(
				`<AdaptationSet contentType="video"><Representation id="v" /></AdaptationSet>`,
				'mediaPresentationDuration="PT10S"',
			);

			expect(unwrap(parseMpd(content, BASE)).isLive).toBe(false);
		});
	});

	describe('異常系', () => {
		it('MPD でなければ not-an-mpd', () => {
			expect(parseMpd('#EXTM3U\n#EXT-X-VERSION:3', BASE)).toEqual({
				ok: false,
				error: { type: 'not-an-mpd' },
			});
			expect(parseMpd('<html><body /></html>', BASE)).toEqual({
				ok: false,
				error: { type: 'not-an-mpd' },
			});
		});

		it('XML として壊れていれば unparsable', () => {
			expect(parseMpd('<MPD><Period></MPD>', BASE)).toEqual({
				ok: false,
				error: { type: 'unparsable' },
			});
		});

		it('DOCTYPE を含む MPD は受け取らない', () => {
			// 外部実体の入口を閉じる
			expect(parseMpd('<!DOCTYPE MPD><MPD />', BASE)).toEqual({
				ok: false,
				error: { type: 'unparsable' },
			});
		});

		it('Representation が 1 つも無ければ no-representations', () => {
			expect(parseMpd(mpd('<AdaptationSet contentType="video" />'), BASE)).toEqual({
				ok: false,
				error: { type: 'no-representations' },
			});
		});

		it('解決できない BaseURL は invalid-uri', () => {
			const content = '<MPD><BaseURL>ht!tp://</BaseURL><Period /></MPD>';

			expect(parseMpd(content, 'not a url')).toEqual({
				ok: false,
				error: { type: 'invalid-uri', input: 'ht!tp://' },
			});
		});

		it('基準 URL が壊れていれば invalid-uri', () => {
			// 相対 URL を解決できない。取得を始める前に打ち切る
			const template = `<AdaptationSet contentType="video">
	<Representation id="v0"><SegmentTemplate initialization="init.mp4" media="$Number$.m4s" duration="10" /></Representation>
</AdaptationSet>`;

			expect(parseMpd(mpd(template), 'not a url').ok).toBe(false);
		});

		it('初期化セグメントが無くても基準 URL の誤りを検出する', () => {
			const template = `<AdaptationSet contentType="video">
	<Representation id="v0"><SegmentTemplate media="$Number$.m4s" duration="10" /></Representation>
</AdaptationSet>`;

			expect(parseMpd(mpd(template), 'not a url').ok).toBe(false);
		});

		it('SegmentTimeline でも基準 URL の誤りを検出する', () => {
			const template = `<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S t="0" d="10" /></SegmentTimeline></SegmentTemplate>
	</Representation>
</AdaptationSet>`;

			expect(parseMpd(mpd(template), 'not a url').ok).toBe(false);
		});

		it('SegmentList でも基準 URL の誤りを検出する', () => {
			const list = `<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentList><Initialization sourceURL="init.mp4" /><SegmentURL media="a.m4s" /></SegmentList>
	</Representation>
</AdaptationSet>`;

			expect(parseMpd(mpd(list), 'not a url').ok).toBe(false);
		});

		it('初期化セグメントが無い SegmentList でも基準 URL の誤りを検出する', () => {
			const list = `<AdaptationSet contentType="video">
	<Representation id="v0"><SegmentList><SegmentURL media="a.m4s" /></SegmentList></Representation>
</AdaptationSet>`;

			expect(parseMpd(mpd(list), 'not a url').ok).toBe(false);
		});

		it('Period / AdaptationSet / Representation の BaseURL の誤りも検出する', () => {
			for (const placement of [
				'<Period><BaseURL>ht!tp://</BaseURL></Period>',
				'<Period><AdaptationSet><BaseURL>ht!tp://</BaseURL><Representation id="v" /></AdaptationSet></Period>',
				'<Period><AdaptationSet><Representation id="v"><BaseURL>ht!tp://</BaseURL></Representation></AdaptationSet></Period>',
			]) {
				expect(parseMpd(`<MPD>${placement}</MPD>`, 'not a url').ok).toBe(false);
			}
		});

		it('SegmentTimeline の本数が多すぎれば弾く', () => {
			const content = mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S t="0" d="1" r="50001" /></SegmentTimeline></SegmentTemplate>
	</Representation>
</AdaptationSet>`);

			expect(parseMpd(content, BASE)).toEqual({ ok: false, error: { type: 'too-many-segments' } });
		});

		it('Representation をまたいだ合計にも上限を掛ける', () => {
			// **Representation ごとの上限だけでは足りない。** 継承された
			// SegmentTemplate のもとでは、1 行足すたびに数千本ずつ増やせる。
			// 解析は Service Worker で走るため、総量を抑えないと拡張機能ごと止まる
			const representations = Array.from(
				{ length: 30 },
				(_, index) => `<Representation id="r${index}" bandwidth="${index + 1}" />`,
			).join('');

			const content = mpd(
				`<AdaptationSet contentType="video">
	<SegmentTemplate media="$RepresentationID$-$Number$.m4s" duration="1" />
	${representations}
</AdaptationSet>`,
				'type="static" mediaPresentationDuration="PT5000S"',
			);

			expect(parseMpd(content, BASE)).toEqual({ ok: false, error: { type: 'too-many-segments' } });
		});

		it('Representation が多すぎれば弾く', () => {
			const many = Array.from(
				{ length: 201 },
				(_, index) => `<Representation id="r${index}" />`,
			).join('');

			expect(
				parseMpd(mpd(`<AdaptationSet contentType="video">${many}</AdaptationSet>`), BASE),
			).toEqual({ ok: false, error: { type: 'too-many-segments' } });
		});

		it('SegmentTimeline の d が無ければ too-many-segments として弾く', () => {
			// 本数が決まらないまま取得を始めない
			const content = mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S t="0" /></SegmentTimeline></SegmentTemplate>
	</Representation>
</AdaptationSet>`);

			expect(parseMpd(content, BASE)).toEqual({ ok: false, error: { type: 'too-many-segments' } });
		});

		it('SegmentTimeline の r が負なら弾く', () => {
			// 「Period の終わりまで」を意味するが、本数が決まらない
			const content = mpd(`<AdaptationSet contentType="video">
	<Representation id="v0">
		<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S t="0" d="10" r="-1" /></SegmentTimeline></SegmentTemplate>
	</Representation>
</AdaptationSet>`);

			expect(parseMpd(content, BASE)).toEqual({ ok: false, error: { type: 'too-many-segments' } });
		});
	});
});
