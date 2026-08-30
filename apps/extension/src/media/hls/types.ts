/** HLS プレイリストの解析結果の型（RFC 8216）。 */

export type HlsPlaylistKind = 'master' | 'media';

/** Master Playlist の #EXT-X-STREAM-INF 1 件。 */
export type HlsVariantStream = {
	/** 解決済みの絶対 URL */
	uri: string;
	/** bit/s。#EXT-X-STREAM-INF の必須属性 */
	bandwidth: number;
	averageBandwidth?: number;
	width?: number;
	height?: number;
	/** CODECS 属性をカンマで分割したもの */
	codecs?: string[];
	frameRate?: number;
	/** 対応する音声グループ（#EXT-X-MEDIA の GROUP-ID） */
	audioGroupId?: string;
};

/** Master Playlist の #EXT-X-MEDIA:TYPE=AUDIO 1 件。 */
export type HlsAudioRendition = {
	groupId: string;
	name: string;
	language?: string;
	/** 解決済みの絶対 URL。多重化済みで独立した URI を持たない場合は undefined */
	uri?: string;
	isDefault: boolean;
	channels?: string;
};

export type ParsedMasterPlaylist = {
	kind: 'master';
	variants: HlsVariantStream[];
	audioRenditions: HlsAudioRendition[];
	/** #EXT-X-SESSION-KEY から DRM を検出した場合の理由 */
	drmReason?: string;
};

/**
 * セグメントの形式。
 *
 * Phase 1 では ts のみを対象とし、単純連結で .ts として出力する。
 * fmp4 は #EXT-X-MAP の初期化セグメントとの結合が必要なため Phase 2。
 */
export type HlsSegmentFormat = 'ts' | 'fmp4' | 'unknown';

/** #EXT-X-BYTERANGE で指定されるバイト範囲。 */
export type HlsByteRange = {
	length: number;
	offset: number;
};

export type HlsSegment = {
	/** 解決済みの絶対 URL */
	uri: string;
	/** 秒 */
	duration: number;
	byteRange?: HlsByteRange;
};

export type HlsEncryption =
	| { method: 'none' }
	/** キー URI が欠けている場合もある（復号できないことに変わりはない） */
	| { method: 'aes-128'; keyUri?: string; iv?: string }
	/** Widevine / FairPlay / PlayReady / SAMPLE-AES。復号・回避は実装しない */
	| { method: 'drm'; reason: string };

export type ParsedMediaPlaylist = {
	kind: 'media';
	segments: HlsSegment[];
	/** #EXT-X-TARGETDURATION（秒） */
	targetDuration?: number;
	/** 全セグメントの #EXTINF 合計（秒） */
	totalDuration: number;
	/** #EXT-X-ENDLIST がなければライブとみなす */
	isLive: boolean;
	segmentFormat: HlsSegmentFormat;
	/** #EXT-X-MAP の初期化セグメント（fMP4 のみ） */
	initSegment?: {
		uri: string;
		byteRange?: HlsByteRange;
	};
	encryption: HlsEncryption;
};

export type HlsParseError =
	| { type: 'not-a-playlist' }
	| { type: 'empty-playlist' }
	| { type: 'no-variants' }
	| { type: 'no-segments' }
	| { type: 'invalid-uri'; input: string };
