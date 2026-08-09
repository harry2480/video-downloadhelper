import { describe, expect, it } from 'vitest';
import type { Result } from '../shared/utils';
import {
	type UrlError,
	getPathExtension,
	maskSensitiveParams,
	resolveUrl,
	toDedupeKey,
} from './url';

function unwrap<T>(result: Result<T, UrlError>): T {
	if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
	return result.value;
}

describe('resolveUrl', () => {
	const base = 'https://cdn.example.com/hls/master.m3u8';

	it('同階層の相対パスを解決する', () => {
		expect(unwrap(resolveUrl('1080p/index.m3u8', base))).toBe(
			'https://cdn.example.com/hls/1080p/index.m3u8',
		);
	});

	it('ルート相対パスを解決する', () => {
		expect(unwrap(resolveUrl('/other/index.m3u8', base))).toBe(
			'https://cdn.example.com/other/index.m3u8',
		);
	});

	it('親階層への相対パスを解決する', () => {
		expect(unwrap(resolveUrl('../audio/track.m3u8', base))).toBe(
			'https://cdn.example.com/audio/track.m3u8',
		);
	});

	it('プロトコル相対 URL を base のスキームで解決する', () => {
		expect(unwrap(resolveUrl('//other.example.com/a.m3u8', base))).toBe(
			'https://other.example.com/a.m3u8',
		);
	});

	it('絶対 URL はそのまま返す', () => {
		expect(unwrap(resolveUrl('https://other.example.com/a.m3u8', base))).toBe(
			'https://other.example.com/a.m3u8',
		);
	});

	it('base が不正なら invalid-url を返す', () => {
		const result = resolveUrl('index.m3u8', 'not a url');
		expect(result).toEqual({ ok: false, error: { type: 'invalid-url', input: 'index.m3u8' } });
	});
});

describe('toDedupeKey', () => {
	it('フラグメントを除去する', () => {
		expect(unwrap(toDedupeKey('https://a.example.com/v.mp4#t=10'))).toBe(
			'https://a.example.com/v.mp4',
		);
	});

	it('デフォルトポートを除去する', () => {
		expect(unwrap(toDedupeKey('https://a.example.com:443/v.mp4'))).toBe(
			'https://a.example.com/v.mp4',
		);
		expect(unwrap(toDedupeKey('http://a.example.com:80/v.mp4'))).toBe('http://a.example.com/v.mp4');
	});

	it('デフォルトでないポートは残す', () => {
		expect(unwrap(toDedupeKey('https://a.example.com:8443/v.mp4'))).toContain(':8443');
	});

	it('ホスト名の大文字小文字を吸収する', () => {
		expect(unwrap(toDedupeKey('https://A.Example.COM/v.mp4'))).toBe(
			unwrap(toDedupeKey('https://a.example.com/v.mp4')),
		);
	});

	it('クエリパラメータの順序違いを同一とみなす', () => {
		const a = unwrap(toDedupeKey('https://a.example.com/v.m3u8?b=2&a=1'));
		const b = unwrap(toDedupeKey('https://a.example.com/v.m3u8?a=1&b=2'));
		expect(a).toBe(b);
	});

	it('ライブ HLS のリロードで変わるパラメータを無視する', () => {
		const first = unwrap(toDedupeKey('https://a.example.com/live.m3u8?_HLS_msn=100&_HLS_part=2'));
		const second = unwrap(toDedupeKey('https://a.example.com/live.m3u8?_HLS_msn=101&_HLS_part=0'));
		expect(first).toBe(second);
		expect(first).toBe('https://a.example.com/live.m3u8');
	});

	it('キャッシュバスターを無視する', () => {
		const first = unwrap(toDedupeKey('https://a.example.com/v.m3u8?_=1700000000000'));
		const second = unwrap(toDedupeKey('https://a.example.com/v.m3u8?_=1700000009999'));
		expect(first).toBe(second);
	});

	it('同名パラメータは値でも安定した順序に並べる', () => {
		const a = unwrap(toDedupeKey('https://a.example.com/v.m3u8?x=2&x=1'));
		const b = unwrap(toDedupeKey('https://a.example.com/v.m3u8?x=1&x=2'));

		expect(a).toBe(b);
	});

	it('認証トークンは残す（別ストリームを同一視しないため）', () => {
		const a = unwrap(toDedupeKey('https://a.example.com/v.m3u8?token=aaa'));
		const b = unwrap(toDedupeKey('https://a.example.com/v.m3u8?token=bbb'));
		expect(a).not.toBe(b);
	});

	it('パスの違いは区別する', () => {
		const a = unwrap(toDedupeKey('https://a.example.com/1080p/v.m3u8'));
		const b = unwrap(toDedupeKey('https://a.example.com/720p/v.m3u8'));
		expect(a).not.toBe(b);
	});

	it('不正な URL は invalid-url を返す', () => {
		expect(toDedupeKey('not a url').ok).toBe(false);
	});
});

describe('getPathExtension', () => {
	it('通常の拡張子を返す', () => {
		expect(getPathExtension('https://a.example.com/v.mp4')).toBe('mp4');
	});

	it('クエリやフラグメントに引きずられない', () => {
		expect(getPathExtension('https://a.example.com/v.m3u8?token=abc#x')).toBe('m3u8');
	});

	it('大文字の拡張子を小文字で返す', () => {
		expect(getPathExtension('https://a.example.com/V.MP4')).toBe('mp4');
	});

	it('拡張子がなければ undefined を返す', () => {
		expect(getPathExtension('https://a.example.com/stream')).toBeUndefined();
	});

	it('パスがディレクトリで終わる場合は undefined を返す', () => {
		expect(getPathExtension('https://a.example.com/hls/')).toBeUndefined();
		expect(getPathExtension('https://a.example.com')).toBeUndefined();
	});

	it('ドットで終わる場合は undefined を返す', () => {
		expect(getPathExtension('https://a.example.com/v.')).toBeUndefined();
	});

	it('ドットファイルを拡張子として扱わない', () => {
		expect(getPathExtension('https://a.example.com/.hidden')).toBeUndefined();
	});

	it('パスにドットを含むディレクトリがあっても最後のセグメントを見る', () => {
		expect(getPathExtension('https://a.example.com/v1.2/index.m3u8')).toBe('m3u8');
	});

	it('不正な URL は undefined を返す', () => {
		expect(getPathExtension('not a url')).toBeUndefined();
	});
});

describe('maskSensitiveParams', () => {
	it('token をマスキングする', () => {
		expect(maskSensitiveParams('https://a.example.com/v.m3u8?token=secret')).toBe(
			'https://a.example.com/v.m3u8?token=***',
		);
	});

	it('接尾辞が一致するパラメータもマスキングする', () => {
		expect(maskSensitiveParams('https://a.example.com/v.m3u8?hdnts_signature=abc')).toContain(
			'signature=***',
		);
	});

	it('大文字小文字を問わずマスキングする', () => {
		expect(maskSensitiveParams('https://a.example.com/v.m3u8?Access_Token=abc')).toContain('***');
	});

	it('無関係なパラメータは残す', () => {
		expect(maskSensitiveParams('https://a.example.com/v.m3u8?quality=1080p')).toBe(
			'https://a.example.com/v.m3u8?quality=1080p',
		);
	});

	it('不正な URL はそのまま返す', () => {
		expect(maskSensitiveParams('not a url')).toBe('not a url');
	});
});
