import type { SegmentFetcherPort, SegmentFetchFailure } from '../shared/ports/segment-fetcher.port';
import { err, ok, type Result } from '../shared/utils';

/**
 * セグメントの取得制御（要件定義 2.6 の並列取得制御）。
 *
 * 副作用は Port の実装が持ち、ここは「何本まで同時に取るか」「どこで諦めるか」
 * 「どの順に並べるか」だけを決める。純粋なので Node.js 上で検証できる。
 */

/**
 * 同時接続数の既定値。
 *
 * 増やすほど速いが、配信側から見ると短時間の大量アクセスになる。
 * ブラウザの同時接続数（ホストあたり 6）に合わせておく。
 */
const DEFAULT_CONCURRENCY = 6;

type SegmentDownloadError =
	/** 取得に失敗した。何本目かを添える */
	| { type: 'fetch-failed'; index: number; failure: SegmentFetchFailure }
	/** 合計が上限を超えた */
	| { type: 'too-large'; limitBytes: number }
	/** ユーザーによる中止 */
	| { type: 'cancelled' };

type SegmentDownloadOptions = {
	urls: readonly string[];
	fetcher: SegmentFetcherPort;
	/** 合計サイズの上限（バイト）。Blob 組み立て方式のための制限 */
	maxBytes: number;
	concurrency?: number;
	/** 取得済みの本数と累計バイト数。UI の進捗に使う */
	onProgress?: (completed: number, bytes: number) => void;
	/** 中止されたか。1 本ごとに確認する */
	isCancelled?: () => boolean;
};

/**
 * セグメントを取得して**元の順に**並べて返す。
 *
 * 同時接続数を絞りつつ、結果は必ず配列の添字どおりに並べる。
 * 連結してひとつの動画にするため、順序が狂うと再生できないファイルになる。
 */
export async function downloadSegments(
	options: SegmentDownloadOptions,
): Promise<Result<Uint8Array<ArrayBuffer>[], SegmentDownloadError>> {
	const { urls, fetcher, maxBytes, onProgress, isCancelled } = options;
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

	// 添字ごとに 1 回だけ書き込む。空で始めておけば、後段で穴の有無を
	// 確かめる分岐（起こり得ない）を持たずに済む
	const parts: Uint8Array<ArrayBuffer>[] = urls.map(() => new Uint8Array(new ArrayBuffer(0)));
	let completed = 0;
	let totalBytes = 0;
	let failure: SegmentDownloadError | undefined;
	let next = 0;

	async function worker(): Promise<void> {
		for (;;) {
			if (isCancelled?.() === true) {
				failure ??= { type: 'cancelled' };
				return;
			}

			const index = next++;
			const url = urls[index];
			if (url === undefined) return;

			const fetched = await fetcher.fetchBytes(url);

			// 待っている間に他のワーカーが失敗していることがある。
			// ここで降りないと、失敗が確定した後も取り続けてしまう
			if (failure !== undefined) return;

			if (!fetched.ok) {
				failure = { type: 'fetch-failed', index, failure: fetched.error };
				return;
			}

			parts[index] = fetched.value;
			completed += 1;
			totalBytes += fetched.value.byteLength;

			if (totalBytes > maxBytes) {
				failure = { type: 'too-large', limitBytes: maxBytes };
				return;
			}

			onProgress?.(completed, totalBytes);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));

	// 1 本でも失敗したら全体を失敗にする。穴の空いたファイルを作らない
	if (failure !== undefined) return err(failure);

	return ok(parts);
}

/** 取得した並びの合計バイト数。 */
export function totalByteLength(parts: readonly Uint8Array[]): number {
	return parts.reduce((total, part) => total + part.byteLength, 0);
}
