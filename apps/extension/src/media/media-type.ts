import type { MediaType } from '../shared/types';
import { getPathExtension } from './url';

/**
 * メディア形式の判定（要件定義 6 章）。
 *
 * Content-Type を第一の根拠とし、取得できない場合や汎用的すぎる場合に
 * URL の拡張子へフォールバックする。
 * サーバーが `application/octet-stream` や `binary/octet-stream` を返すことは
 * 珍しくないため、Content-Type があっても拡張子判定を諦めない。
 */

const MIME_TO_TYPE: Record<string, MediaType> = {
	// HLS
	'application/vnd.apple.mpegurl': 'hls',
	'application/x-mpegurl': 'hls',
	'audio/mpegurl': 'hls',
	'audio/x-mpegurl': 'hls',
	// DASH
	'application/dash+xml': 'dash',
	// 映像
	'video/mp4': 'direct',
	'video/webm': 'direct',
	'video/quicktime': 'direct',
	'video/x-m4v': 'direct',
	'video/ogg': 'direct',
	// 音声
	'audio/mpeg': 'audio',
	'audio/mp4': 'audio',
	'audio/aac': 'audio',
	'audio/ogg': 'audio',
	'audio/opus': 'audio',
	'audio/webm': 'audio',
	'audio/flac': 'audio',
	'audio/wav': 'audio',
};

const EXTENSION_TO_TYPE: Record<string, MediaType> = {
	m3u8: 'hls',
	m3u: 'hls',
	mpd: 'dash',
	mp4: 'direct',
	webm: 'direct',
	mov: 'direct',
	m4v: 'direct',
	ogv: 'direct',
	mp3: 'audio',
	m4a: 'audio',
	aac: 'audio',
	opus: 'audio',
	oga: 'audio',
	flac: 'audio',
	wav: 'audio',
};

/**
 * Content-Type ヘッダー値からパラメータ（`; charset=utf-8` 等）を落として
 * 小文字の MIME タイプだけを取り出す。
 */
export function normalizeMimeType(contentType: string): string {
	const separatorIndex = contentType.indexOf(';');
	const mime = separatorIndex === -1 ? contentType : contentType.slice(0, separatorIndex);
	return mime.trim().toLowerCase();
}

/**
 * Content-Type と URL からメディア形式を判定する。
 *
 * 音声は `direct` ではなく `audio` として扱う。どちらも直接ダウンロード可能だが、
 * UI 上の表示と品質選択の要否が異なるため区別する。
 */
export function detectMediaType(input: {
	url: string;
	contentType?: string;
}): MediaType {
	if (input.contentType) {
		const mime = normalizeMimeType(input.contentType);
		const byMime = MIME_TO_TYPE[mime];
		if (byMime) return byMime;
	}

	const extension = getPathExtension(input.url);
	if (extension) {
		const byExtension = EXTENSION_TO_TYPE[extension];
		if (byExtension) return byExtension;
	}

	return 'unknown';
}

/**
 * 保存ファイル名に使ってよい拡張子か。
 *
 * URL のパスはページ側が決められるため、そのまま拡張子にすると
 * `.exe` や `.html` で保存させられる。判定表にあるものだけを通す。
 */
export function isMediaExtension(extension: string): boolean {
	return Object.hasOwn(EXTENSION_TO_TYPE, extension.toLowerCase());
}

/** ダウンロード対象になり得る形式か（`unknown` は一覧に出さない）。 */
export function isSupportedMediaType(type: MediaType): boolean {
	return type !== 'unknown';
}

/** 品質選択 UI を出す必要がある形式か。 */
export function requiresVariantSelection(type: MediaType): boolean {
	return type === 'hls' || type === 'dash';
}

/**
 * `blob:` URL は保存対象にしない。
 * ページ内で組み立てられた参照であり、拡張機能側から取得しても
 * 元ストリームを復元できるとは限らない（要件定義 2.2 / 8 章）。
 */
export function isBlobUrl(url: string): boolean {
	return url.startsWith('blob:');
}

/** 拡張機能から再取得できないスキームか。 */
export function isFetchableUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}
