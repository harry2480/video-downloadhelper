import type { DetectedMedia, DownloadRequest, DownloadTask, MediaElementCandidate } from './types';
import { isHttpUrl } from './utils';

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
export type PopupToBackground =
	| { kind: 'rescan' }
	| { kind: 'start-download'; request: DownloadRequest }
	| { kind: 'cancel-download'; taskId: string }
	| { kind: 'retry-download'; taskId: string };

/**
 * Background から Popup への通知。
 *
 * Popup は状態を所有しない。これを購読して描画するだけにする。
 */
export type BackgroundToPopup =
	| {
			kind: 'media-list';
			media: DetectedMedia[];
			/** ブロックリスト対象サイトのため機能を無効化しているか */
			blocked: boolean;
	  }
	| {
			kind: 'download-updated';
			/** 当該タブのダウンロードタスク全件。差分ではなく毎回すべて送る */
			tasks: DownloadTask[];
	  };

/**
 * Background から Offscreen Document への指示。
 *
 * セグメント取得と Blob 生成は Offscreen でしか行えない（要件定義 2.6）。
 */
export type BackgroundToOffscreen =
	| {
			kind: 'assemble-hls';
			taskId: string;
			/** Media Playlist の絶対 URL */
			playlistUrl: string;
			/** 合計サイズの上限（バイト） */
			maxBytes: number;
			/**
			 * プライベートネットワーク宛のセグメントを許すか。
			 * 検出元のメディア URL 自体がプライベートな場合にのみ真になる
			 */
			allowPrivateHosts: boolean;
	  }
	| { kind: 'cancel-assembly'; taskId: string }
	| { kind: 'release-object-url'; objectUrl: string };

/** Offscreen Document から Background への通知。 */
export type OffscreenToBackground =
	| {
			kind: 'assembly-progress';
			taskId: string;
			/** 取得済みのセグメント数 */
			completed: number;
			/** セグメントの総数 */
			total: number;
			bytes: number;
	  }
	| {
			kind: 'assembly-done';
			taskId: string;
			objectUrl: string;
			bytes: number;
			/** 出来上がったファイルのコンテナ。保存名の拡張子を合わせるために使う */
			container: 'ts' | 'mp4';
	  }
	/** 理由はユーザーへ出せる文言にしてから送る */
	| { kind: 'assembly-failed'; taskId: string; reason: string };

/** Popup が Background へ張る Port の名前。 */
export const POPUP_PORT_NAME = 'popup';

/** 1 メッセージで受け付ける有効な候補数の上限。異常なページからの大量送信を防ぐ。 */
const MAX_CANDIDATES = 50;
/** 検証のために走査する要素数の上限。巨大な配列を渡された場合の負荷を抑える。 */
const MAX_SCANNED_CANDIDATES = 500;
const MAX_URL_LENGTH = 4_096;
/** ID 類の長さ上限。dedupeKey を含む mediaId は URL 相当の長さになる。 */
const MAX_ID_LENGTH = 4_096;
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

function parseId(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	if (value.length === 0 || value.length > MAX_ID_LENGTH) return undefined;
	return value;
}

/**
 * Popup から届いたメッセージを検証する。
 *
 * Port の送信元は接続時に検証済みだが、形の検証はここで行う。
 * 受け取り側で `kind` だけを見て中身を信じると、将来メッセージが増えたときに
 * 未定義の値がそのまま処理へ流れる。
 */
export function parsePopupMessage(raw: unknown): PopupToBackground | undefined {
	if (!isRecord(raw)) return undefined;

	if (raw.kind === 'rescan') return { kind: 'rescan' };

	if (raw.kind === 'start-download') {
		if (!isRecord(raw.request)) return undefined;

		const mediaId = parseId(raw.request.mediaId);
		if (mediaId === undefined) return undefined;

		const variantId = parseId(raw.request.variantId);
		const audioVariantId = parseId(raw.request.audioVariantId);

		return {
			kind: 'start-download',
			request: {
				mediaId,
				...(variantId !== undefined && { variantId }),
				...(audioVariantId !== undefined && { audioVariantId }),
			},
		};
	}

	if (raw.kind === 'cancel-download' || raw.kind === 'retry-download') {
		const taskId = parseId(raw.taskId);
		if (taskId === undefined) return undefined;
		return { kind: raw.kind, taskId };
	}

	return undefined;
}

function parseCount(value: unknown): number | undefined {
	if (typeof value !== 'number') return undefined;
	if (!Number.isFinite(value) || value < 0) return undefined;
	return value;
}

/**
 * Offscreen Document から届いたメッセージを検証する。
 *
 * 送信元は Background 側で検証済みだが、形が合わない値をそのまま
 * タスクの状態へ反映しない。進捗やサイズは表示と判定に使う。
 */
export function parseOffscreenMessage(raw: unknown): OffscreenToBackground | undefined {
	if (!isRecord(raw)) return undefined;

	const taskId = parseId(raw.taskId);
	if (taskId === undefined) return undefined;

	if (raw.kind === 'assembly-progress') {
		const completed = parseCount(raw.completed);
		const total = parseCount(raw.total);
		const bytes = parseCount(raw.bytes);
		if (completed === undefined || total === undefined || bytes === undefined) return undefined;

		return { kind: 'assembly-progress', taskId, completed, total, bytes };
	}

	if (raw.kind === 'assembly-done') {
		const objectUrl = parseId(raw.objectUrl);
		const bytes = parseCount(raw.bytes);
		if (objectUrl === undefined || bytes === undefined) return undefined;

		// 組み立て結果は必ずオブジェクト URL。そのまま chrome.downloads へ渡すため、
		// 信頼境界で形を確かめておく
		if (!objectUrl.startsWith('blob:')) return undefined;

		// 拡張子の決定に使う。知らない値を通すと保存名が壊れる
		if (raw.container !== 'ts' && raw.container !== 'mp4') return undefined;

		return { kind: 'assembly-done', taskId, objectUrl, bytes, container: raw.container };
	}

	if (raw.kind === 'assembly-failed') {
		const reason = parseId(raw.reason);
		if (reason === undefined) return undefined;

		return { kind: 'assembly-failed', taskId, reason };
	}

	return undefined;
}

/** Background から届いた指示を検証する（Offscreen 側の受け口）。 */
export function parseAssemblyCommand(raw: unknown): BackgroundToOffscreen | undefined {
	if (!isRecord(raw)) return undefined;

	if (raw.kind === 'assemble-hls') {
		const taskId = parseId(raw.taskId);
		const playlistUrl = parseId(raw.playlistUrl);
		const maxBytes = parseCount(raw.maxBytes);
		if (taskId === undefined || playlistUrl === undefined || maxBytes === undefined) {
			return undefined;
		}
		if (!isHttpUrl(playlistUrl)) return undefined;

		return {
			kind: 'assemble-hls',
			taskId,
			playlistUrl,
			maxBytes,
			allowPrivateHosts: raw.allowPrivateHosts === true,
		};
	}

	if (raw.kind === 'cancel-assembly') {
		const taskId = parseId(raw.taskId);
		return taskId === undefined ? undefined : { kind: 'cancel-assembly', taskId };
	}

	if (raw.kind === 'release-object-url') {
		const objectUrl = parseId(raw.objectUrl);
		return objectUrl === undefined ? undefined : { kind: 'release-object-url', objectUrl };
	}

	return undefined;
}
