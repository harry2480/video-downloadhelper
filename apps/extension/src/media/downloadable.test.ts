import { describe, expect, it } from 'vitest';
import type { DetectedMedia, MediaVariant } from '../shared/types';
import {
	downloadRejectionReason,
	isDownloadable,
	isPendingSupport,
	resolveDownloadUrl,
} from './downloadable';

/**
 * 保存可否の判定は Popup（ボタンを出すか）と Background（要求を受けるか）の
 * 両方が使う。ここが唯一の判断基準になる。
 */

function media(overrides: Partial<DetectedMedia> = {}): DetectedMedia {
	return {
		id: '1:https://cdn.example.com/v.mp4',
		tabId: 1,
		pageUrl: 'https://example.com/watch',
		sourceUrl: 'https://cdn.example.com/v.mp4',
		dedupeKey: 'https://cdn.example.com/v.mp4',
		type: 'direct',
		detectedBy: 'network',
		detectedAt: 1_000,
		...overrides,
	};
}

const variant = (url: string): MediaVariant => ({ id: 'v0', url });

describe('resolveDownloadUrl', () => {
	it('選択された品質の URL を優先する', () => {
		expect(resolveDownloadUrl(media(), variant('https://cdn.example.com/720.mp4'))).toBe(
			'https://cdn.example.com/720.mp4',
		);
	});

	it('品質の指定がなければ検出した URL を使う', () => {
		expect(resolveDownloadUrl(media(), undefined)).toBe('https://cdn.example.com/v.mp4');
	});

	it('http(s) 以外の品質 URL は採用しない', () => {
		// variant の URL はマニフェスト由来で、検出時の関門を通っていない
		expect(resolveDownloadUrl(media(), variant('file:///etc/passwd'))).toBeUndefined();
		expect(resolveDownloadUrl(media(), variant('data:video/mp4;base64,AAAA'))).toBeUndefined();
		expect(resolveDownloadUrl(media(), variant('javascript:alert(1)'))).toBeUndefined();
	});
});

describe('downloadRejectionReason', () => {
	it('直接メディアは保存できる', () => {
		expect(downloadRejectionReason(media())).toBeUndefined();
		expect(downloadRejectionReason(media({ type: 'audio' }))).toBeUndefined();
		expect(isDownloadable(media())).toBe(true);
	});

	it('DRM は保存しない', () => {
		expect(downloadRejectionReason(media({ drm: true }))).toContain('DRM');
	});

	it('対応外の理由があればそれを返す', () => {
		expect(downloadRejectionReason(media({ unsupportedReason: '取得できませんでした' }))).toBe(
			'取得できませんでした',
		);
	});

	it('HLS / DASH はまだ保存できない', () => {
		expect(downloadRejectionReason(media({ type: 'hls' }))).toContain('まだ');
		expect(downloadRejectionReason(media({ type: 'dash' }))).toContain('まだ');
	});

	it('保存できない URL を弾く', () => {
		expect(downloadRejectionReason(media(), variant('file:///etc/passwd'))).toContain('URL');
		expect(isDownloadable(media(), variant('file:///etc/passwd'))).toBe(false);
	});

	it('DRM の判定を URL の判定より先に出す', () => {
		// 理由が複数あるときは、より重い理由を伝える
		expect(downloadRejectionReason(media({ drm: true }), variant('file:///etc/passwd'))).toContain(
			'DRM',
		);
	});
});

describe('isPendingSupport', () => {
	it('未対応の形式だけを準備中として扱う', () => {
		expect(isPendingSupport(media({ type: 'hls' }))).toBe(true);
		expect(isPendingSupport(media())).toBe(false);
	});

	it('DRM や取得失敗は準備中に含めない', () => {
		// 「準備中」と出すと、待てば対応されるかのように読める
		expect(isPendingSupport(media({ type: 'hls', drm: true }))).toBe(false);
		expect(isPendingSupport(media({ type: 'hls', unsupportedReason: '取得できません' }))).toBe(
			false,
		);
	});
});
