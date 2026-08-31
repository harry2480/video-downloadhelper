import { describe, expect, it } from 'vitest';
import type { MediaVariant } from '../shared/types';
import { resolveSelectedVariant, variantKey } from './variant-selection';

/**
 * 位置ベースの `id` を覚えることで起きる取り違えを防げているかを見る。
 * 「別の品質を黙って指す」ことがないのが最も重要な性質。
 */

function variant(overrides: Partial<MediaVariant> = {}): MediaVariant {
	return {
		id: 'v0',
		url: 'https://cdn.example.com/1080.m3u8',
		width: 1920,
		height: 1080,
		bandwidth: 5_200_000,
		...overrides,
	};
}

const v1080 = variant();
const v720 = variant({
	id: 'v1',
	url: 'https://cdn.example.com/720.m3u8',
	width: 1280,
	height: 720,
	bandwidth: 2_500_000,
});
const v480 = variant({
	id: 'v2',
	url: 'https://cdn.example.com/480.m3u8',
	width: 854,
	height: 480,
	bandwidth: 1_000_000,
});

describe('variantKey', () => {
	it('id が振り直されても同じ品質なら同じ値になる', () => {
		// 再解析で並び順が変わり v1 → v0 になった、という状況
		expect(variantKey(v720)).toBe(variantKey({ ...v720, id: 'v0' }));
	});

	it('URL が違えば別の値になる', () => {
		expect(variantKey(v1080)).not.toBe(variantKey(v720));
	});

	it('URL が同じでもコーデックが違えば別の値になる', () => {
		const h264 = variant({ videoCodec: 'avc1.640028' });
		const hevc = variant({ videoCodec: 'hvc1.1.6.L120.90' });

		expect(variantKey(h264)).not.toBe(variantKey(hevc));
	});

	it('キャッシュバスターだけが違えば同じ値になる', () => {
		// ライブ HLS の再読み込みでは _hls_msn や cb だけが変わる。
		// ここで別物とみなすと、更新のたびに選択が既定へ戻る
		expect(variantKey(variant({ url: 'https://cdn.example.com/720.m3u8?cb=1' }))).toBe(
			variantKey(variant({ url: 'https://cdn.example.com/720.m3u8?cb=2' })),
		);
		expect(variantKey(variant({ url: 'https://cdn.example.com/720.m3u8?_HLS_msn=10' }))).toBe(
			variantKey(variant({ url: 'https://cdn.example.com/720.m3u8?_hls_msn=11' })),
		);
	});

	it('認証トークンが違えば別の値になる', () => {
		// 正規化はトークンを残す。落とすと本来別物のストリームまで同一視する
		expect(variantKey(variant({ url: 'https://cdn.example.com/720.m3u8?token=a' }))).not.toBe(
			variantKey(variant({ url: 'https://cdn.example.com/720.m3u8?token=b' })),
		);
	});

	it('正規化できない URL でも区別が付く', () => {
		expect(variantKey(variant({ url: 'not a url' }))).not.toBe(
			variantKey(variant({ url: 'also not a url' })),
		);
	});

	it('音声のみかどうかで別の値になる', () => {
		// DASH では音声と映像の Representation が BaseURL を共有しうる。
		// 映像側に解像度が無く帯域も近いと、これが無いと衝突する
		const base = variant({ width: undefined, height: undefined, bandwidth: 128_000 });

		expect(variantKey({ ...base, audioOnly: true })).not.toBe(
			variantKey({ ...base, audioOnly: false }),
		);
	});

	it('推定サイズの有無では変わらない', () => {
		// 再生時間が後から分かって付くだけで、品質が変わったわけではない。
		// ここで変わると、解析が進むたびに選択が既定へ戻ってしまう
		expect(variantKey(v1080)).toBe(variantKey({ ...v1080, estimatedSize: 1_234_567 }));
	});

	it('未指定の属性と null 相当を混同しない', () => {
		// [url, bandwidth, width, height, ...] を連結するだけだと、
		// 属性の欠落と隣の値のずれが同じ文字列になりうる
		expect(variantKey(variant({ width: undefined, height: 1080 }))).not.toBe(
			variantKey(variant({ width: 1080, height: undefined })),
		);
	});
});

describe('resolveSelectedVariant', () => {
	it('未選択なら先頭（最高品質）を返す', () => {
		expect(resolveSelectedVariant([v1080, v720, v480], undefined)).toBe(v1080);
	});

	it('選んだ品質を返す', () => {
		expect(resolveSelectedVariant([v1080, v720, v480], variantKey(v720))).toBe(v720);
	});

	it('id が振り直されても選んだ品質を返す', () => {
		// 480p が消えて 3 本 → 2 本になり、720p の id が v1 → v1 のままでも
		// 1080p が消えれば v0 になる。key で引くので影響を受けない
		const reanalyzed = [
			{ ...v720, id: 'v0' },
			{ ...v480, id: 'v1' },
		];

		expect(resolveSelectedVariant(reanalyzed, variantKey(v720))?.url).toBe(v720.url);
	});

	it('選んだ品質が消えていたら先頭へ戻す', () => {
		// **一覧に無い品質を指したままにしない。** そのままにすると
		// ラジオがどれも選択されず、保存ボタンも出なくなる
		expect(resolveSelectedVariant([v1080, v720], variantKey(v480))).toBe(v1080);
	});

	it('一覧が空なら undefined を返す', () => {
		expect(resolveSelectedVariant([], undefined)).toBeUndefined();
		expect(resolveSelectedVariant([], variantKey(v1080))).toBeUndefined();
	});

	it('返すのは必ず一覧に含まれる要素', () => {
		const variants = [v1080, v720, v480];

		for (const key of [undefined, variantKey(v720), variantKey(v480), 'かつて存在した品質']) {
			const resolved = resolveSelectedVariant(variants, key);
			expect(variants).toContain(resolved);
		}
	});
});
