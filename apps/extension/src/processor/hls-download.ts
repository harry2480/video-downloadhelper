import type { ParsedMediaPlaylist } from '../media/hls/types';
import { type Result, err, isHttpUrl, isPrivateHostUrl, ok } from '../shared/utils';

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
const UNSAFE_SEGMENT = '取得できない URL のセグメントが含まれています';
const TOO_MANY_SEGMENTS = 'セグメントが多すぎます';

/**
 * 扱うセグメント数の上限。
 *
 * プレイリストの中身はページ側が決められる。上限がないと、1 回の保存操作で
 * いくらでもリクエストを出させられる（要件定義 12 章）。
 * 10 秒セグメントなら 20,000 本で 55 時間ぶん。VOD の実用範囲を十分に超える。
 */
const MAX_SEGMENTS = 20_000;

type HlsDownloadPlan = {
	/** 取得する順に並んだセグメントの絶対 URL */
	segmentUrls: string[];
	/** 秒。進捗の表示や推定に使う */
	totalDuration: number;
};

type HlsDownloadRejection = { reason: string };

type PlanOptions = {
	/**
	 * プライベートネットワーク宛のセグメントを許すか。
	 *
	 * 検出元のメディア URL 自体がプライベートな場合にのみ真にする。
	 * 判断の材料はページが差し替えられない値（webRequest で観測した URL）に置く。
	 */
	allowPrivateHosts?: boolean;
};

/**
 * Media Playlist から保存計画を組み立てる。
 *
 * **未対応の条件をここで出し切る。** 取得を始めてから気づくと、
 * 通信を無駄にしたうえでユーザーを待たせることになる。
 */
export function planHlsDownload(
	playlist: ParsedMediaPlaylist,
	options: PlanOptions = {},
): Result<HlsDownloadPlan, HlsDownloadRejection> {
	if (playlist.encryption.method === 'drm') return err({ reason: DRM });
	if (playlist.encryption.method === 'aes-128') return err({ reason: ENCRYPTED });
	if (playlist.isLive) return err({ reason: LIVE });
	// segmentFormat が 'unknown' なのは拡張子の無い URL のとき。fMP4 の判定は
	// #EXT-X-MAP の有無で行うため、ここで弾く必要はない
	if (playlist.segmentFormat === 'fmp4') return err({ reason: FMP4 });
	if (playlist.segments.length === 0) return err({ reason: NO_SEGMENTS });
	if (playlist.segments.length > MAX_SEGMENTS) return err({ reason: TOO_MANY_SEGMENTS });

	// バイトレンジは 1 ファイルを複数セグメントで共有する。範囲を無視して
	// 連結すると同じ内容を繰り返した壊れたファイルになる
	if (playlist.segments.some((segment) => segment.byteRange !== undefined)) {
		return err({ reason: BYTE_RANGE });
	}

	// **セグメントの宛先をここで確かめる。** マニフェストの行が絶対 URI なら
	// 基準 URL を上書きするため、`file:` やイントラネットのアドレスを
	// 書き込める。Cookie 付きで取りに行く以上、素通しにはできない
	if (!playlist.segments.every((segment) => isAllowedTarget(segment.uri, options))) {
		return err({ reason: UNSAFE_SEGMENT });
	}

	return ok({
		segmentUrls: playlist.segments.map((segment) => segment.uri),
		totalDuration: playlist.totalDuration,
	});
}

function isAllowedTarget(url: string, options: PlanOptions): boolean {
	if (!isHttpUrl(url)) return false;

	// 公開ページから LAN やループバックを叩かせない。検出元自体が
	// プライベートなら（自宅のメディアサーバー等）そのまま許す
	return options.allowPrivateHosts === true || !isPrivateHostUrl(url);
}
