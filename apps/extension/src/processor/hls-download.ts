import { type SegmentDecryption, resolveSegmentDecryption } from '../media/hls/decryption';
import type { HlsByteRange, HlsSegmentKey, ParsedMediaPlaylist } from '../media/hls/types';
import { type Result, err, isHttpUrl, isPrivateHostUrl, ok } from '../shared/utils';

/**
 * HLS の保存計画（要件定義 2.3）。
 *
 * **未対応の条件をここで出し切る。** 取得を始めてから気づくと、通信を
 * 無駄にしたうえでユーザーを待たせることになる。対応が増えるたびに、
 * ここの条件を 1 つずつ外していく。
 */

/** 保存できない理由。そのままユーザーへ出せる文言にする。 */
const LIVE = 'ライブ配信の保存には未対応です';
const DRM = 'この動画は DRM で保護されているため対応していません';
const NO_KEY = '復号に必要な鍵の情報が見つかりませんでした';
const NO_SEGMENTS = 'セグメントが見つかりませんでした';
const UNSAFE_SEGMENT = '取得できない URL のセグメントが含まれています';
const UNSAFE_KEY = '取得できない URL の鍵が指定されています';
const TOO_MANY_SEGMENTS = 'セグメントが多すぎます';

/**
 * 扱うセグメント数の上限。
 *
 * プレイリストの中身はページ側が決められる。上限がないと、1 回の保存操作で
 * いくらでもリクエストを出させられる（要件定義 12 章）。
 * 10 秒セグメントなら 20,000 本で 55 時間ぶん。VOD の実用範囲を十分に超える。
 */
const MAX_SEGMENTS = 20_000;

/** 取得する 1 単位。初期化セグメントも同じ形で扱う。 */
export type PlannedSegment = {
	/** 解決済みの絶対 URL */
	url: string;
	/** #EXT-X-BYTERANGE。1 つのファイルを複数セグメントで共有する場合に付く */
	byteRange?: HlsByteRange;
	/** AES-128 の復号材料。無ければ平文 */
	decryption?: SegmentDecryption;
};

/**
 * 出力するコンテナ。
 *
 * TS セグメントは単純連結で `.ts`。fMP4 は初期化セグメントを先頭に置いて
 * 連結すると `.mp4` として再生できる。**拡張子は出力の中身に合わせる。**
 */
export type HlsContainer = 'ts' | 'mp4';

/** 計画の全体。offscreen が受け取って取得と結合に使う。 */
type HlsDownloadPlan = {
	/** 取得する順に並んだ単位。fMP4 の初期化セグメントは先頭 */
	segments: PlannedSegment[];
	/** 秒。進捗の表示や推定に使う */
	totalDuration: number;
	container: HlsContainer;
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

/** Media Playlist から保存計画を組み立てる。 */
export function planHlsDownload(
	playlist: ParsedMediaPlaylist,
	options: PlanOptions = {},
): Result<HlsDownloadPlan, HlsDownloadRejection> {
	if (playlist.encryption.method === 'drm') return err({ reason: DRM });
	if (playlist.isLive) return err({ reason: LIVE });
	if (playlist.segments.length === 0) return err({ reason: NO_SEGMENTS });
	if (playlist.segments.length > MAX_SEGMENTS) return err({ reason: TOO_MANY_SEGMENTS });

	const segments: PlannedSegment[] = [];

	// **初期化セグメントは先頭に置く。** fMP4 は moov を含むこの 1 本が無いと
	// 再生できず、順序が入れ替わってもいけない
	if (playlist.initSegment !== undefined) {
		const planned = planSegment(
			playlist.initSegment.uri,
			playlist.initSegment.byteRange,
			playlist.initSegment.key,
			// 初期化セグメントはシーケンス番号を持たない。IV 省略時は
			// 先頭セグメントと同じ番号を使う（RFC 8216 5.2）
			playlist.mediaSequence,
			options,
		);
		if (!planned.ok) return planned;
		segments.push(planned.value);
	}

	for (const segment of playlist.segments) {
		const planned = planSegment(
			segment.uri,
			segment.byteRange,
			segment.key,
			segment.sequenceNumber,
			options,
		);
		if (!planned.ok) return planned;
		segments.push(planned.value);
	}

	return ok({
		segments,
		totalDuration: playlist.totalDuration,
		// #EXT-X-MAP があれば fMP4。初期化セグメントと結合して mp4 になる
		container: playlist.initSegment === undefined ? 'ts' : 'mp4',
	});
}

function planSegment(
	url: string,
	byteRange: HlsByteRange | undefined,
	key: HlsSegmentKey | undefined,
	sequenceNumber: number,
	options: PlanOptions,
): Result<PlannedSegment, HlsDownloadRejection> {
	// **セグメントの宛先をここで確かめる。** マニフェストの行が絶対 URI なら
	// 基準 URL を上書きするため、`file:` やイントラネットのアドレスを
	// 書き込める。Cookie 付きで取りに行く以上、素通しにはできない
	if (!isAllowedTarget(url, options)) return err({ reason: UNSAFE_SEGMENT });

	if (key === undefined) {
		return ok({ url, ...(byteRange && { byteRange }) });
	}

	// 鍵はあるのに復号材料が揃わない。平文として扱うと暗号文をそのまま保存する
	const decryption = resolveSegmentDecryption(key, sequenceNumber);
	if (decryption === undefined) return err({ reason: NO_KEY });

	// 鍵の取得先もマニフェスト由来。セグメントと同じ物差しを当てる
	if (!isAllowedTarget(decryption.keyUrl, options)) return err({ reason: UNSAFE_KEY });

	return ok({ url, ...(byteRange && { byteRange }), decryption });
}

function isAllowedTarget(url: string, options: PlanOptions): boolean {
	if (!isHttpUrl(url)) return false;

	// 公開ページから LAN やループバックを叩かせない。検出元自体が
	// プライベートなら（自宅のメディアサーバー等）そのまま許す
	return options.allowPrivateHosts === true || !isPrivateHostUrl(url);
}
