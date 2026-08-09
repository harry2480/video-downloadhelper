import type { MediaVariant } from '../../shared/types';
import { classifyCodecs } from '../codecs';
import { detectPlaylistKind, parseMasterPlaylist, parseMediaPlaylist } from './parser';
import type { ParsedMasterPlaylist, ParsedMediaPlaylist } from './types';

/**
 * 取得済みのマニフェスト文字列から、UI と保存処理が必要とする情報を取り出す。
 *
 * 副作用を持たない。取得は MediaFetcherPort の実装が担う。
 */

type HlsAnalysis = {
	variants?: MediaVariant[];
	drm?: boolean;
	/** 秒。Media Playlist を直接指していた場合のみ得られる */
	duration?: number;
	/** 保存できない場合の理由（要件定義 2.1） */
	unsupportedReason?: string;
};

type HlsAnalysisError = { type: 'not-a-playlist' } | { type: 'unparsable' };

/** Phase 1 は TS セグメントのみ対象。単純連結で .ts として出力する。 */
const FMP4_UNSUPPORTED = 'fMP4 セグメントの HLS には未対応です';
const DRM_UNSUPPORTED = 'この動画は DRM で保護されているため対応していません';
const LIVE_UNSUPPORTED = 'ライブ配信の保存には未対応です';

/**
 * Variant の推定ファイルサイズ（バイト）。
 *
 * BANDWIDTH は bit/s なので 8 で割る。再生時間が不明なら推定できない。
 */
export function estimateVariantSize(
	bandwidth: number | undefined,
	durationSeconds: number | undefined,
): number | undefined {
	if (bandwidth === undefined || bandwidth <= 0) return undefined;
	if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		return undefined;
	}
	return Math.round((bandwidth / 8) * durationSeconds);
}

function toMediaVariants(parsed: ParsedMasterPlaylist): MediaVariant[] {
	// 並べ替えは map より前に行う。BANDWIDTH は #EXT-X-STREAM-INF の必須属性で
	// この時点では必ず存在するため、既定値の分岐を持たずに済む。
	// 高画質を先頭にする。既定で最高品質を選ばせるため（要件定義 4.4）
	return [...parsed.variants]
		.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)
		.map(
			(variant, index): MediaVariant => ({
				id: `v${index}`,
				url: variant.uri,
				...(variant.width !== undefined && { width: variant.width }),
				...(variant.height !== undefined && { height: variant.height }),
				bandwidth: variant.bandwidth,
				...(variant.frameRate !== undefined && { fps: variant.frameRate }),
				// CODECS は順不同。並び順で映像・音声を決めない
				...classifyCodecs(variant.codecs),
			}),
		);
}

function analyzeMaster(parsed: ParsedMasterPlaylist): HlsAnalysis {
	if (parsed.drmReason !== undefined) {
		return { drm: true, unsupportedReason: DRM_UNSUPPORTED };
	}
	return { variants: toMediaVariants(parsed) };
}

function analyzeMedia(parsed: ParsedMediaPlaylist): HlsAnalysis {
	if (parsed.encryption.method === 'drm') {
		return { drm: true, unsupportedReason: DRM_UNSUPPORTED };
	}

	const duration = parsed.totalDuration > 0 ? parsed.totalDuration : undefined;

	if (parsed.isLive) {
		return { ...(duration !== undefined && { duration }), unsupportedReason: LIVE_UNSUPPORTED };
	}
	if (parsed.segmentFormat === 'fmp4') {
		return { ...(duration !== undefined && { duration }), unsupportedReason: FMP4_UNSUPPORTED };
	}

	return { ...(duration !== undefined && { duration }) };
}

/**
 * Master / Media のどちらであるかを判定して解析する。
 *
 * 再フェッチした時点ではどちらか分からないため、内容から判定する。
 */
export function analyzeHlsManifest(
	content: string,
	baseUrl: string,
): { ok: true; value: HlsAnalysis } | { ok: false; error: HlsAnalysisError } {
	const kind = detectPlaylistKind(content);
	if (kind === undefined) return { ok: false, error: { type: 'not-a-playlist' } };

	if (kind === 'master') {
		const parsed = parseMasterPlaylist(content, baseUrl);
		if (!parsed.ok) return { ok: false, error: { type: 'unparsable' } };
		return { ok: true, value: analyzeMaster(parsed.value) };
	}

	const parsed = parseMediaPlaylist(content, baseUrl);
	if (!parsed.ok) return { ok: false, error: { type: 'unparsable' } };
	return { ok: true, value: analyzeMedia(parsed.value) };
}

/** 解析結果に推定サイズを反映した Variant 一覧を返す。 */
export function withEstimatedSizes(
	variants: MediaVariant[],
	durationSeconds: number | undefined,
): MediaVariant[] {
	return variants.map((variant) => {
		const estimatedSize = estimateVariantSize(variant.bandwidth, durationSeconds);
		return estimatedSize === undefined ? variant : { ...variant, estimatedSize };
	});
}
