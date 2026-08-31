import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { MuxerPort } from '../shared/ports/muxer.port';
import { err, ok } from '../shared/utils';

/**
 * ffmpeg.wasm の実行（要件定義 2.3 の映像・音声結合）。
 *
 * **リモートコードを実行しない**（要件定義 12 章 / Chrome Web Store ポリシー）。
 * ffmpeg.wasm の既定は CDN から core を取りに行くため、依存関係に固定した
 * ファイルを同梱し、拡張機能内の URL から読み込む
 * （`scripts/copy-ffmpeg.mjs` が `public/ffmpeg/` へ配置する）。
 *
 * **Offscreen Document でしか動かない。** WebAssembly のコンパイルには
 * `wasm-unsafe-eval`（manifest の `content_security_policy`）が要り、
 * Service Worker では長時間の処理が停止で中断される。
 */

/** 同梱したコアの位置。拡張機能内の絶対 URL にする。 */
const CORE_URL = 'ffmpeg/ffmpeg-core.js';
const WASM_URL = 'ffmpeg/ffmpeg-core.wasm';

/**
 * 32MB の wasm を読み込んでコンパイルする時間。
 *
 * 冷えた状態では数秒かかる。短すぎると、動く構成でも失敗として扱ってしまう。
 */
const LOAD_TIMEOUT_MS = 60_000;

/** 1 回の実行の上限。壊れた入力で ffmpeg が終わらないことがある。 */
const EXEC_TIMEOUT_MS = 10 * 60_000;

/** 作業ディレクトリ上のファイル名。実際のファイル名とは無関係でよい。 */
const VIDEO_INPUT = 'video-input';
const AUDIO_INPUT = 'audio-input';
const OUTPUT = 'output.mp4';

export function createFfmpegRunner(): MuxerPort {
	/**
	 * 読み込み済みのインスタンス。
	 *
	 * **使い回す。** 32MB の wasm を保存のたびにコンパイルし直すと、
	 * 待ち時間の大半がそこになる。Offscreen Document は閉じないため、
	 * 一度読み込めば以降の保存でそのまま使える。
	 */
	let loading: Promise<FFmpeg> | undefined;

	async function instance(): Promise<FFmpeg> {
		loading ??= (async () => {
			const ffmpeg = new FFmpeg();

			const loaded = await Promise.race([
				ffmpeg
					.load({
						coreURL: chrome.runtime.getURL(CORE_URL),
						wasmURL: chrome.runtime.getURL(WASM_URL),
					})
					.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), LOAD_TIMEOUT_MS)),
			]);

			if (!loaded) throw new Error('ffmpeg の読み込みがタイムアウトしました');
			return ffmpeg;
		})().catch((error: unknown) => {
			// 失敗したら次の保存で読み込み直せるようにする
			loading = undefined;
			throw error;
		});

		return loading;
	}

	/** 作業ディレクトリを空にする。前回の入出力を残さない。 */
	async function cleanup(ffmpeg: FFmpeg, names: readonly string[]): Promise<void> {
		for (const name of names) {
			// 存在しないファイルの削除は失敗する。片付けの失敗で結果を塗り替えない
			await ffmpeg.deleteFile(name).catch(() => undefined);
		}
	}

	return {
		async mux(video, audio) {
			try {
				const ffmpeg = await instance();

				await ffmpeg.writeFile(VIDEO_INPUT, video);
				await ffmpeg.writeFile(AUDIO_INPUT, audio);

				// **再エンコードしない（`-c copy`）。** 中身はそのままに
				// 容器だけを 1 つにまとめる。時間もかからず品質も落ちない
				const code = await ffmpeg.exec(
					['-i', VIDEO_INPUT, '-i', AUDIO_INPUT, '-c', 'copy', '-movflags', 'faststart', OUTPUT],
					EXEC_TIMEOUT_MS,
				);

				if (code !== 0) {
					await cleanup(ffmpeg, [VIDEO_INPUT, AUDIO_INPUT, OUTPUT]);
					return err({ reason: 'mux-failed' });
				}

				const output = await ffmpeg.readFile(OUTPUT);
				await cleanup(ffmpeg, [VIDEO_INPUT, AUDIO_INPUT, OUTPUT]);

				// readFile は文字列も返しうる（encoding 指定時）。ここでは常にバイト列
				if (typeof output === 'string') return err({ reason: 'mux-failed' });

				return ok(new Uint8Array(output.slice().buffer));
			} catch {
				// 読み込み失敗・メモリ不足・タイムアウト。呼び出し側は
				// 取得済みのデータを片付ける必要があるため、例外にしない
				return err({ reason: 'mux-failed' });
			}
		},
	};
}
