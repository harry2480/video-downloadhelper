/**
 * 保存計画の共通の形。
 *
 * HLS も DASH も、最終的には「取得する順に並んだ単位の列」へ落ちる。
 * 取得制御（`segment-download.ts`）はこの形だけを知る。
 */

/** バイトレンジ（両端を含む範囲を offset/length で表す）。 */
export type PlannedByteRange = {
	offset: number;
	length: number;
};

/** 取得する 1 単位。初期化セグメントも同じ形で扱う。 */
export type PlannedSegment = {
	/** 解決済みの絶対 URL */
	url: string;
	/** 1 つのファイルを複数セグメントで共有する場合に付く */
	byteRange?: PlannedByteRange;
	/** AES-128 の復号材料。無ければ平文（HLS のみ） */
	decryption?: {
		keyUrl: string;
		iv: Uint8Array<ArrayBuffer>;
	};

	/**
	 * この 1 本に許すバイト数の上限。
	 *
	 * 既定はセグメント 1 本ぶんの上限。DASH の SegmentBase のように
	 * **1 ファイルで全体を成す**構成では、その上限では必ず足りない。
	 */
	maxBytes?: number;
};

/**
 * 出力するコンテナ。
 *
 * TS セグメントは単純連結で `.ts`。fMP4（HLS の #EXT-X-MAP、DASH）は
 * 初期化セグメントを先頭に置いて連結すると `.mp4` として再生できる。
 * **拡張子は出力の中身に合わせる。**
 */
export type MediaContainer = 'ts' | 'mp4';
