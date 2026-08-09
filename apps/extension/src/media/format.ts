import type { DetectedMedia, MediaType } from '../shared/types';
import { maskSensitiveParams } from './url';

/**
 * 一覧表示のための整形（要件定義 4.3）。
 *
 * 表示判断はここに集約し、コンポーネントへ埋め込まない。
 */

const KIB = 1024;
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** バイト数を人間が読める形にする。 */
export function formatBytes(bytes: number | undefined): string | undefined {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return undefined;

	let value = bytes;
	let unitIndex = 0;
	while (value >= KIB && unitIndex < SIZE_UNITS.length - 1) {
		value /= KIB;
		unitIndex += 1;
	}

	// B と KB は小数を出さない。MB 以上は 1 桁だけ出す
	const digits = unitIndex <= 1 ? 0 : 1;
	return `${value.toFixed(digits)} ${SIZE_UNITS[unitIndex]}`;
}

/** ビットレートを Mbps / kbps で表す。 */
export function formatBitrate(bitsPerSecond: number | undefined): string | undefined {
	if (bitsPerSecond === undefined || !Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) {
		return undefined;
	}

	if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
	return `${Math.round(bitsPerSecond / 1_000)} kbps`;
}

/**
 * 解像度を一般的な呼称にする。
 *
 * 縦の画素数を基準にする。横長・縦長どちらの動画でも同じ基準で並べられる。
 */
export function formatResolution(
	width: number | undefined,
	height: number | undefined,
): string | undefined {
	if (height === undefined || !Number.isFinite(height) || height <= 0) return undefined;
	if (width !== undefined && Number.isFinite(width) && width > 0 && width < height) {
		// 縦長動画は呼称が実態と合わないため実寸で出す
		return `${width}x${height}`;
	}
	return `${height}p`;
}

/** 再生時間を h:mm:ss / m:ss で表す。 */
export function formatDuration(seconds: number | undefined): string | undefined {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;

	const total = Math.round(seconds);
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const rest = total % 60;

	const pad = (value: number) => String(value).padStart(2, '0');
	if (hours > 0) return `${hours}:${pad(minutes)}:${pad(rest)}`;
	return `${minutes}:${pad(rest)}`;
}

const TYPE_LABELS: Record<MediaType, string> = {
	direct: '動画ファイル',
	hls: 'HLS',
	dash: 'DASH',
	audio: '音声',
	unknown: '不明',
};

export function formatMediaType(type: MediaType): string {
	return TYPE_LABELS[type];
}

/** 一覧に出す見出し。動画のタイトルがなければページタイトル、それもなければ URL。 */
export function formatTitle(media: DetectedMedia): string {
	const candidate = media.title?.trim() || media.pageTitle?.trim();
	if (candidate) return candidate;

	try {
		const { pathname } = new URL(media.sourceUrl);
		const filename = pathname.split('/').pop();
		if (filename) return filename;
	} catch {
		// URL として壊れている場合は下の分岐へ
	}

	return media.sourceUrl;
}

/** 配信元のホスト名。 */
export function formatHost(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

/** 詳細表示に出す URL。認証トークンはマスキングする（要件定義 12 章）。 */
export function formatUrlForDisplay(url: string): string {
	return maskSensitiveParams(url);
}

/**
 * 一覧に並べる副題。解像度・ビットレート・再生時間・サイズを 1 行にまとめる。
 * 値が揃わないことが普通なので、取れたものだけを並べる。
 */
export function formatSummary(media: DetectedMedia): string {
	return [
		formatResolution(media.width, media.height),
		formatBitrate(media.bitrate),
		formatDuration(media.duration),
		formatBytes(media.estimatedSize),
	]
		.filter((part): part is string => part !== undefined)
		.join(' / ');
}
