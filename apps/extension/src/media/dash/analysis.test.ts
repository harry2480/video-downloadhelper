import { describe, expect, it } from 'vitest';
import { analyzeMpd, hasSeparateAudio } from './analysis';
import { parseMpd } from './parser';

/**
 * Popup は HLS と DASH を区別せずに扱う。同じ形の結果を返すことと、
 * 保存できない理由を取り違えないことが要点。
 */

const BASE = 'https://cdn.example.com/dash/manifest.mpd';

function unwrap(result: ReturnType<typeof analyzeMpd>) {
	if (!result.ok) throw new Error(`analyze failed: ${JSON.stringify(result.error)}`);
	return result.value;
}

function mpd(
	body: string,
	attributes = 'type="static" mediaPresentationDuration="PT100S"',
): string {
	return `<MPD ${attributes}><Period>${body}</Period></MPD>`;
}

const VIDEO_SET = `<AdaptationSet contentType="video">
	<SegmentTemplate initialization="$RepresentationID$-init.mp4" media="$RepresentationID$-$Number$.m4s" duration="10" />
	<Representation id="hi" bandwidth="4000000" width="1920" height="1080" codecs="avc1.640028" />
	<Representation id="lo" bandwidth="800000" width="640" height="360" codecs="avc1.64001f" />
</AdaptationSet>`;

describe('analyzeMpd', () => {
	it('画質一覧を高画質順に並べる', () => {
		const analysis = unwrap(analyzeMpd(mpd(VIDEO_SET), BASE));

		expect(analysis.variants?.map((variant) => variant.height)).toEqual([1080, 360]);
		expect(analysis.variants?.[0]).toMatchObject({
			id: 'v0',
			url: 'https://cdn.example.com/dash/hi-init.mp4',
			bandwidth: 4_000_000,
			videoCodec: 'avc1.640028',
		});
	});

	it('推定サイズを付ける', () => {
		// bit/s を 8 で割って秒数を掛ける
		const analysis = unwrap(analyzeMpd(mpd(VIDEO_SET), BASE));

		expect(analysis.variants?.[0]?.estimatedSize).toBe((4_000_000 / 8) * 100);
		expect(analysis.duration).toBe(100);
	});

	it('DRM を検出したら理由を返す', () => {
		const analysis = unwrap(
			analyzeMpd(
				mpd(`<AdaptationSet contentType="video">
	<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" />
	<Representation id="v" />
</AdaptationSet>`),
				BASE,
			),
		);

		expect(analysis.drm).toBe(true);
		expect(analysis.unsupportedReason).toContain('DRM');
		// 一覧は出さない。選ばせても保存できない
		expect(analysis.variants).toBeUndefined();
	});

	it('ライブは対応外として理由を返す', () => {
		const analysis = unwrap(
			analyzeMpd(mpd(VIDEO_SET, 'type="dynamic" mediaPresentationDuration="PT50S"'), BASE),
		);

		expect(analysis.unsupportedReason).toContain('ライブ');
		// 表示に使える情報は残す
		expect(analysis.duration).toBe(50);
	});

	it('映像が無ければ音声を一覧にする', () => {
		const analysis = unwrap(
			analyzeMpd(
				mpd(`<AdaptationSet contentType="audio" lang="ja">
	<SegmentTemplate initialization="a-init.mp4" media="a-$Number$.m4s" duration="10" />
	<Representation id="a" bandwidth="128000" codecs="mp4a.40.2" />
</AdaptationSet>`),
				BASE,
			),
		);

		expect(analysis.variants).toHaveLength(1);
		expect(analysis.variants?.[0]?.audioOnly).toBe(true);
		expect(analysis.variants?.[0]?.audioCodec).toBe('mp4a.40.2');
	});

	it('取得できないスキームの Representation を落とす', () => {
		// MPD の中身はページ側が決められる。相対 URL の解決結果に
		// file: や data: が現れうる
		const analysis = unwrap(
			analyzeMpd(
				mpd(`<AdaptationSet contentType="video">
	<Representation id="bad"><BaseURL>file:///etc/passwd</BaseURL></Representation>
	<Representation id="ok" width="720" height="480"><BaseURL>ok.mp4</BaseURL></Representation>
</AdaptationSet>`),
				BASE,
			),
		);

		expect(analysis.variants).toHaveLength(1);
		expect(analysis.variants?.[0]?.url).toBe('https://cdn.example.com/dash/ok.mp4');
	});

	it('取得できるものが 1 つも無ければ理由を返す', () => {
		const analysis = unwrap(
			analyzeMpd(
				mpd(`<AdaptationSet contentType="video">
	<Representation id="bad"><BaseURL>file:///etc/passwd</BaseURL></Representation>
</AdaptationSet>`),
				BASE,
			),
		);

		expect(analysis.unsupportedReason).toContain('映像');
	});

	it('字幕しか無ければ理由を返す', () => {
		const analysis = unwrap(
			analyzeMpd(
				mpd('<AdaptationSet contentType="text"><Representation id="t" /></AdaptationSet>'),
				BASE,
			),
		);

		expect(analysis.unsupportedReason).toContain('映像');
	});

	describe('属性が欠けている場合', () => {
		it('全体長が分からなければ推定サイズを出さない', () => {
			const analysis = unwrap(analyzeMpd(mpd(VIDEO_SET, 'type="static"'), BASE));

			expect(analysis.duration).toBeUndefined();
			expect(analysis.variants?.[0]?.estimatedSize).toBeUndefined();
		});

		it('帯域が分からなければ推定サイズを出さない', () => {
			const analysis = unwrap(
				analyzeMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v"><BaseURL>v.mp4</BaseURL></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(analysis.variants?.[0]?.estimatedSize).toBeUndefined();
			expect(analysis.variants?.[0]?.bandwidth).toBeUndefined();
		});

		it('全体長が 0 なら推定サイズを出さない', () => {
			// セグメントは BaseURL 由来（全体長に依らず 1 本）にして、
			// 一覧から落ちないようにする
			const analysis = unwrap(
				analyzeMpd(
					mpd(
						`<AdaptationSet contentType="video">
	<Representation id="v" bandwidth="800000"><BaseURL>v.mp4</BaseURL></Representation>
</AdaptationSet>`,
						'type="static" mediaPresentationDuration="PT0S"',
					),
					BASE,
				),
			);

			expect(analysis.variants?.[0]?.estimatedSize).toBeUndefined();
		});

		it('解像度が同じなら帯域の大きい順に並べる', () => {
			const analysis = unwrap(
				analyzeMpd(
					mpd(`<AdaptationSet contentType="video">
	<SegmentTemplate initialization="$RepresentationID$.mp4" media="$RepresentationID$-$Number$.m4s" duration="10" />
	<Representation id="a" bandwidth="1000000" width="1280" height="720" />
	<Representation id="b" bandwidth="3000000" width="1280" height="720" />
</AdaptationSet>`),
					BASE,
				),
			);

			expect(analysis.variants?.map((variant) => variant.bandwidth)).toEqual([
				3_000_000, 1_000_000,
			]);
		});

		it('フレームレートがあれば載せる', () => {
			const analysis = unwrap(
				analyzeMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="v" frameRate="60"><BaseURL>v.mp4</BaseURL></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(analysis.variants?.[0]?.fps).toBe(60);
		});

		it('解像度も帯域も無ければ並び順を保つ', () => {
			const analysis = unwrap(
				analyzeMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="a"><BaseURL>a.mp4</BaseURL></Representation>
	<Representation id="b"><BaseURL>b.mp4</BaseURL></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(analysis.variants?.map((variant) => variant.url)).toEqual([
				'https://cdn.example.com/dash/a.mp4',
				'https://cdn.example.com/dash/b.mp4',
			]);
		});

		it('ライブで全体長が分からなくても理由を返す', () => {
			const analysis = unwrap(analyzeMpd(mpd(VIDEO_SET, 'type="dynamic"'), BASE));

			expect(analysis.duration).toBeUndefined();
			expect(analysis.unsupportedReason).toContain('ライブ');
		});

		it('全体長が分からない DRM でも理由を返す', () => {
			const analysis = unwrap(
				analyzeMpd(
					mpd(
						`<AdaptationSet contentType="video">
	<ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95" />
	<Representation id="v" />
</AdaptationSet>`,
						'type="static"',
					),
					BASE,
				),
			);

			expect(analysis.unsupportedReason).toContain('DRM');
		});

		it('全体長が分からず映像も無ければ理由だけを返す', () => {
			const analysis = unwrap(
				analyzeMpd(
					mpd(
						'<AdaptationSet contentType="text"><Representation id="t" /></AdaptationSet>',
						'type="static"',
					),
					BASE,
				),
			);

			expect(analysis.duration).toBeUndefined();
			expect(analysis.unsupportedReason).toContain('映像');
		});
	});

	describe('一覧へ出さない Representation', () => {
		it('id が無いものは出さない', () => {
			// **選択を運べない。** 一覧へ出すと、選んだのと違う画質（先頭）が
			// 保存される
			const analysis = unwrap(
				analyzeMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation width="1920" height="1080"><BaseURL>a.mp4</BaseURL></Representation>
	<Representation id="ok" width="640" height="360"><BaseURL>b.mp4</BaseURL></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(analysis.variants).toHaveLength(1);
			expect(analysis.variants?.[0]?.sourceId).toBe('ok');
		});

		it('id が長すぎるものは出さない', () => {
			// メッセージの上限を超えると要求ごと捨てられ、保存が始まらないまま
			// 「取得中」で止まる
			const analysis = unwrap(
				analyzeMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="${'x'.repeat(257)}"><BaseURL>a.mp4</BaseURL></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(analysis.unsupportedReason).toContain('映像');
		});

		it('セグメントが 1 本も無いものは出さない', () => {
			// 押せるのに保存できない状態を作らない
			const analysis = unwrap(
				analyzeMpd(
					mpd(`<AdaptationSet contentType="video">
	<Representation id="empty"><SegmentTemplate initialization="init.mp4" /></Representation>
</AdaptationSet>`),
					BASE,
				),
			);

			expect(analysis.unsupportedReason).toContain('映像');
		});

		it('複数 Period は理由を出す', () => {
			// 解析できないのではなく、対応していない
			const content = `<MPD type="static" mediaPresentationDuration="PT20S">
	<Period><AdaptationSet contentType="video">
		<Representation id="a"><BaseURL>a.mp4</BaseURL></Representation>
	</AdaptationSet></Period>
	<Period><AdaptationSet contentType="video">
		<Representation id="b"><BaseURL>b.mp4</BaseURL></Representation>
	</AdaptationSet></Period>
</MPD>`;

			expect(unwrap(analyzeMpd(content, BASE)).unsupportedReason).toContain('Period');
		});

		it('再生時間が桁あふれしていれば全体長として扱わない', () => {
			// Infinity を通すと本数の算出や推定サイズが壊れる
			const analysis = unwrap(
				analyzeMpd(
					mpd(VIDEO_SET, `type="static" mediaPresentationDuration="PT${'9'.repeat(400)}S"`),
					BASE,
				),
			);

			expect(analysis.duration).toBeUndefined();
			expect(analysis.variants?.[0]?.estimatedSize).toBeUndefined();
		});
	});

	describe('異常系', () => {
		it('MPD でなければ not-an-mpd', () => {
			expect(analyzeMpd('#EXTM3U', BASE)).toEqual({ ok: false, error: { type: 'not-an-mpd' } });
		});

		it('XML として壊れていれば unparsable', () => {
			expect(analyzeMpd('<MPD><Period></MPD>', BASE)).toEqual({
				ok: false,
				error: { type: 'unparsable' },
			});
		});
	});
});

describe('hasSeparateAudio', () => {
	function parse(content: string) {
		const parsed = parseMpd(content, BASE);
		if (!parsed.ok) throw new Error('parse failed');
		return parsed.value;
	}

	it('音声の AdaptationSet があれば真', () => {
		const parsed = parse(
			mpd(
				`${VIDEO_SET}<AdaptationSet contentType="audio"><Representation id="a" /></AdaptationSet>`,
			),
		);

		expect(hasSeparateAudio(parsed)).toBe(true);
	});

	it('映像だけなら偽', () => {
		expect(hasSeparateAudio(parse(mpd(VIDEO_SET)))).toBe(false);
	});
});
