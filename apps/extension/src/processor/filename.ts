import { isMediaExtension } from '../media/media-type';
import type { DetectedMedia, MediaType, MediaVariant } from '../shared/types';

/**
 * 保存ファイル名の自動生成（要件定義 2.1）。
 *
 * タイトルはページ由来の任意文字列であり、そのままファイル名にできない。
 * ここで安全な形へ落とし込む。`chrome.downloads` は不正なファイル名を
 * 受け取るとダウンロード自体を失敗させるため、通す前に整える必要がある。
 */

/**
 * ファイル名に使えない文字（Windows の制限が最も厳しいためそれに合わせる）。
 * 制御文字も落とす。ハイフンやスペースは正当な文字なので残す。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の除去に必要
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Windows の予約デバイス名。大文字小文字を問わない。
 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i;

/**
 * Windows の予約デバイス名かどうか。
 *
 * **最初のドットより前で判定すること。** Windows はデバイス名を拡張子より
 * 前の部分で解決するため、`CON.txt` も `CON` デバイスとして扱われる。
 * 全体で比較すると `CON.txt.mp4` を作れてしまい、保存時に失敗する。
 */
function isReservedName(base: string): boolean {
	const dotIndex = base.indexOf('.');
	const firstSegment = dotIndex === -1 ? base : base.slice(0, dotIndex);
	return RESERVED_NAMES.test(firstSegment.trim());
}

/**
 * ベース名の上限（UTF-8 バイト数）。
 *
 * 多くのファイルシステムはファイル名を 255 バイトで制限する。
 * 解像度の接尾辞（`_2160p`）と拡張子（`.webm`）の分を残して見積もる。
 *
 * **文字数で切ってはいけない。** 日本語は 1 文字 3 バイト、絵文字は
 * 4 バイトになるため、文字数で抑えてもバイト数の上限を超え得る。
 */
const MAX_BASE_BYTES = 200;

const UTF8_ENCODER = new TextEncoder();

/**
 * UTF-8 バイト数で切り詰める。
 *
 * **コードポイント単位で数えること。** `slice` は UTF-16 コードユニット
 * 単位で切るため、絵文字などのサロゲートペアを分断して不正な文字を残す。
 */
function truncateToByteLength(input: string, maxBytes: number): string {
	if (UTF8_ENCODER.encode(input).byteLength <= maxBytes) return input;

	let result = '';
	let bytes = 0;
	for (const character of input) {
		const size = UTF8_ENCODER.encode(character).byteLength;
		if (bytes + size > maxBytes) break;
		result += character;
		bytes += size;
	}

	return result;
}

const EXTENSION_BY_TYPE: Record<MediaType, string> = {
	// Phase 1 の HLS は TS セグメントの単純連結。.ts として出力する
	hls: 'ts',
	dash: 'mp4',
	direct: 'mp4',
	audio: 'm4a',
	unknown: 'bin',
};

/** URL のパスから拡張子を取り出す。クエリに引きずられないよう pathname のみ見る。 */
function extensionFromUrl(url: string): string | undefined {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return undefined;
	}

	const lastSegment = pathname.split('/').pop();
	if (!lastSegment) return undefined;

	const dotIndex = lastSegment.lastIndexOf('.');
	if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) return undefined;

	const extension = lastSegment.slice(dotIndex + 1).toLowerCase();

	// **既知のメディア拡張子だけを採用する。** URL のパスはページ側が決められるため、
	// `Content-Type: video/mp4` を返しつつ `/setup.exe` を指すことができる。
	// 保存ダイアログを出さない以上、実行ファイル名で着地させない
	return isMediaExtension(extension) ? extension : undefined;
}

/**
 * 任意の文字列をファイル名の一部として安全な形にする。
 *
 * 空になった場合は呼び出し側が既定値へ倒す。
 */
export function sanitizeFilenameBase(input: string): string {
	const cleaned = input
		.replace(ILLEGAL_CHARACTERS, ' ')
		// 連続する空白をまとめる。改行・タブも空白として扱う
		.replace(/\s+/g, ' ')
		.trim()
		// 先頭のドットを落とす。Unix で隠しファイルになるほか、
		// 「../../etc/passwd」のような入力が「.. .. etc passwd」として残る
		.replace(/^[.\s]+/, '')
		// 末尾のドットとスペースは Windows が黙って落とすため先に落とす
		.replace(/[.\s]+$/, '');

	// 切り詰めた末尾がドットやスペースで終わらないよう、切ってから整える
	return truncateToByteLength(cleaned, MAX_BASE_BYTES).replace(/[.\s]+$/, '');
}

/** 解像度を接尾辞にする。縦の画素数を基準にする。 */
function resolutionSuffix(height: number | undefined): string | undefined {
	if (height === undefined || !Number.isFinite(height) || height <= 0) return undefined;
	return `${Math.round(height)}p`;
}

type FilenameInput = {
	media: DetectedMedia;
	/** 選択された品質。解像度と拡張子の決定に使う */
	variant?: MediaVariant;
};

/**
 * 保存ファイル名を組み立てる。
 *
 * 「タイトル_解像度.拡張子」の形にする。タイトルが取れない場合は
 * URL のファイル名、それも無ければ既定名へ倒す。
 */
export function buildFilename({ media, variant }: FilenameInput): string {
	const base = pickBase(media);
	const height = variant?.height ?? media.height;
	const suffix = resolutionSuffix(height);
	const extension = pickExtension(media, variant);

	const stem = [base, suffix].filter((part) => part !== undefined).join('_');
	return `${stem}.${extension}`;
}

function pickBase(media: DetectedMedia): string {
	for (const candidate of [media.title, media.pageTitle]) {
		if (candidate === undefined) continue;
		const sanitized = sanitizeFilenameBase(candidate);
		if (sanitized.length > 0 && !isReservedName(sanitized)) return sanitized;
	}

	const fromUrl = filenameFromUrl(media.sourceUrl);
	if (fromUrl !== undefined) return fromUrl;

	return 'video';
}

function filenameFromUrl(url: string): string | undefined {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return undefined;
	}

	const lastSegment = pathname.split('/').pop();
	if (!lastSegment) return undefined;

	const dotIndex = lastSegment.lastIndexOf('.');
	const withoutExtension = dotIndex > 0 ? lastSegment.slice(0, dotIndex) : lastSegment;

	const sanitized = sanitizeFilenameBase(decodeSafely(withoutExtension));
	if (sanitized.length === 0 || isReservedName(sanitized)) return undefined;

	return sanitized;
}

function decodeSafely(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		// 不正なパーセントエンコーディング
		return value;
	}
}

/**
 * 拡張子を決める。
 *
 * HLS / DASH は URL の拡張子（.m3u8 / .mpd）が出力形式と一致しないため、
 * 種別から決める。直接メディアは URL の拡張子を優先する。
 */
function pickExtension(media: DetectedMedia, variant: MediaVariant | undefined): string {
	if (media.type === 'hls' || media.type === 'dash') return EXTENSION_BY_TYPE[media.type];

	const fromUrl = extensionFromUrl(variant?.url ?? media.sourceUrl);
	return fromUrl ?? EXTENSION_BY_TYPE[media.type];
}
