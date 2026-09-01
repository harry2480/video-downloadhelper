import { findSeparateAudio } from '../media/dash/analysis';
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
const NO_AUDIO_MATCH = '対応する音声が見つかりませんでした';
const NO_MATCH = '選択した画質が見つかりませんでした（選び直してください）';
const NO_SEGMENTS = 'セグメントが見つかりませんでした';
const UNSAFE_SEGMENT = '取得できない URL のセグメントが含まれています';
const TOO_MANY_SEGMENTS = 'セグメントが多すぎます';

/** HLS と揃える。1 回の保存操作でいくらでもリクエストを出させない。 */
const MAX_SEGMENTS = 20_000;

type DashDownloadPlan = {
	/** 取得する順に並んだ単位。初期化セグメントは先頭 */
	segments: PlannedSegment[];
	/**
	 * 音声が別立ての場合の、音声側の並び。
	 *
	 * **これがあるなら結合（Mux）が要る。** 映像だけを保存すると
	 * 「音の出ない動画」が黙って出来上がる。
	 */
	audioSegments?: PlannedSegment[];
	/** 秒。進捗の表示や推定に使う */
	totalDuration: number;
	container: MediaContainer;
};

type DashDownloadRejection = { reason: string };

type PlanOptions = {
	/**
	 * 1 本のファイルで全体を成す構成に許すバイト数。
	 *
	 * SegmentBase の DASH はセグメントに分かれていない。セグメント 1 本ぶんの
	 * 上限（64MB）では必ず足りず、大きな動画が必ず失敗する。
	 */
	singleSegmentMaxBytes?: number;

	/**
	 * 保存する Representation の `id`。
	 *
	 * **位置でも URL でもなく、配信側が付けた識別子で選ぶ。** 位置は再解析で
	 * 変わり、URL は署名付きなら取得のたびに変わる。`Representation@id` は
	 * Period 内で一意と定められている（ISO/IEC 23009-1 5.3.5.2）。
	 */
	representationId?: string;

	/**
	 * プライベートネットワーク宛のセグメントを許すか。
	 *
	 * 検出元のメディア URL 自体がプライベートな場合にのみ真にする。
	 */
	allowPrivateHosts?: boolean;

	/**
	 * 映像と音声を結合できるか。
	 *
	 * 結合できない環境では、分かれている時点で保存できない。
	 * 「音の出ない動画」を黙って作らないため、理由を出して弾く。
	 */
	canMux?: boolean;
};

/** MPD から保存計画を組み立てる。 */
export function planDashDownload(
	mpd: ParsedMpd,
	options: PlanOptions = {},
): Result<DashDownloadPlan, DashDownloadRejection> {
	if (mpd.drmReason !== undefined) return err({ reason: DRM });
	if (mpd.isLive) return err({ reason: LIVE });

	const video = mpd.adaptationSets.find((set) => set.contentType === 'video');
	const audioSet = findSeparateAudio(mpd);
	// 映像が無ければ音声そのものを保存する。結合は要らない
	const separateAudio = video !== undefined ? audioSet : undefined;

	// **結合できないなら、分かれている時点で保存できない。** 映像だけを
	// 保存すると「音の出ない動画」が黙って出来上がる
	if (separateAudio !== undefined && options.canMux !== true) {
		return err({ reason: SEPARATE_AUDIO });
	}

	const primary = video ?? audioSet;
	if (primary === undefined) return err({ reason: NO_SEGMENTS });

	const candidates = primary.representations;
	let selected: DashRepresentation | undefined;

	if (options.representationId === undefined) {
		selected = candidates[0];
	} else {
		// **一意に決まらなければ選ばない。** id が重複している（仕様違反の）
		// MPD で先頭へ落とすと、意図しない画質で保存してしまう
		const matched = candidates.filter(
			(representation) => representation.id === options.representationId,
		);
		selected = matched.length === 1 ? matched[0] : undefined;
	}

	// 指定はあったが見つからない。既定へ落とすと意図しない画質で保存する
	if (selected === undefined) return err({ reason: NO_MATCH });
	if (selected.segments.length === 0) return err({ reason: NO_SEGMENTS });

	// 初期化セグメントは先頭に置く。moov を含むこの 1 本が無いと再生できない
	const planned = toPlannedSegments(selected);

	if (planned.length > MAX_SEGMENTS) return err({ reason: TOO_MANY_SEGMENTS });

	// **セグメントの宛先をここで確かめる。** MPD の中身はページ側が決められ、
	// 相対 URL の解決結果に file: やイントラネットのアドレスが現れうる
	if (!planned.every((segment) => isAllowedTarget(segment.url, options))) {
		return err({ reason: UNSAFE_SEGMENT });
	}

	applySingleSegmentLimit(planned, options.singleSegmentMaxBytes);

	if (separateAudio === undefined) {
		return ok({
			segments: planned,
			totalDuration: mpd.duration ?? 0,
			// DASH のセグメントは fMP4。初期化セグメントと結合して mp4 になる
			container: 'mp4',
		});
	}

	// **音声は帯域が最も大きいものを採る。** 音声の品質はユーザーに
	// 選ばせていないため、映像に見合うものを既定で選ぶ
	const audio = [...separateAudio.representations].sort(
		(a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
	)[0];

	if (audio === undefined || audio.segments.length === 0) return err({ reason: NO_AUDIO_MATCH });

	const audioPlanned = toPlannedSegments(audio);
	if (audioPlanned.length > MAX_SEGMENTS) return err({ reason: TOO_MANY_SEGMENTS });
	if (!audioPlanned.every((segment) => isAllowedTarget(segment.url, options))) {
		return err({ reason: UNSAFE_SEGMENT });
	}

	applySingleSegmentLimit(audioPlanned, options.singleSegmentMaxBytes);

	return ok({
		segments: planned,
		audioSegments: audioPlanned,
		totalDuration: mpd.duration ?? 0,
		container: 'mp4',
	});
}

/** 初期化セグメントを先頭に置いた取得単位の並び。 */
function toPlannedSegments(representation: DashRepresentation): PlannedSegment[] {
	const planned: PlannedSegment[] = [];

	if (representation.initSegment !== undefined) {
		planned.push({
			url: representation.initSegment.uri,
			...(representation.initSegment.byteRange && {
				byteRange: representation.initSegment.byteRange,
			}),
		});
	}

	for (const segment of representation.segments) {
		planned.push({ url: segment.uri, ...(segment.byteRange && { byteRange: segment.byteRange }) });
	}

	return planned;
}

/** 1 本で全体を成すなら、セグメント 1 本ぶんの上限では足りない。 */
function applySingleSegmentLimit(segments: PlannedSegment[], maxBytes: number | undefined): void {
	const single = segments.length === 1 ? segments[0] : undefined;
	if (single !== undefined && maxBytes !== undefined) single.maxBytes = maxBytes;
}

function isAllowedTarget(url: string, options: PlanOptions): boolean {
	if (!isHttpUrl(url)) return false;

	// 公開ページから LAN やループバックを叩かせない。検出元自体が
	// プライベートなら（自宅のメディアサーバー等）そのまま許す
	return options.allowPrivateHosts === true || !isPrivateHostUrl(url);
}
