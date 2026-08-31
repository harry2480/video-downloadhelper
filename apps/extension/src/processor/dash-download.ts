import type { DashRepresentation, ParsedMpd } from '../media/dash/types';
import { type Result, err, isHttpUrl, isPrivateHostUrl, ok } from '../shared/utils';
import type { MediaContainer, PlannedSegment } from './download-plan';

/**
 * DASH の保存計画。
 *
 * HLS と同じく、**未対応の条件をここで出し切る。** 取得を始めてから
 * 気づくと、通信を無駄にしたうえでユーザーを待たせることになる。
 */

/** 保存できない理由。そのままユーザーへ出せる文言にする。 */
const DRM = 'この動画は DRM で保護されているため対応していません';
const LIVE = 'ライブ配信の保存には未対応です';
const SEPARATE_AUDIO = '映像と音声が分かれているため、結合に対応するまで保存できません';
const NO_MATCH = '選択した画質が見つかりませんでした（選び直してください）';
const NO_SEGMENTS = 'セグメントが見つかりませんでした';
const UNSAFE_SEGMENT = '取得できない URL のセグメントが含まれています';
const TOO_MANY_SEGMENTS = 'セグメントが多すぎます';

/** HLS と揃える。1 回の保存操作でいくらでもリクエストを出させない。 */
const MAX_SEGMENTS = 20_000;

type DashDownloadPlan = {
	/** 取得する順に並んだ単位。初期化セグメントは先頭 */
	segments: PlannedSegment[];
	/** 秒。進捗の表示や推定に使う */
	totalDuration: number;
	container: MediaContainer;
};

type DashDownloadRejection = { reason: string };

type PlanOptions = {
	/**
	 * 保存する Representation を指す URL。
	 *
	 * 初期化セグメント（無ければ先頭セグメント）の URL。
	 * `media/dash/analysis.ts` が variant の `url` に載せたものと同じ値で、
	 * **位置ではなく実体で選ぶ**ため、再解析で並びが変わっても取り違えない。
	 */
	representationUrl?: string;

	/**
	 * プライベートネットワーク宛のセグメントを許すか。
	 *
	 * 検出元のメディア URL 自体がプライベートな場合にのみ真にする。
	 */
	allowPrivateHosts?: boolean;
};

/** Representation を代表する URL。variant の `url` と同じ規則で決める。 */
function representationUrlOf(representation: DashRepresentation): string | undefined {
	return representation.initSegment?.uri ?? representation.segments[0]?.uri;
}

/** MPD から保存計画を組み立てる。 */
export function planDashDownload(
	mpd: ParsedMpd,
	options: PlanOptions = {},
): Result<DashDownloadPlan, DashDownloadRejection> {
	if (mpd.drmReason !== undefined) return err({ reason: DRM });
	if (mpd.isLive) return err({ reason: LIVE });

	const video = mpd.adaptationSets.find((set) => set.contentType === 'video');
	const audio = mpd.adaptationSets.find((set) => set.contentType === 'audio');

	// **映像と音声が分かれていれば結合が要る。** 映像だけを保存すると
	// 「音の出ない動画」が黙って出来上がる
	if (video !== undefined && audio !== undefined) return err({ reason: SEPARATE_AUDIO });

	const primary = video ?? audio;
	if (primary === undefined) return err({ reason: NO_SEGMENTS });

	const candidates = primary.representations;
	const selected =
		options.representationUrl === undefined
			? candidates[0]
			: candidates.find(
					(representation) => representationUrlOf(representation) === options.representationUrl,
				);

	// 指定はあったが見つからない。既定へ落とすと意図しない画質で保存する
	if (selected === undefined) return err({ reason: NO_MATCH });
	if (selected.segments.length === 0) return err({ reason: NO_SEGMENTS });

	const planned: PlannedSegment[] = [];

	// 初期化セグメントは先頭に置く。moov を含むこの 1 本が無いと再生できない
	if (selected.initSegment !== undefined) {
		planned.push({
			url: selected.initSegment.uri,
			...(selected.initSegment.byteRange && { byteRange: selected.initSegment.byteRange }),
		});
	}

	for (const segment of selected.segments) {
		planned.push({ url: segment.uri, ...(segment.byteRange && { byteRange: segment.byteRange }) });
	}

	if (planned.length > MAX_SEGMENTS) return err({ reason: TOO_MANY_SEGMENTS });

	// **セグメントの宛先をここで確かめる。** MPD の中身はページ側が決められ、
	// 相対 URL の解決結果に file: やイントラネットのアドレスが現れうる
	if (!planned.every((segment) => isAllowedTarget(segment.url, options))) {
		return err({ reason: UNSAFE_SEGMENT });
	}

	return ok({
		segments: planned,
		totalDuration: mpd.duration ?? 0,
		// DASH のセグメントは fMP4。初期化セグメントと結合して mp4 になる
		container: 'mp4',
	});
}

function isAllowedTarget(url: string, options: PlanOptions): boolean {
	if (!isHttpUrl(url)) return false;

	// 公開ページから LAN やループバックを叩かせない。検出元自体が
	// プライベートなら（自宅のメディアサーバー等）そのまま許す
	return options.allowPrivateHosts === true || !isPrivateHostUrl(url);
}
