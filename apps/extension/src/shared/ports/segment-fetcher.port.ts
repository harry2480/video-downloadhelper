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
	| { reason: 'too-large' };

export type SegmentFetcherPort = {
	/**
	 * バイト列として取得する。
	 *
	 * `ArrayBuffer` を裏に持つ形に固定する。`SharedArrayBuffer` 由来のものは
	 * `Blob` へ渡せず、結合の段で詰まるため。
	 */
	fetchBytes: (url: string) => Promise<Result<Uint8Array<ArrayBuffer>, SegmentFetchFailure>>;
};
