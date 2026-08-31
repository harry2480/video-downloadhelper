import type { DetectedMedia, MediaType, MediaVariant } from '../shared/types';
import { isFetchableUrl } from './media-type';

/**
 * 保存してよいメディアかの判定（要件定義 2.1 / 2.6）。
 *
 * **判定はここ 1 か所に置く。** Popup（ボタンを出すか）と Background
 * （要求を受けてよいか）で条件を二重に書くと、片方だけ更新したときに
 * 「押せるのに保存できない」「保存できるのにボタンが出ない」がすぐ起きる。
 */

/**
 * 保存できる形式。
 *
 * HLS / DASH はセグメントを取得して連結する（Offscreen Document 側）。
 * DASH で映像と音声が分かれている場合は結合が要るため、保存計画
 * （`processor/dash-download.ts`）の側で理由を出して弾く。
 */
const DOWNLOADABLE_TYPES: ReadonlySet<MediaType> = new Set<MediaType>([
	'direct',
	'audio',
	'hls',
	'dash',
]);

const DRM_REJECTED = 'DRM で保護されているため保存できません';
const NOT_DOWNLOADABLE = 'この形式の保存はまだできません';
const UNSAFE_URL = 'この URL は保存できません';
const ANALYZING = '画質を確認しています';

/**
 * 保存する URL を決める。選択された品質があればそれを使う。
 *
 * **スキームをここで確かめる。** `sourceUrl` は検出時に絞られているが、
 * variant の URL はマニフェスト由来であり、同じ関門を通っていない。
 */
export function resolveDownloadUrl(
	media: DetectedMedia,
	variant: MediaVariant | undefined,
): string | undefined {
	const url = variant?.url ?? media.sourceUrl;
	return isFetchableUrl(url) ? url : undefined;
}

/**
 * 保存できない理由。保存してよければ `undefined`。
 *
 * 理由の文言はそのままユーザーへ出せる形にしてある。
 */
export function downloadRejectionReason(
	media: DetectedMedia,
	variant?: MediaVariant,
): string | undefined {
	if (media.drm === true) return DRM_REJECTED;
	if (media.unsupportedReason !== undefined) return media.unsupportedReason;
	if (!DOWNLOADABLE_TYPES.has(media.type)) return NOT_DOWNLOADABLE;

	// 解析前に保存を始めると、マニフェストそのものを組み立てに渡すことになり
	// 必ず失敗する。画質が確定するまでは操作を出さない
	if ((media.type === 'hls' || media.type === 'dash') && media.manifestResolved !== true) {
		return ANALYZING;
	}

	if (resolveDownloadUrl(media, variant) === undefined) return UNSAFE_URL;
	return undefined;
}

/** 保存操作を提供してよいか。Popup のボタン表示に使う。 */
export function isDownloadable(media: DetectedMedia, variant?: MediaVariant): boolean {
	return downloadRejectionReason(media, variant) === undefined;
}

/**
 * 保存に未対応なだけの形式か（DRM や取得失敗と区別する）。
 *
 * Popup で「準備中」と伝えるために使う。理由が別にある場合は
 * そちらを表示するため false を返す。
 */
export function isPendingSupport(media: DetectedMedia): boolean {
	return (
		media.drm !== true &&
		media.unsupportedReason === undefined &&
		!DOWNLOADABLE_TYPES.has(media.type)
	);
}
