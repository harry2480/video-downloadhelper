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
 * ts は単純連結で .ts として出力する。fmp4 は #EXT-X-MAP の初期化
 * セグメントを先頭に置いて連結し、.mp4 として出力する。
 */
export type HlsSegmentFormat = 'ts' | 'fmp4' | 'unknown';

/** #EXT-X-BYTERANGE で指定されるバイト範囲。 */
export type HlsByteRange = {
	length: number;
	offset: number;
};

/**
 * #EXT-X-KEY:METHOD=AES-128 の適用情報。
 *
 * **セグメントごとに持つ。** #EXT-X-KEY はプレイリストの途中で何度でも
 * 現れ、以降のセグメントに適用される。プレイリスト単位で 1 つだけ覚えると、
 * 鍵が切り替わるストリームで一部が復号できないまま保存される。
 */
export type HlsSegmentKey = {
	/** 解決済みのキー URL。URI が欠けていれば undefined（復号できない） */
	keyUri?: string;
	/** IV の 16 進表記（`0x` を除いた 32 桁）。省略時は連番から導出する */
	iv?: string;
};

/**
 * #EXT-X-MAP の初期化セグメント（fMP4）。
 *
 * RFC 8216 は初期化セグメントにも直前の #EXT-X-KEY を適用すると定めている。
 * 平文として扱うと、結合したファイルの先頭だけが壊れる。
 */
export type HlsInitSegment = {
	uri: string;
	byteRange?: HlsByteRange;
	key?: HlsSegmentKey;
};

export type HlsSegment = {
	/** 解決済みの絶対 URL */
	uri: string;
	/** 秒 */
	duration: number;
	byteRange?: HlsByteRange;
	/** メディアシーケンス番号。IV 省略時の導出に使う（RFC 8216 5.2） */
	sequenceNumber: number;
	/** 暗号化されている場合の鍵。無ければ平文 */
	key?: HlsSegmentKey;
	/**
	 * このセグメントに適用される初期化セグメント。
	 *
	 * **セグメントごとに持つ。** #EXT-X-MAP は不連続点をまたいで
	 * 切り替わりうる。1 つだけ覚えると、前半のセグメントが誤った
	 * 初期化データと組み合わされ、壊れた mp4 になる。
	 * 切り替わらない限り同一のオブジェクトを共有する。
	 */
	initSegment?: HlsInitSegment;
};

/**
 * プレイリスト全体の暗号化の要約。
 *
 * 個々の鍵はセグメントが持つ。ここは「保存できるか」の判定に使う概況で、
 * **1 つでも該当すればその方式として扱う**（一部だけ暗号化されている
 * プレイリストを平文扱いすると、暗号文をそのまま保存してしまう）。
 */
export type HlsEncryption =
	| { method: 'none' }
	| { method: 'aes-128' }
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
	/** #EXT-X-MEDIA-SEQUENCE。省略時は 0（RFC 8216 4.3.3.2） */
	mediaSequence: number;
	encryption: HlsEncryption;
};

export type HlsParseError =
	| { type: 'not-a-playlist' }
	| { type: 'empty-playlist' }
	| { type: 'no-variants' }
	| { type: 'no-segments' }
	| { type: 'invalid-uri'; input: string }
	/** #EXT-X-BYTERANGE の値を解決できない。範囲なしとして扱うと全体を取得してしまう */
	| { type: 'invalid-byterange'; input: string };
