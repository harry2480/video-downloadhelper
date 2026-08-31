import type { Result } from '../utils';

/**
 * 映像と音声の結合（要件定義 2.3）。
 *
 * DASH は映像と音声を別の Representation へ分けられる。1 本のファイルに
 * するには容器をまとめ直す必要があり、実体は ffmpeg.wasm が担う。
 * コアロジック層はこの interface だけを知る。
 */

export type MuxFailure = { reason: 'mux-failed' };

export type MuxerPort = {
	/**
	 * 映像と音声を 1 つの mp4 にまとめる。
	 *
	 * **再エンコードしない。** 中身はそのままに容器だけを差し替える。
	 * 失敗は**例外にせず**返す（取得済みのデータを呼び出し側が片付けるため）。
	 */
	mux: (
		video: Uint8Array<ArrayBuffer>,
		audio: Uint8Array<ArrayBuffer>,
	) => Promise<Result<Uint8Array<ArrayBuffer>, MuxFailure>>;
};
