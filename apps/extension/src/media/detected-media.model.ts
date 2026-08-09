import type { DetectedMedia, DetectionSource, MediaType } from '../shared/types';
import { type Result, err, ok } from '../shared/utils';
import { isBlockedUrl } from './blocklist';
import { detectMediaType, isBlobUrl, isFetchableUrl, isSupportedMediaType } from './media-type';
import { toDedupeKey } from './url';

export type DetectionRejection =
	| { type: 'blob-url' }
	| { type: 'not-fetchable' }
	| { type: 'unsupported-format' }
	| { type: 'invalid-url' }
	| { type: 'blocked-site' };

export type DetectionInput = {
	tabId: number;
	pageUrl: string;
	pageTitle?: string;
	sourceUrl: string;
	detectedBy: DetectionSource;
	detectedAt: number;

	contentType?: string;
	title?: string;
	duration?: number;
	width?: number;
	height?: number;
	bitrate?: number;
	estimatedSize?: number;
	drm?: boolean;
};

/**
 * 検出候補から DetectedMedia を生成する。
 *
 * 不変条件をここで強制し、不正な状態のオブジェクトを作れないようにする。
 * - `blob:` URL は保存対象にしない
 * - 拡張機能から再取得できないスキームは対象にしない
 * - 形式が判定できないものは一覧に出さない
 * - ブロックリスト対象は取り込まない
 *
 * **ブロックリストの判定をここへ置くのが要。** 検出経路は複数あり
 * （webRequest / Content Script）、経路ごとに判定を書くと必ず漏れる。
 * ページ URL だけでなくメディア URL 自体も見る。ブロック対象サイトの
 * 動画が別サイトへ埋め込まれている場合、ページ URL は素通りするため。
 */
export function createDetectedMedia(
	input: DetectionInput,
): Result<DetectedMedia, DetectionRejection> {
	if (isBlockedUrl(input.pageUrl) || isBlockedUrl(input.sourceUrl)) {
		return err({ type: 'blocked-site' });
	}
	if (isBlobUrl(input.sourceUrl)) return err({ type: 'blob-url' });
	if (!isFetchableUrl(input.sourceUrl)) return err({ type: 'not-fetchable' });

	const type: MediaType = detectMediaType({
		url: input.sourceUrl,
		contentType: input.contentType,
	});
	if (!isSupportedMediaType(type)) return err({ type: 'unsupported-format' });

	const dedupeKey = toDedupeKey(input.sourceUrl);
	if (!dedupeKey.ok) return err({ type: 'invalid-url' });

	return ok({
		id: `${input.tabId}:${dedupeKey.value}`,
		tabId: input.tabId,
		pageUrl: input.pageUrl,
		...(input.pageTitle !== undefined && { pageTitle: input.pageTitle }),
		sourceUrl: input.sourceUrl,
		dedupeKey: dedupeKey.value,
		type,
		...(input.contentType !== undefined && { mimeType: input.contentType }),
		...(input.title !== undefined && { title: input.title }),
		...(input.duration !== undefined && { duration: input.duration }),
		...(input.width !== undefined && { width: input.width }),
		...(input.height !== undefined && { height: input.height }),
		...(input.bitrate !== undefined && { bitrate: input.bitrate }),
		...(input.estimatedSize !== undefined && { estimatedSize: input.estimatedSize }),
		detectedBy: input.detectedBy,
		...(input.drm !== undefined && { drm: input.drm }),
		detectedAt: input.detectedAt,
	});
}

/** 検出方式の優先度。大きいほど信頼できる情報とみなす。 */
const SOURCE_PRIORITY: Record<DetectionSource, number> = {
	// マニフェスト解析済みが最も情報量が多い
	manifest: 3,
	// ネットワーク検出は Content-Type を持つため DOM 検出より信頼できる
	network: 2,
	'video-element': 1,
	'audio-element': 1,
};

/**
 * 同一メディアの検出結果を 1 件へ統合する（要件定義 2.1）。
 *
 * `<video>` 要素検出とネットワーク検出の両方で同じメディアが見つかった場合、
 * **ネットワーク検出の情報を優先する**。ただし DOM 側にしかない情報
 * （動画タイトル、再生時間、解像度）は失わずに引き継ぐ。
 *
 * 呼び出し側は dedupeKey が一致することを保証すること。
 */
export function mergeDetectedMedia(
	existing: DetectedMedia,
	incoming: DetectedMedia,
): DetectedMedia {
	const incomingWins = SOURCE_PRIORITY[incoming.detectedBy] >= SOURCE_PRIORITY[existing.detectedBy];
	const primary = incomingWins ? incoming : existing;
	const secondary = incomingWins ? existing : incoming;

	const merged: DetectedMedia = {
		...secondary,
		...stripUndefined(primary),
		// 最初に検出した時刻を保つ（一覧の並び順を安定させるため）
		detectedAt: Math.min(existing.detectedAt, incoming.detectedAt),
		// variants は解析済みの情報。どちらかにあれば残す
		...pickVariants(primary, secondary),
		// DRM 判定はどちらかが true なら true（安全側へ倒す）
		...(existing.drm || incoming.drm ? { drm: true } : {}),
	};

	return merged;
}

function stripUndefined(media: DetectedMedia): Partial<DetectedMedia> {
	const entries = Object.entries(media).filter(([, value]) => value !== undefined);
	return Object.fromEntries(entries) as Partial<DetectedMedia>;
}

function pickVariants(
	primary: DetectedMedia,
	secondary: DetectedMedia,
): Pick<DetectedMedia, 'variants'> | Record<string, never> {
	const variants = primary.variants ?? secondary.variants;
	return variants ? { variants } : {};
}

/**
 * 検出結果の一覧へ 1 件を取り込む。
 *
 * dedupeKey が一致する既存項目があれば統合し、なければ末尾へ追加する。
 * 元の配列は変更せず、新しい配列を返す。
 */
export function upsertDetectedMedia(
	list: readonly DetectedMedia[],
	incoming: DetectedMedia,
): DetectedMedia[] {
	let merged = false;

	const next = list.map((existing) => {
		if (existing.dedupeKey !== incoming.dedupeKey) return existing;
		merged = true;
		return mergeDetectedMedia(existing, incoming);
	});

	return merged ? next : [...next, incoming];
}
