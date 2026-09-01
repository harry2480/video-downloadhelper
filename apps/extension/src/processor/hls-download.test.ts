import { describe, expect, it } from 'vitest';
import { ivFromSequenceNumber } from '../media/hls/decryption';
import type { HlsSegment, ParsedMediaPlaylist } from '../media/hls/types';
import { planHlsDownload } from './hls-download';

/**
 * 未対応の条件は取りかかる前に返す。取得を始めてから気づくと、
 * 通信を無駄にしたうえでユーザーを待たせる。
 */

function segment(overrides: Partial<HlsSegment> = {}): HlsSegment {
	return {
		uri: 'https://cdn.example.com/seg0.ts',
		duration: 9.009,
		sequenceNumber: 0,
		...overrides,
	};
}

function playlist(overrides: Partial<ParsedMediaPlaylist> = {}): ParsedMediaPlaylist {
	return {
		kind: 'media',
		segments: [segment(), segment({ uri: 'https://cdn.example.com/seg1.ts', sequenceNumber: 1 })],
		totalDuration: 18.018,
		isLive: false,
		segmentFormat: 'ts',
		mediaSequence: 0,
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
				segments: [
					{ url: 'https://cdn.example.com/seg0.ts' },
					{ url: 'https://cdn.example.com/seg1.ts' },
				],
				totalDuration: 18.018,
				container: 'ts',
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

	it('ライブ配信は対応しない', () => {
		const rejected = planHlsDownload(playlist({ isLive: true }));

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('ライブ');
	});

	it('http(s) 以外のセグメントを含むなら計画を作らない', () => {
		// マニフェストの行が絶対 URI なら基準 URL を上書きできる。
		// Cookie 付きで取りに行くため、素通しにすると踏み台になる
		const rejected = planHlsDownload(
			playlist({ segments: [segment(), segment({ uri: 'file:///etc/passwd' })] }),
		);

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('取得できない URL');
	});

	it('公開ページからプライベートネットワーク宛のセグメントを取りにいかない', () => {
		const rejected = planHlsDownload(
			playlist({ segments: [segment({ uri: 'http://192.168.1.1/admin/seg0.ts' })] }),
		);

		expect(rejected.ok).toBe(false);
	});

	it('検出元がプライベートならプライベート宛も許す', () => {
		// 自宅のメディアサーバーからの保存を壊さない
		const plan = planHlsDownload(
			playlist({ segments: [segment({ uri: 'http://192.168.1.10/seg0.ts' })] }),
			{ allowPrivateHosts: true },
		);

		expect(plan.ok).toBe(true);
	});

	it('セグメントが多すぎるなら対応しない', () => {
		// 1 回の保存操作でいくらでもリクエストを出させない
		const many = Array.from({ length: 20_001 }, (_, index) =>
			segment({ uri: `https://cdn.example.com/seg${index}.ts`, sequenceNumber: index }),
		);

		const rejected = planHlsDownload(playlist({ segments: many }));

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('多すぎます');
	});

	it('初期化セグメントを展開した後の本数にも上限を掛ける', () => {
		// #EXT-X-MAP はセグメントごとに切り替えられる。展開前だけを見ると、
		// 1 回の保存操作で実際に出る取得回数が倍になる
		const many = Array.from({ length: 15_000 }, (_, index) =>
			segment({
				uri: `https://cdn.example.com/seg${index}.m4s`,
				sequenceNumber: index,
				initSegment: { uri: `https://cdn.example.com/init${index}.mp4` },
			}),
		);

		const rejected = planHlsDownload(playlist({ segments: many }));

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('多すぎます');
	});

	it('鍵の種類が多すぎるなら対応しない', () => {
		// 鍵は URL ごとに 1 回しか取らないが、全部違えば重複排除が効かず、
		// セグメント数と同じだけリクエストが出る
		const many = Array.from({ length: 300 }, (_, index) =>
			segment({
				uri: `https://cdn.example.com/seg${index}.ts`,
				sequenceNumber: index,
				key: { keyUri: `https://cdn.example.com/key${index}.bin` },
			}),
		);

		const rejected = planHlsDownload(
			playlist({ encryption: { method: 'aes-128' }, segments: many }),
		);

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('鍵の種類');
	});

	it('同じ鍵を使い回すぶんには本数に関係なく通す', () => {
		const many = Array.from({ length: 1_000 }, (_, index) =>
			segment({
				uri: `https://cdn.example.com/seg${index}.ts`,
				sequenceNumber: index,
				key: { keyUri: 'https://cdn.example.com/key.bin' },
			}),
		);

		expect(
			planHlsDownload(playlist({ encryption: { method: 'aes-128' }, segments: many })).ok,
		).toBe(true);
	});

	it('拡張子から形式が分からないセグメントは通す', () => {
		// 拡張子の無い URL は珍しくない。形式の判定は #EXT-X-MAP で行う
		expect(planHlsDownload(playlist({ segmentFormat: 'unknown' })).ok).toBe(true);
	});

	it('セグメントが無ければ対応しない', () => {
		const rejected = planHlsDownload(playlist({ segments: [] }));

		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.reason).toContain('セグメント');
	});

	describe('fMP4（#EXT-X-MAP）', () => {
		it('初期化セグメントを先頭に置き、コンテナを mp4 にする', () => {
			// moov を含む初期化セグメントが先頭に無いと再生できない
			const plan = planHlsDownload(
				playlist({
					segmentFormat: 'fmp4',
					segments: [
						segment({
							uri: 'https://cdn.example.com/seg0.m4s',
							initSegment: { uri: 'https://cdn.example.com/init.mp4' },
						}),
					],
				}),
			);

			expect(plan).toEqual({
				ok: true,
				value: {
					segments: [
						{ url: 'https://cdn.example.com/init.mp4' },
						{ url: 'https://cdn.example.com/seg0.m4s' },
					],
					totalDuration: 18.018,
					container: 'mp4',
				},
			});
		});

		it('初期化セグメントが切り替わるたびに挟み直す', () => {
			// #EXT-X-MAP は不連続点をまたいで変わる。1 本目だけを先頭に置くと、
			// 後半のセグメントが誤った初期化データと組み合わされて壊れる
			const first = { uri: 'https://cdn.example.com/init-a.mp4' };
			const second = { uri: 'https://cdn.example.com/init-b.mp4' };

			const plan = planHlsDownload(
				playlist({
					segments: [
						segment({ uri: 'https://cdn.example.com/a0.m4s', initSegment: first }),
						segment({ uri: 'https://cdn.example.com/a1.m4s', initSegment: first }),
						segment({ uri: 'https://cdn.example.com/b0.m4s', initSegment: second }),
					],
				}),
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			// 同じ初期化セグメントが続く間は挟まない
			expect(plan.value.segments.map((item) => item.url)).toEqual([
				'https://cdn.example.com/init-a.mp4',
				'https://cdn.example.com/a0.m4s',
				'https://cdn.example.com/a1.m4s',
				'https://cdn.example.com/init-b.mp4',
				'https://cdn.example.com/b0.m4s',
			]);
			expect(plan.value.container).toBe('mp4');
		});

		it('初期化セグメントが途中から現れても対応する', () => {
			const plan = planHlsDownload(
				playlist({
					segments: [
						segment({ uri: 'https://cdn.example.com/a.ts' }),
						segment({
							uri: 'https://cdn.example.com/b.m4s',
							initSegment: { uri: 'https://cdn.example.com/init.mp4' },
						}),
					],
				}),
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments.map((item) => item.url)).toEqual([
				'https://cdn.example.com/a.ts',
				'https://cdn.example.com/init.mp4',
				'https://cdn.example.com/b.m4s',
			]);
			expect(plan.value.container).toBe('mp4');
		});

		it('同じ内容の #EXT-X-MAP が再宣言されても重複させない', () => {
			// パーサーは行ごとに新しいオブジェクトを作る。同一性で比べると、
			// 不連続点ごとに同じ MAP を書く構成で init が二重に出力され、
			// ファイル中央に 2 つ目の ftyp+moov が現れる
			const plan = planHlsDownload(
				playlist({
					segments: [
						segment({
							uri: 'https://cdn.example.com/a.m4s',
							initSegment: { uri: 'https://cdn.example.com/init.mp4' },
						}),
						segment({
							uri: 'https://cdn.example.com/b.m4s',
							initSegment: { uri: 'https://cdn.example.com/init.mp4' },
						}),
					],
				}),
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments.map((item) => item.url)).toEqual([
				'https://cdn.example.com/init.mp4',
				'https://cdn.example.com/a.m4s',
				'https://cdn.example.com/b.m4s',
			]);
		});

		it('バイトレンジが違えば別の初期化セグメントとして扱う', () => {
			const plan = planHlsDownload(
				playlist({
					segments: [
						segment({
							uri: 'https://cdn.example.com/a.m4s',
							initSegment: {
								uri: 'https://cdn.example.com/all.mp4',
								byteRange: { length: 100, offset: 0 },
							},
						}),
						segment({
							uri: 'https://cdn.example.com/b.m4s',
							initSegment: {
								uri: 'https://cdn.example.com/all.mp4',
								byteRange: { length: 100, offset: 200 },
							},
						}),
					],
				}),
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments).toHaveLength(4);
		});

		it('初期化セグメントの無い fMP4 は保存できない', () => {
			// moov を含む 1 本が無いまま連結しても再生できない。
			// 解析が fMP4 を一律で弾かなくなったぶん、ここで出し切る
			const rejected = planHlsDownload(
				playlist({
					segmentFormat: 'fmp4',
					segments: [segment({ uri: 'https://cdn.example.com/seg0.m4s' })],
				}),
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('初期化セグメント');
		});

		it('初期化セグメントの宛先も確かめる', () => {
			const rejected = planHlsDownload(
				playlist({ segments: [segment({ initSegment: { uri: 'file:///etc/passwd' } })] }),
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('取得できない URL');
		});

		it('初期化セグメントのバイトレンジも引き継ぐ', () => {
			const plan = planHlsDownload(
				playlist({
					segments: [
						segment({
							initSegment: {
								uri: 'https://cdn.example.com/all.mp4',
								byteRange: { length: 800, offset: 0 },
							},
						}),
					],
				}),
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments[0]).toEqual({
				url: 'https://cdn.example.com/all.mp4',
				byteRange: { length: 800, offset: 0 },
			});
		});
	});

	describe('バイトレンジ（#EXT-X-BYTERANGE）', () => {
		it('範囲を計画へ引き継ぐ', () => {
			// 範囲を無視して連結すると、同じ内容を繰り返した壊れたファイルになる
			const plan = planHlsDownload(
				playlist({
					segments: [
						segment({
							uri: 'https://cdn.example.com/all.ts',
							byteRange: { length: 100, offset: 0 },
						}),
						segment({
							uri: 'https://cdn.example.com/all.ts',
							byteRange: { length: 120, offset: 100 },
							sequenceNumber: 1,
						}),
					],
				}),
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments).toEqual([
				{ url: 'https://cdn.example.com/all.ts', byteRange: { length: 100, offset: 0 } },
				{ url: 'https://cdn.example.com/all.ts', byteRange: { length: 120, offset: 100 } },
			]);
		});
	});

	describe('AES-128', () => {
		const KEY_URL = 'https://cdn.example.com/key.bin';

		it('鍵の URL と IV を計画へ載せる', () => {
			const plan = planHlsDownload(
				playlist({
					encryption: { method: 'aes-128' },
					segments: [
						segment({ key: { keyUri: KEY_URL, iv: '0x00000000000000000000000000000009' } }),
					],
				}),
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments[0]?.decryption?.keyUrl).toBe(KEY_URL);
			expect(plan.value.segments[0]?.decryption?.iv).toEqual(ivFromSequenceNumber(9));
		});

		it('IV が省略されていればシーケンス番号から導出する', () => {
			const plan = planHlsDownload(
				playlist({
					encryption: { method: 'aes-128' },
					segments: [segment({ key: { keyUri: KEY_URL }, sequenceNumber: 42 })],
				}),
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments[0]?.decryption?.iv).toEqual(ivFromSequenceNumber(42));
		});

		it('鍵ごとに別の復号材料を持つ', () => {
			// #EXT-X-KEY はプレイリストの途中で切り替わる。1 つだけ覚えると
			// 一部のセグメントが復号できないまま保存される
			const plan = planHlsDownload(
				playlist({
					encryption: { method: 'aes-128' },
					segments: [
						segment({ key: { keyUri: KEY_URL } }),
						segment({ key: { keyUri: 'https://cdn.example.com/key2.bin' }, sequenceNumber: 1 }),
					],
				}),
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments.map((item) => item.decryption?.keyUrl)).toEqual([
				KEY_URL,
				'https://cdn.example.com/key2.bin',
			]);
		});

		it('鍵の URI が無ければ対応しない', () => {
			// 平文として扱うと暗号文をそのまま保存してしまう
			const rejected = planHlsDownload(
				playlist({ encryption: { method: 'aes-128' }, segments: [segment({ key: {} })] }),
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('鍵');
		});

		it('IV が壊れていれば対応しない', () => {
			const rejected = planHlsDownload(
				playlist({
					encryption: { method: 'aes-128' },
					segments: [segment({ key: { keyUri: KEY_URL, iv: '0xzz' } })],
				}),
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('鍵');
		});

		it('鍵の宛先にもセグメントと同じ物差しを当てる', () => {
			const rejected = planHlsDownload(
				playlist({
					encryption: { method: 'aes-128' },
					segments: [segment({ key: { keyUri: 'http://192.168.1.1/key.bin' } })],
				}),
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('鍵');
		});

		it('暗号化とバイトレンジが同時でも両方を引き継ぐ', () => {
			const plan = planHlsDownload(
				playlist({
					encryption: { method: 'aes-128' },
					segments: [
						segment({
							uri: 'https://cdn.example.com/all.ts',
							byteRange: { length: 100, offset: 0 },
							key: { keyUri: KEY_URL },
						}),
					],
				}),
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments[0]).toEqual({
				url: 'https://cdn.example.com/all.ts',
				byteRange: { length: 100, offset: 0 },
				decryption: { keyUrl: KEY_URL, iv: ivFromSequenceNumber(0) },
			});
		});

		it('初期化セグメントにも鍵を適用する', () => {
			// RFC 8216 は #EXT-X-MAP にも直前の #EXT-X-KEY を適用する。
			// 平文として扱うと、結合したファイルの先頭だけが壊れる
			const iv = '0x0000000000000000000000000000000a';
			const plan = planHlsDownload(
				playlist({
					encryption: { method: 'aes-128' },
					mediaSequence: 3,
					segments: [
						segment({
							key: { keyUri: KEY_URL },
							sequenceNumber: 3,
							initSegment: {
								uri: 'https://cdn.example.com/init.mp4',
								key: { keyUri: KEY_URL, iv },
							},
						}),
					],
				}),
			);

			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.value.segments[0]?.decryption).toEqual({
				keyUrl: KEY_URL,
				iv: ivFromSequenceNumber(10),
			});
		});

		it('暗号化された初期化セグメントに IV が無ければ保存しない', () => {
			// **番号からの導出は規定されていない**（RFC 8216 4.3.2.5 は
			// 暗号化された #EXT-X-MAP に IV を必須としている）。実際の IV と
			// 違えば AES-CBC の先頭ブロックだけが壊れ、ftyp を含む先頭が
			// 壊れた mp4 になる。保存は成功したように見えるので、より悪い
			const rejected = planHlsDownload(
				playlist({
					encryption: { method: 'aes-128' },
					segments: [
						segment({
							key: { keyUri: KEY_URL, iv: '0x00000000000000000000000000000001' },
							initSegment: {
								uri: 'https://cdn.example.com/init.mp4',
								key: { keyUri: KEY_URL },
							},
						}),
					],
				}),
			);

			expect(rejected.ok).toBe(false);
			if (rejected.ok) return;
			expect(rejected.error.reason).toContain('IV');
		});

		it('平文の初期化セグメントには IV を求めない', () => {
			const plan = planHlsDownload(
				playlist({
					segments: [segment({ initSegment: { uri: 'https://cdn.example.com/init.mp4' } })],
				}),
			);

			expect(plan.ok).toBe(true);
		});
	});
});
