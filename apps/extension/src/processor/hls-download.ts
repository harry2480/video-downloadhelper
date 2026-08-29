import type { ParsedMediaPlaylist } from '../media/hls/types';
import { type Result, err, ok } from '../shared/utils';

/**
 * HLS の保存計画（要件定義 2.3）。
 *
 * Phase 1 は TS セグメントの単純連結のみを対象とする。それ以外は
 * 「取得してから失敗する」のではなく、取りかかる前に理由を返す。
 */

/** 保存できない理由。そのままユーザーへ出せる文言にする。 */
const LIVE = 'ライブ配信の保存には未対応です';
const FMP4 = 'fMP4 セグメントの HLS には未対応です';
const ENCRYPTED = '暗号化された HLS には未対応です';
const DRM = 'この動画は DRM で保護されているため対応していません';
const BYTE_RANGE = 'バイトレンジ指定のセグメントには未対応です';
const NO_SEGMENTS = 'セグメントが見つかりませんでした';

type HlsDownloadPlan = {
	/** 取得する順に並んだセグメントの絶対 URL */
	segmentUrls: string[];
	/** 秒。進捗の表示や推定に使う */
	totalDuration: number;
};

type HlsDownloadRejection = { reason: string };

/**
 * Media Playlist から保存計画を組み立てる。
 *
 * **未対応の条件をここで出し切る。** 取得を始めてから気づくと、
 * 通信を無駄にしたうえでユーザーを待たせることになる。
 */
export function planHlsDownload(
	playlist: ParsedMediaPlaylist,
): Result<HlsDownloadPlan, HlsDownloadRejection> {
	if (playlist.encryption.method === 'drm') return err({ reason: DRM });
	if (playlist.encryption.method === 'aes-128') return err({ reason: ENCRYPTED });
	if (playlist.isLive) return err({ reason: LIVE });
	if (playlist.segmentFormat === 'fmp4') return err({ reason: FMP4 });
	if (playlist.segments.length === 0) return err({ reason: NO_SEGMENTS });

	// バイトレンジは 1 ファイルを複数セグメントで共有する。範囲を無視して
	// 連結すると同じ内容を繰り返した壊れたファイルになる
	if (playlist.segments.some((segment) => segment.byteRange !== undefined)) {
		return err({ reason: BYTE_RANGE });
	}

	return ok({
		segmentUrls: playlist.segments.map((segment) => segment.uri),
		totalDuration: playlist.totalDuration,
	});
}
