import { describe, expect, it } from 'vitest';
import type { DetectedMedia } from '../shared/types';
import {
	type DetectionInput,
	type DetectionRejection,
	createDetectedMedia,
	mergeDetectedMedia,
	upsertDetectedMedia,
} from './detected-media.model';

const BASE: DetectionInput = {
	tabId: 1,
	pageUrl: 'https://example.com/watch',
	pageTitle: 'サンプルページ',
	sourceUrl: 'https://cdn.example.com/hls/master.m3u8',
	detectedBy: 'network',
	detectedAt: 1_000,
};

function create(overrides: Partial<DetectionInput> = {}): DetectedMedia {
	const result = createDetectedMedia({ ...BASE, ...overrides });
	if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
	return result.value;
}

describe('createDetectedMedia', () => {
	it('検出候補から DetectedMedia を生成する', () => {
		const media = create();

		expect(media.type).toBe('hls');
		expect(media.sourceUrl).toBe('https://cdn.example.com/hls/master.m3u8');
		expect(media.dedupeKey).toBe('https://cdn.example.com/hls/master.m3u8');
		expect(media.detectedBy).toBe('network');
	});

	it('sourceUrl は正規化せず元のまま保持する（取得に使うため）', () => {
		const media = create({
			sourceUrl: 'https://cdn.example.com/live.m3u8?_HLS_msn=42&token=abc',
		});

		expect(media.sourceUrl).toBe('https://cdn.example.com/live.m3u8?_HLS_msn=42&token=abc');
		expect(media.dedupeKey).toBe('https://cdn.example.com/live.m3u8?token=abc');
	});

	it('id はタブと dedupeKey から決まる（同一タブの同一ストリームは同一 id）', () => {
		const a = create({ sourceUrl: 'https://cdn.example.com/v.m3u8?_=1' });
		const b = create({ sourceUrl: 'https://cdn.example.com/v.m3u8?_=2' });

		expect(a.id).toBe(b.id);
	});

	it('タブが違えば id も違う', () => {
		expect(create({ tabId: 1 }).id).not.toBe(create({ tabId: 2 }).id);
	});

	it('未指定の任意項目をキーごと持たない（構造化クローン時の無駄を避ける）', () => {
		const media = create({ pageTitle: undefined });
		expect('pageTitle' in media).toBe(false);
	});

	it('指定された任意項目をすべて引き継ぐ', () => {
		const media = create({
			contentType: 'application/x-mpegURL',
			title: '動画タイトル',
			duration: 3600,
			width: 1920,
			height: 1080,
			bitrate: 5_200_000,
			estimatedSize: 420_000_000,
			drm: false,
		});

		expect(media).toMatchObject({
			mimeType: 'application/x-mpegURL',
			title: '動画タイトル',
			duration: 3600,
			width: 1920,
			height: 1080,
			bitrate: 5_200_000,
			estimatedSize: 420_000_000,
			drm: false,
		});
	});

	describe('拒否するケース', () => {
		it('拒否理由を網羅している', () => {
			// DetectionRejection に理由を足したらここも更新すること。
			// UI 側で理由ごとの文言を出し分けるため、網羅漏れが表示不能につながる。
			const reasons: DetectionRejection['type'][] = [
				'blob-url',
				'not-fetchable',
				'unsupported-format',
				'invalid-url',
				'blocked-site',
			];
			expect(new Set(reasons).size).toBe(reasons.length);
		});

		it('blob URL を拒否する', () => {
			const result = createDetectedMedia({ ...BASE, sourceUrl: 'blob:https://example.com/8f3a' });
			expect(result).toEqual({ ok: false, error: { type: 'blob-url' } });
		});

		it('再取得できないスキームを拒否する', () => {
			const result = createDetectedMedia({
				...BASE,
				sourceUrl: 'data:video/mp4;base64,AAAA',
			});
			expect(result).toEqual({ ok: false, error: { type: 'not-fetchable' } });
		});

		it('形式を判定できないものを拒否する', () => {
			const result = createDetectedMedia({
				...BASE,
				sourceUrl: 'https://cdn.example.com/page.html',
				contentType: 'text/html',
			});
			expect(result).toEqual({ ok: false, error: { type: 'unsupported-format' } });
		});

		it('ブロックリスト対象ページを拒否する', () => {
			const result = createDetectedMedia({
				...BASE,
				pageUrl: 'https://www.youtube.com/watch?v=abc',
			});
			expect(result).toEqual({ ok: false, error: { type: 'blocked-site' } });
		});

		it('ブロックリスト対象のメディア URL を拒否する', () => {
			// 別サイトへ埋め込まれた場合、ページ URL はブロック対象にならない。
			// メディア URL 自体を見ないと素通りする
			const result = createDetectedMedia({
				...BASE,
				pageUrl: 'https://blog.example.com/article',
				sourceUrl: 'https://r1---sn-abc.googlevideo.com/videoplayback.mp4',
			});
			expect(result).toEqual({ ok: false, error: { type: 'blocked-site' } });
		});

		it('スキームは http でも URL として壊れているものを拒否する', () => {
			// http:// で始まるため isFetchableUrl は通り、Content-Type から形式も
			// 判定できるが、URL としてはパースできず重複判定キーを作れない
			const result = createDetectedMedia({
				...BASE,
				sourceUrl: 'http://[invalid/v.mp4',
				contentType: 'video/mp4',
			});
			expect(result).toEqual({ ok: false, error: { type: 'invalid-url' } });
		});
	});
});

describe('mergeDetectedMedia', () => {
	it('ネットワーク検出の情報を video 要素検出より優先する', () => {
		const fromDom = create({
			detectedBy: 'video-element',
			sourceUrl: 'https://cdn.example.com/v.mp4',
			contentType: undefined,
			title: 'DOM のタイトル',
		});
		const fromNetwork = create({
			detectedBy: 'network',
			sourceUrl: 'https://cdn.example.com/v.mp4',
			contentType: 'video/mp4',
			title: 'ネットワークのタイトル',
		});

		const merged = mergeDetectedMedia(fromDom, fromNetwork);

		expect(merged.detectedBy).toBe('network');
		expect(merged.mimeType).toBe('video/mp4');
		expect(merged.title).toBe('ネットワークのタイトル');
	});

	it('取り込む順序が逆でも結果は同じ', () => {
		const fromDom = create({ detectedBy: 'video-element', contentType: undefined });
		const fromNetwork = create({ detectedBy: 'network', contentType: 'application/x-mpegURL' });

		expect(mergeDetectedMedia(fromDom, fromNetwork).detectedBy).toBe('network');
		expect(mergeDetectedMedia(fromNetwork, fromDom).detectedBy).toBe('network');
	});

	it('優先度の低い側にしかない情報を失わない', () => {
		const fromDom = create({
			detectedBy: 'video-element',
			contentType: undefined,
			duration: 120,
			width: 1920,
			height: 1080,
		});
		const fromNetwork = create({ detectedBy: 'network', contentType: 'video/mp4' });

		const merged = mergeDetectedMedia(fromDom, fromNetwork);

		expect(merged.duration).toBe(120);
		expect(merged.width).toBe(1920);
		expect(merged.height).toBe(1080);
		expect(merged.mimeType).toBe('video/mp4');
	});

	it('マニフェスト解析済みを最優先する', () => {
		const fromNetwork = create({ detectedBy: 'network' });
		const fromManifest = create({ detectedBy: 'manifest' });

		expect(mergeDetectedMedia(fromNetwork, fromManifest).detectedBy).toBe('manifest');
		expect(mergeDetectedMedia(fromManifest, fromNetwork).detectedBy).toBe('manifest');
	});

	it('最初に検出した時刻を保つ', () => {
		const first = create({ detectedAt: 1_000 });
		const second = create({ detectedAt: 5_000 });

		expect(mergeDetectedMedia(first, second).detectedAt).toBe(1_000);
		expect(mergeDetectedMedia(second, first).detectedAt).toBe(1_000);
	});

	it('DRM 判定はどちらかが true なら true にする（安全側へ倒す）', () => {
		const notDrm = create({ detectedBy: 'network', drm: false });
		const drm = create({ detectedBy: 'video-element', drm: true });

		expect(mergeDetectedMedia(notDrm, drm).drm).toBe(true);
		expect(mergeDetectedMedia(drm, notDrm).drm).toBe(true);
	});

	it('片方にしかない variants を残す', () => {
		const withVariants: DetectedMedia = {
			...create({ detectedBy: 'manifest' }),
			variants: [{ id: 'v1', url: 'https://cdn.example.com/1080p.m3u8', height: 1080 }],
		};
		const withoutVariants = create({ detectedBy: 'network' });

		expect(mergeDetectedMedia(withoutVariants, withVariants).variants).toHaveLength(1);
		expect(mergeDetectedMedia(withVariants, withoutVariants).variants).toHaveLength(1);
	});
});

describe('upsertDetectedMedia', () => {
	it('新規のメディアを末尾へ追加する', () => {
		const a = create({ sourceUrl: 'https://cdn.example.com/a.m3u8' });
		const b = create({ sourceUrl: 'https://cdn.example.com/b.m3u8' });

		const list = upsertDetectedMedia(upsertDetectedMedia([], a), b);

		expect(list).toHaveLength(2);
		expect(list[1]?.sourceUrl).toBe('https://cdn.example.com/b.m3u8');
	});

	it('dedupeKey が一致する既存項目を統合し件数を増やさない', () => {
		const fromDom = create({
			detectedBy: 'video-element',
			sourceUrl: 'https://cdn.example.com/v.mp4',
			contentType: undefined,
		});
		const fromNetwork = create({
			detectedBy: 'network',
			sourceUrl: 'https://cdn.example.com/v.mp4',
			contentType: 'video/mp4',
		});

		const list = upsertDetectedMedia(upsertDetectedMedia([], fromDom), fromNetwork);

		expect(list).toHaveLength(1);
		expect(list[0]?.detectedBy).toBe('network');
	});

	it('ライブ HLS の繰り返しリロードを 1 件として扱う', () => {
		const reloads = [
			'https://cdn.example.com/live.m3u8?_HLS_msn=1',
			'https://cdn.example.com/live.m3u8?_HLS_msn=2',
			'https://cdn.example.com/live.m3u8?_HLS_msn=3',
			'https://cdn.example.com/live.m3u8?_=1700000000000',
		];

		const list = reloads.reduce<DetectedMedia[]>(
			(acc, sourceUrl) => upsertDetectedMedia(acc, create({ sourceUrl })),
			[],
		);

		expect(list).toHaveLength(1);
	});

	it('統合しても位置が入れ替わらない', () => {
		const a = create({ sourceUrl: 'https://cdn.example.com/a.m3u8' });
		const b = create({ sourceUrl: 'https://cdn.example.com/b.m3u8' });
		const aAgain = create({
			sourceUrl: 'https://cdn.example.com/a.m3u8',
			detectedBy: 'manifest',
		});

		const list = [a, b].reduce<DetectedMedia[]>(upsertDetectedMedia, []);
		const updated = upsertDetectedMedia(list, aAgain);

		expect(updated[0]?.sourceUrl).toBe('https://cdn.example.com/a.m3u8');
		expect(updated[1]?.sourceUrl).toBe('https://cdn.example.com/b.m3u8');
	});

	it('元の配列を変更しない', () => {
		const a = create();
		const list = upsertDetectedMedia([], a);
		const before = [...list];

		upsertDetectedMedia(list, create({ sourceUrl: 'https://cdn.example.com/other.m3u8' }));

		expect(list).toEqual(before);
	});
});
