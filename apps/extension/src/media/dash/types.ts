/** MPD の解析結果の型（ISO/IEC 23009-1）。 */

/** 取得する 1 セグメント。 */
export type DashSegment = {
	/** 解決済みの絶対 URL */
	uri: string;
	/** バイトレンジ（SegmentBase / SegmentList の範囲指定） */
	byteRange?: { offset: number; length: number };
};

/**
 * 1 つの Representation（＝ある品質のストリーム）。
 *
 * DASH は映像と音声を別の Representation へ分けられる。分かれている場合、
 * 1 本のファイルにするには結合（Mux）が要る。
 */
export type DashRepresentation = {
	id: string;
	/** bit/s */
	bandwidth?: number;
	width?: number;
	height?: number;
	frameRate?: number;
	/** `video/mp4` 等 */
	mimeType?: string;
	/** `avc1.640028,mp4a.40.2` をカンマで分割したもの */
	codecs?: string[];
	/** 音声チャンネル数 */
	audioChannels?: number;
	/** 初期化セグメント。fMP4 では必須 */
	initSegment?: DashSegment;
	/** 取得する順に並んだメディアセグメント */
	segments: DashSegment[];
};

/** Video / Audio / Text のいずれか。 */
export type DashContentType = 'video' | 'audio' | 'text' | 'unknown';

export type DashAdaptationSet = {
	contentType: DashContentType;
	lang?: string;
	representations: DashRepresentation[];
};

export type ParsedMpd = {
	/** `dynamic` はライブ配信 */
	isLive: boolean;
	/** 秒。mediaPresentationDuration から得られる */
	duration?: number;
	adaptationSets: DashAdaptationSet[];
	/** ContentProtection から DRM を検出した場合の理由 */
	drmReason?: string;
};

export type MpdParseError =
	| { type: 'not-an-mpd' }
	/** XML として読めない */
	| { type: 'unparsable' }
	| { type: 'no-representations' }
	| { type: 'invalid-uri'; input: string }
	/** セグメント数が多すぎる。ページ由来の入力に対する保険 */
	| { type: 'too-many-segments' };
