import type { Result } from '../utils';

/**
 * セグメントの取得。
 *
 * HLS の保存は「マニフェストを読む → セグメントを順に取る → 連結する」
 * という流れで、取得だけが副作用を持つ。取得制御（同時接続数・中止・上限）は
 * `processor/` の純粋なロジックが担い、実際の通信はこの interface の実装が行う。
 */

export type SegmentFetchFailure =
	/** 通信に失敗した。オフライン、DNS、CORS 等 */
	| { reason: 'network' }
	/** 2xx 以外が返った */
	| { reason: 'http-error'; status: number }
	/** 1 セグメントとしては大きすぎる */
	| { reason: 'too-large' }
	/** 要求した範囲が返らなかった。#EXT-X-BYTERANGE で使う */
	| { reason: 'range-not-satisfied' };

/** 取得するバイト範囲（両端を含む）。 */
export type FetchByteRange = {
	offset: number;
	length: number;
};

export type SegmentFetchOptions = {
	/**
	 * 部分取得。指定した場合、**返るのはその範囲ちょうどでなければならない**。
	 *
	 * Range を無視して全体を返すサーバーがある。気づかずに連結すると、
	 * 同じ内容を繰り返した壊れたファイルになるため、実装側で検証する。
	 */
	range?: FetchByteRange;

	/**
	 * この取得に許すバイト数の上限。
	 *
	 * 既定の上限（セグメント 1 本ぶん）より小さいものを取るときに使う。
	 * 鍵は 16 バイトと決まっているのに、読み切ってから長さを見ると、
	 * その間だけ巨大な応答をメモリへ載せることになる。
	 */
	maxBytes?: number;
};

export type SegmentFetcherPort = {
	/**
	 * バイト列として取得する。
	 *
	 * `ArrayBuffer` を裏に持つ形に固定する。`SharedArrayBuffer` 由来のものは
	 * `Blob` へ渡せず、結合の段で詰まるため。
	 */
	fetchBytes: (
		url: string,
		options?: SegmentFetchOptions,
	) => Promise<Result<Uint8Array<ArrayBuffer>, SegmentFetchFailure>>;
};
