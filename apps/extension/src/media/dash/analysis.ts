import type { MediaVariant } from '../../shared/types';
import { classifyCodecs } from '../codecs';
import { isFetchableUrl } from '../media-type';
import { parseMpd } from './parser';
import type { DashAdaptationSet, DashRepresentation, ParsedMpd } from './types';

/**
 * 取得済みの MPD から、UI と保存処理が必要とする情報を取り出す。
 *
 * 副作用を持たない。取得は MediaFetcherPort の実装が担う。
 * HLS 側（`media/hls/analysis.ts`）と同じ形の結果を返し、Popup からは
 * 区別せずに扱えるようにする。
 */

const DRM_UNSUPPORTED = 'この動画は DRM で保護されているため対応していません';
const LIVE_UNSUPPORTED = 'ライブ配信の保存には未対応です';
const NO_VIDEO = '保存できる映像が見つかりませんでした';

type DashAnalysis = {
	variants?: MediaVariant[];
	drm?: boolean;
	/** 秒 */
	duration?: number;
	unsupportedReason?: string;
};

type DashAnalysisError = { type: 'not-an-mpd' } | { type: 'unparsable' };

/**
 * 音声のみの AdaptationSet があるか。
 *
 * DASH は映像と音声を別の Representation へ分けられる。分かれている場合、
 * 1 本のファイルにするには結合（Mux）が要る。
 */
export function hasSeparateAudio(mpd: ParsedMpd): boolean {
	return mpd.adaptationSets.some((set) => set.contentType === 'audio');
}

/** 保存対象にする AdaptationSet（映像。無ければ音声）。 */
function pickPrimarySet(mpd: ParsedMpd): DashAdaptationSet | undefined {
	return (
		mpd.adaptationSets.find((set) => set.contentType === 'video') ??
		mpd.adaptationSets.find((set) => set.contentType === 'audio')
	);
}

/** 推定ファイルサイズ（バイト）。BANDWIDTH は bit/s なので 8 で割る。 */
function estimateSize(
	bandwidth: number | undefined,
	durationSeconds: number | undefined,
): number | undefined {
	if (bandwidth === undefined || bandwidth <= 0) return undefined;
	if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		return undefined;
	}
	return Math.round((bandwidth / 8) * durationSeconds);
}

function toVariant(
	representation: DashRepresentation,
	url: string,
	index: number,
	duration: number | undefined,
	audioOnly: boolean,
): MediaVariant {
	const estimated = estimateSize(representation.bandwidth, duration);

	return {
		id: `v${index}`,
		// **セグメントではなく Representation の id を URL 代わりに持たない。**
		// 保存対象は「初期化セグメント + セグメントの並び」であり、単一の URL では
		// 表せない。ここでは先頭セグメントの URL を代表として持ち、実際の取得は
		// 計画（processor/dash-download.ts）が MPD から組み立て直す
		url,
		...(representation.width !== undefined && { width: representation.width }),
		...(representation.height !== undefined && { height: representation.height }),
		...(representation.bandwidth !== undefined && { bandwidth: representation.bandwidth }),
		...(representation.frameRate !== undefined && { fps: representation.frameRate }),
		...classifyCodecs(representation.codecs),
		...(audioOnly && { audioOnly: true }),
		...(estimated !== undefined && { estimatedSize: estimated }),
	};
}

/**
 * MPD を解析する。
 *
 * **画質一覧は映像の AdaptationSet から作る。** 音声が別なら結合が要るが、
 * その判定は保存計画（`processor/dash-download.ts`）で行う。ここで一覧まで
 * 出さないと、対応していない理由すら表示できない。
 */
export function analyzeMpd(
	content: string,
	baseUrl: string,
): { ok: true; value: DashAnalysis } | { ok: false; error: DashAnalysisError } {
	const parsed = parseMpd(content, baseUrl);
	if (!parsed.ok) {
		return {
			ok: false,
			error: parsed.error.type === 'not-an-mpd' ? { type: 'not-an-mpd' } : { type: 'unparsable' },
		};
	}

	const mpd = parsed.value;
	const duration = mpd.duration;

	if (mpd.drmReason !== undefined) {
		return { ok: true, value: { drm: true, unsupportedReason: DRM_UNSUPPORTED } };
	}
	if (mpd.isLive) {
		return {
			ok: true,
			value: { ...(duration !== undefined && { duration }), unsupportedReason: LIVE_UNSUPPORTED },
		};
	}

	const primary = pickPrimarySet(mpd);
	if (primary === undefined) {
		return {
			ok: true,
			value: { ...(duration !== undefined && { duration }), unsupportedReason: NO_VIDEO },
		};
	}

	// **スキームをここで絞る。** MPD の中身はページ側が決められるため、
	// 相対 URL の解決結果に file: や data: が現れうる
	const usable: { representation: DashRepresentation; url: string }[] = [];
	for (const representation of primary.representations) {
		const first = representation.initSegment?.uri ?? representation.segments[0]?.uri;
		if (first !== undefined && isFetchableUrl(first)) usable.push({ representation, url: first });
	}

	if (usable.length === 0) {
		return {
			ok: true,
			value: { ...(duration !== undefined && { duration }), unsupportedReason: NO_VIDEO },
		};
	}

	// 高画質を先頭にする。既定で最高品質を選ばせるため（要件定義 4.4）
	const sorted = [...usable].sort(
		(a, b) =>
			(b.representation.height ?? 0) - (a.representation.height ?? 0) ||
			(b.representation.bandwidth ?? 0) - (a.representation.bandwidth ?? 0),
	);

	return {
		ok: true,
		value: {
			...(duration !== undefined && { duration }),
			variants: sorted.map((entry, index) =>
				toVariant(
					entry.representation,
					entry.url,
					index,
					duration,
					primary.contentType === 'audio',
				),
			),
		},
	};
}
