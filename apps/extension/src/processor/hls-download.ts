import { type SegmentDecryption, resolveSegmentDecryption } from '../media/hls/decryption';
import type {
	HlsByteRange,
	HlsInitSegment,
	HlsSegmentKey,
	ParsedMediaPlaylist,
} from '../media/hls/types';
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
const NO_INIT_IV = '初期化セグメントの IV が指定されていないため復号できません';
const NO_SEGMENTS = 'セグメントが見つかりませんでした';
const UNSAFE_SEGMENT = '取得できない URL のセグメントが含まれています';
const UNSAFE_KEY = '取得できない URL の鍵が指定されています';
const TOO_MANY_SEGMENTS = 'セグメントが多すぎます';
const TOO_MANY_KEYS = '鍵の種類が多すぎます';
const NO_INIT_SEGMENT = '初期化セグメントが見つからないため保存できません';

/**
 * 扱うセグメント数の上限。
 *
 * プレイリストの中身はページ側が決められる。上限がないと、1 回の保存操作で
 * いくらでもリクエストを出させられる（要件定義 12 章）。
 * 10 秒セグメントなら 20,000 本で 55 時間ぶん。VOD の実用範囲を十分に超える。
 */
const MAX_SEGMENTS = 20_000;

/**
 * 取得する鍵の種類の上限。
 *
 * #EXT-X-KEY はセグメントごとに URI を変えられる。鍵は URL ごとに 1 回しか
 * 取らないが、全部違えば重複排除が効かず、セグメント数と同じだけ
 * リクエストが出る。正常なローテーションでも数十に収まる。
 */
const MAX_KEY_URLS = 256;

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
	let emittedInit: HlsInitSegment | undefined;
	let sawInit = false;

	for (const segment of playlist.segments) {
		// **初期化セグメントは、切り替わるたびに直前へ挟む。**
		// #EXT-X-MAP は不連続点をまたいで変わりうる。1 本目だけを
		// 先頭に置くと、後半のセグメントが誤った初期化データと組み合わされる
		if (segment.initSegment !== undefined && !isSameInitSegment(segment.initSegment, emittedInit)) {
			// **暗号化された #EXT-X-MAP に IV は必須**（RFC 8216 4.3.2.5）。
			// 番号からの導出は規定されておらず、実際の IV と違えば AES-CBC の
			// 先頭ブロックだけが壊れる。ftyp を含む先頭が壊れた mp4 は
			// 再生できないのに、保存は成功したように見える
			if (segment.initSegment.key !== undefined && segment.initSegment.key.iv === undefined) {
				return err({ reason: NO_INIT_IV });
			}

			const planned = planSegment(
				segment.initSegment.uri,
				segment.initSegment.byteRange,
				segment.initSegment.key,
				// IV は上で必須にしてあるため、この番号は使われない
				segment.sequenceNumber,
				options,
			);
			if (!planned.ok) return planned;

			segments.push(planned.value);
			emittedInit = segment.initSegment;
			sawInit = true;
		}

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

	// **初期化セグメントの無い fMP4 は保存できない。** moov を含む 1 本が
	// 無いまま連結しても再生できないファイルにしかならない。
	// 従来は解析の時点で fMP4 を一律で弾いていたため表面化しなかった
	if (playlist.segmentFormat === 'fmp4' && !sawInit) return err({ reason: NO_INIT_SEGMENT });

	// **上限は展開後にも掛ける。** 初期化セグメントはセグメントごとに
	// 切り替えられるため、展開前だけを見ると実際の取得回数が倍になる
	if (segments.length > MAX_SEGMENTS) return err({ reason: TOO_MANY_SEGMENTS });

	const keyUrls = new Set<string>();
	for (const planned of segments) {
		if (planned.decryption !== undefined) keyUrls.add(planned.decryption.keyUrl);
	}
	if (keyUrls.size > MAX_KEY_URLS) return err({ reason: TOO_MANY_KEYS });

	return ok({
		segments,
		totalDuration: playlist.totalDuration,
		// #EXT-X-MAP があれば fMP4。初期化セグメントと結合して mp4 になる
		container: sawInit ? 'mp4' : 'ts',
	});
}

/**
 * 同じ初期化セグメントか。
 *
 * **値で比べる。** パーサーは #EXT-X-MAP 行ごとに新しいオブジェクトを作るため、
 * 不連続点ごとに同じ URI の MAP を再宣言する構成（実在する）で、
 * 同一性の比較だと初期化セグメントが二重に出力される。
 */
function isSameInitSegment(a: HlsInitSegment, b: HlsInitSegment | undefined): boolean {
	if (b === undefined) return false;
	if (a.uri !== b.uri) return false;
	return a.byteRange?.offset === b.byteRange?.offset && a.byteRange?.length === b.byteRange?.length;
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
