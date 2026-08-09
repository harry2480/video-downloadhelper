import type { DetectedMedia, MediaElementCandidate } from './types';

/**
 * コンテキスト間通信の単一の窓口。
 *
 * 実行コンテキストは別バンドルであり直接 import できない。
 * やり取りはすべてここで定義した判別可能ユニオンを経由する。
 *
 * **受信側は必ずパースしてから使うこと。** Content Script はページと同じ
 * プロセスで動くため、その内容を信用してはならない（要件定義 12 章）。
 */

export type ContentToBackground = {
	kind: 'media-elements-detected';
	candidates: MediaElementCandidate[];
};

/** Background から Content Script への指示。 */
export type BackgroundToContent = {
	kind: 'rescan';
};

/** Popup から Background への要求。Port 経由で送る。 */
export type PopupToBackground = { kind: 'rescan' };

/**
 * Background から Popup への通知。
 *
 * Popup は状態を所有しない。これを購読して描画するだけにする。
 */
export type BackgroundToPopup = {
	kind: 'media-list';
	media: DetectedMedia[];
	/** ブロックリスト対象サイトのため機能を無効化しているか */
	blocked: boolean;
};

/** Popup が Background へ張る Port の名前。 */
export const POPUP_PORT_NAME = 'popup';

/** 1 メッセージで受け付ける有効な候補数の上限。異常なページからの大量送信を防ぐ。 */
const MAX_CANDIDATES = 50;
/** 検証のために走査する要素数の上限。巨大な配列を渡された場合の負荷を抑える。 */
const MAX_SCANNED_CANDIDATES = 500;
const MAX_URL_LENGTH = 4_096;
const MAX_TITLE_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalPositiveNumber(value: unknown): number | undefined {
	if (typeof value !== 'number') return undefined;
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

function parseCandidate(value: unknown): MediaElementCandidate | undefined {
	if (!isRecord(value)) return undefined;

	const { sourceUrl, detectedBy, title } = value;

	if (typeof sourceUrl !== 'string') return undefined;
	if (sourceUrl.length === 0 || sourceUrl.length > MAX_URL_LENGTH) return undefined;
	if (detectedBy !== 'video-element' && detectedBy !== 'audio-element') return undefined;

	const duration = parseOptionalPositiveNumber(value.duration);
	const width = parseOptionalPositiveNumber(value.width);
	const height = parseOptionalPositiveNumber(value.height);

	return {
		sourceUrl,
		detectedBy,
		...(duration !== undefined && { duration }),
		...(width !== undefined && { width }),
		...(height !== undefined && { height }),
		...(typeof title === 'string' &&
			title.length > 0 && { title: title.slice(0, MAX_TITLE_LENGTH) }),
	};
}

/**
 * Content Script から届いたメッセージを検証する。
 *
 * 形が合わないものは `undefined` を返して破棄する。
 * 一部の候補だけが不正な場合は、その候補のみ落として残りを通す。
 */
export function parseContentMessage(raw: unknown): ContentToBackground | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw.kind !== 'media-elements-detected') return undefined;
	if (!Array.isArray(raw.candidates)) return undefined;

	// 「先頭 N 件を取ってから絞る」と、無効な候補が前に並ぶだけで有効な候補が
	// 押し出される。有効なものを N 件集めた時点で打ち切る形にする。
	// 走査自体も上限で止め、巨大な配列を渡された場合の負荷を抑える。
	const candidates: MediaElementCandidate[] = [];
	for (const entry of raw.candidates.slice(0, MAX_SCANNED_CANDIDATES)) {
		const candidate = parseCandidate(entry);
		if (!candidate) continue;
		candidates.push(candidate);
		if (candidates.length >= MAX_CANDIDATES) break;
	}

	if (candidates.length === 0) return undefined;

	return { kind: 'media-elements-detected', candidates };
}
