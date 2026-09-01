import { describe, expect, it } from 'vitest';
import type { DashAdaptationSet, DashRepresentation, ParsedMpd } from '../media/dash/types';
import { planDashDownload } from './dash-download';

/**
 * 未対応の条件は取りかかる前に返す。取得を始めてから気づくと、
 * 通信を無駄にしたうえでユーザーを待たせる。
 */

function representation(overrides: Partial<DashRepresentation> = {}): DashRepresentation {
	return {
		id: 'v0',
		initSegment: { uri: 'https://cdn.example.com/dash/init.mp4' },
		segments: [
			{ uri: 'https://cdn.example.com/dash/1.m4s' },
			{ uri: 'https://cdn.example.com/dash/2.m4s' },
		],
		...overrides,
	};
}

function videoSet(overrides: Partial<DashAdaptationSet> = {}): DashAdaptationSet {
	return { contentType: 'video', representations: [representation()], ...overrides };
}

function mpd(overrides: Partial<ParsedMpd> = {}): ParsedMpd {
	return { isLive: false, duration: 20, adaptationSets: [videoSet()], ...overrides };
}

describe('planDashDownload', () => {
	it('初期化セグメントを先頭に置いて並べる', () => {
		const plan = planDashDownload(mpd());

		expect(plan).toEqual({
			ok: true,
			value: {
				segments: [
					{ url: 'https://cdn.example.com/dash/init.mp4' },
					{ url: 'https://cdn.example.com/dash/1.m4s' },
					{ url: 'https://cdn.example.com/dash/2.m4s' },
				],
				totalDuration: 20,
				container: 'mp4',
			},
		});
	});

	it('バイトレンジを引き継ぐ', () => {
		const plan = planDashDownload(
			mpd({
				adaptationSets: [
					videoSet({
						representations: [
							representation({
								initSegment: {
									uri: 'https://cdn.example.com/dash/all.mp4',
									byteRange: { offset: 0, length: 800 },
								},
								segments: [
									{
										uri: 'https://cdn.example.com/dash/all.mp4',
										byteRange: { offset: 800, length: 1_000 },
									},
								],
							}),
						],
					}),
				],
			}),
		);

		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.value.segments).toEqual([
			{ url: 'https://cdn.example.com/dash/all.mp4', byteRange: { offset: 0, length: 800 } },
			{ url: 'https://cdn.example.com/dash/all.mp4', byteRange: { offset: 800, length: 1_000 } },
		]);
	});

	it('DRM は対応しない', () => {
		const rejected = planDashDownload(mpd({ drmReason: 'Widevine' }));

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('DRM');
	});

	it('ライブは対応しない', () => {
		const rejected = planDashDownload(mpd({ isLive: true }));

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('ライブ');
	});

	describe('映像と音声が分かれている場合', () => {
		const audioRepresentation = representation({
			id: 'a0',
			bandwidth: 128_000,
			initSegment: { uri: 'https://cdn.example.com/dash/a-init.mp4' },
			segments: [{ uri: 'https://cdn.example.com/dash/a-1.m4s' }],
		});

		const separated = mpd({
			adaptationSets: [
				videoSet(),
				{ contentType: 'audio', representations: [audioRepresentation] },
			],
		});

		it('結合できなければ対応しない', () => {
			// 映像だけを保存すると「音の出ない動画」が黙って出来上がる
			const rejected = planDashDownload(separated);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('結合');
		});

		it('結合できるなら音声側の並びも返す', () => {
			const plan = planDashDownload(separated, { canMux: true });

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.audioSegments?.map((segment) => segment.url)).toEqual([
				'https://cdn.example.com/dash/a-init.mp4',
				'https://cdn.example.com/dash/a-1.m4s',
			]);
		});

		it('音声は帯域が最も大きいものを採る', () => {
			// 音声の品質はユーザーに選ばせていない。映像に見合うものを既定にする
			const plan = planDashDownload(
				mpd({
					adaptationSets: [
						videoSet(),
						{
							contentType: 'audio',
							representations: [
								representation({
									id: 'low',
									bandwidth: 64_000,
									segments: [{ uri: 'https://cdn.example.com/dash/low.m4s' }],
								}),
								representation({
									id: 'high',
									bandwidth: 256_000,
									segments: [{ uri: 'https://cdn.example.com/dash/high.m4s' }],
								}),
							],
						},
					],
				}),
				{ canMux: true },
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.audioSegments?.at(-1)?.url).toBe('https://cdn.example.com/dash/high.m4s');
		});

		it('帯域が分からない音声も比べられる', () => {
			const plan = planDashDownload(
				mpd({
					adaptationSets: [
						videoSet(),
						{
							contentType: 'audio',
							representations: [
								{ id: 'unknown', segments: [{ uri: 'https://cdn.example.com/dash/u.m4s' }] },
								representation({
									id: 'known',
									bandwidth: 128_000,
									segments: [{ uri: 'https://cdn.example.com/dash/k.m4s' }],
								}),
								{ id: 'unknown2', segments: [{ uri: 'https://cdn.example.com/dash/u2.m4s' }] },
							],
						},
					],
				}),
				{ canMux: true },
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.audioSegments?.at(-1)?.url).toBe('https://cdn.example.com/dash/k.m4s');
		});

		it('全体長が分からなくても結合の計画を作る', () => {
			const plan = planDashDownload(
				{
					isLive: false,
					adaptationSets: [
						videoSet(),
						{ contentType: 'audio', representations: [audioRepresentation] },
					],
				},
				{ canMux: true },
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.totalDuration).toBe(0);
		});

		it('音声側のセグメントが無ければ対応しない', () => {
			const rejected = planDashDownload(
				mpd({
					adaptationSets: [
						videoSet(),
						{ contentType: 'audio', representations: [representation({ id: 'a', segments: [] })] },
					],
				}),
				{ canMux: true },
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('音声');
		});

		it('音声側の宛先も確かめる', () => {
			const rejected = planDashDownload(
				mpd({
					adaptationSets: [
						videoSet(),
						{
							contentType: 'audio',
							representations: [
								representation({ id: 'a', segments: [{ uri: 'file:///etc/passwd' }] }),
							],
						},
					],
				}),
				{ canMux: true },
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('取得できない URL');
		});

		it('音声側のセグメントが多すぎれば対応しない', () => {
			const many = Array.from({ length: 20_001 }, (_, index) => ({
				uri: `https://cdn.example.com/dash/a${index}.m4s`,
			}));

			const rejected = planDashDownload(
				mpd({
					adaptationSets: [
						videoSet(),
						{
							contentType: 'audio',
							representations: [representation({ id: 'a', segments: many })],
						},
					],
				}),
				{ canMux: true },
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('多すぎます');
		});

		it('音声が 1 本で全体を成すなら上限を渡す', () => {
			const plan = planDashDownload(
				mpd({
					adaptationSets: [
						videoSet(),
						{
							contentType: 'audio',
							representations: [
								{ id: 'a', segments: [{ uri: 'https://cdn.example.com/dash/whole.m4a' }] },
							],
						},
					],
				}),
				{ canMux: true, singleSegmentMaxBytes: 1_000 },
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.audioSegments?.[0]?.maxBytes).toBe(1_000);
		});
	});

	it('字幕が別にあっても映像だけなら保存できる', () => {
		const plan = planDashDownload(
			mpd({
				adaptationSets: [
					videoSet(),
					{ contentType: 'text', representations: [representation({ id: 't' })] },
				],
			}),
		);

		expect(plan.ok).toBe(true);
	});

	it('映像が無ければ音声を保存する', () => {
		const plan = planDashDownload(
			mpd({
				adaptationSets: [{ contentType: 'audio', representations: [representation({ id: 'a' })] }],
			}),
		);

		expect(plan.ok).toBe(true);
	});

	describe('Representation の選択', () => {
		const hi = representation({
			id: 'hi',
			initSegment: { uri: 'https://cdn.example.com/dash/hi-init.mp4' },
			segments: [{ uri: 'https://cdn.example.com/dash/hi-1.m4s' }],
		});
		const lo = representation({
			id: 'lo',
			initSegment: { uri: 'https://cdn.example.com/dash/lo-init.mp4' },
			segments: [{ uri: 'https://cdn.example.com/dash/lo-1.m4s' }],
		});
		const both = mpd({ adaptationSets: [videoSet({ representations: [hi, lo] })] });

		it('指定した id の Representation を選ぶ', () => {
			// **位置でも URL でもなく、配信側が付けた識別子で選ぶ。**
			// 位置は再解析で変わり、URL は署名付きなら取得のたびに変わる
			const plan = planDashDownload(both, { representationId: 'lo' });

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments.map((segment) => segment.url)).toEqual([
				'https://cdn.example.com/dash/lo-init.mp4',
				'https://cdn.example.com/dash/lo-1.m4s',
			]);
		});

		it('指定が無ければ先頭を選ぶ', () => {
			const plan = planDashDownload(both);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments[0]?.url).toBe('https://cdn.example.com/dash/hi-init.mp4');
		});

		it('指定した Representation が消えていたら既定へ落とさず失敗させる', () => {
			// 既定へ落とすと、意図しない画質で保存してしまう
			const rejected = planDashDownload(both, { representationId: 'gone' });

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('選択した画質');
		});

		it('初期化セグメントが無い Representation も選べる', () => {
			const plain: DashRepresentation = {
				id: 'p',
				segments: [{ uri: 'https://cdn.example.com/p.mp4' }],
			};

			const plan = planDashDownload(
				mpd({ adaptationSets: [videoSet({ representations: [plain] })] }),
				{ representationId: 'p' },
			);

			expect(plan.ok).toBe(true);
		});

		it('id が重複していれば選ばない', () => {
			// 仕様違反の MPD。先頭へ落とすと意図しない画質で保存してしまう
			const rejected = planDashDownload(
				mpd({
					adaptationSets: [
						videoSet({
							representations: [
								representation({ id: 'dup' }),
								representation({
									id: 'dup',
									initSegment: { uri: 'https://cdn.example.com/other.mp4' },
								}),
							],
						}),
					],
				}),
				{ representationId: 'dup' },
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('選択した画質');
		});
	});

	describe('宛先の検証', () => {
		it('http(s) 以外を含むなら計画を作らない', () => {
			// MPD の中身はページ側が決められる。Cookie 付きで取りに行くため
			// 素通しにすると踏み台になる
			const rejected = planDashDownload(
				mpd({
					adaptationSets: [
						videoSet({
							representations: [representation({ segments: [{ uri: 'file:///etc/passwd' }] })],
						}),
					],
				}),
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('取得できない URL');
		});

		it('公開ページからプライベートネットワーク宛を取りにいかない', () => {
			const rejected = planDashDownload(
				mpd({
					adaptationSets: [
						videoSet({
							representations: [
								representation({ segments: [{ uri: 'http://192.168.1.1/seg.m4s' }] }),
							],
						}),
					],
				}),
			);

			expect(rejected.ok).toBe(false);
		});

		it('検出元がプライベートならプライベート宛も許す', () => {
			const plan = planDashDownload(
				mpd({
					adaptationSets: [
						videoSet({
							representations: [
								representation({
									initSegment: { uri: 'http://192.168.1.10/init.mp4' },
									segments: [{ uri: 'http://192.168.1.10/seg.m4s' }],
								}),
							],
						}),
					],
				}),
				{ allowPrivateHosts: true },
			);

			expect(plan.ok).toBe(true);
		});
	});

	describe('上限', () => {
		it('セグメントが多すぎるなら対応しない', () => {
			const many = Array.from({ length: 20_001 }, (_, index) => ({
				uri: `https://cdn.example.com/dash/${index}.m4s`,
			}));

			const rejected = planDashDownload(
				mpd({
					adaptationSets: [videoSet({ representations: [representation({ segments: many })] })],
				}),
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('多すぎます');
		});

		it('セグメントが無ければ対応しない', () => {
			const rejected = planDashDownload(
				mpd({
					adaptationSets: [videoSet({ representations: [representation({ segments: [] })] })],
				}),
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('セグメント');
		});

		it('AdaptationSet が無ければ対応しない', () => {
			const rejected = planDashDownload(mpd({ adaptationSets: [] }));

			expect(rejected.ok).toBe(false);
		});

		it('映像でも音声でもない AdaptationSet だけなら対応しない', () => {
			const rejected = planDashDownload(
				mpd({ adaptationSets: [{ contentType: 'text', representations: [representation()] }] }),
			);

			expect(rejected.ok).toBe(false);
		});
	});

	describe('1 本で全体を成す構成', () => {
		it('上限を渡せばその 1 本に適用する', () => {
			// SegmentBase の DASH はセグメントに分かれていない。
			// セグメント 1 本ぶんの上限（64MB）では大きな動画が必ず失敗する
			const single: DashRepresentation = {
				id: 'whole',
				segments: [{ uri: 'https://cdn.example.com/whole.mp4' }],
			};

			const plan = planDashDownload(
				mpd({ adaptationSets: [videoSet({ representations: [single] })] }),
				{ singleSegmentMaxBytes: 2 * 1024 * 1024 * 1024 },
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments[0]?.maxBytes).toBe(2 * 1024 * 1024 * 1024);
		});

		it('複数セグメントには適用しない', () => {
			const plan = planDashDownload(mpd(), { singleSegmentMaxBytes: 1_000 });

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments.every((segment) => segment.maxBytes === undefined)).toBe(true);
		});
	});

	it('再生時間が分からなければ 0 として返す', () => {
		const plan = planDashDownload({
			isLive: false,
			adaptationSets: [videoSet()],
		});

		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.value.totalDuration).toBe(0);
	});
});
