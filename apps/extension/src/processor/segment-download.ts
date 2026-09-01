import { AES_BLOCK_BYTES } from '../media/hls/decryption';
import type { DecryptorPort } from '../shared/ports/decryptor.port';
import type { SegmentFetchFailure, SegmentFetcherPort } from '../shared/ports/segment-fetcher.port';
import { type Result, err, ok } from '../shared/utils';
import type { PlannedSegment } from './hls-download';

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

export type SegmentDownloadError =
	/** 取得に失敗した。何本目かを添える */
	| { type: 'fetch-failed'; index: number; failure: SegmentFetchFailure }
	/** 鍵を取得できなかった */
	| { type: 'key-failed'; index: number; failure: SegmentFetchFailure }
	/** 鍵は取れたが復号できなかった */
	| { type: 'decrypt-failed'; index: number }
	/** 合計が上限を超えた */
	| { type: 'too-large'; limitBytes: number }
	/** ユーザーによる中止 */
	| { type: 'cancelled' };

type SegmentDownloadOptions = {
	segments: readonly PlannedSegment[];
	fetcher: SegmentFetcherPort;
	/** AES-128 の復号。暗号化されたセグメントが 1 本でもあれば必要 */
	decryptor?: DecryptorPort;
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
 *
 * 暗号化されたセグメントは、鍵を取得して復号してから並びへ入れる。
 * **鍵は URL ごとに 1 回だけ取る。** セグメント本数ぶん取りに行くと、
 * 配信側から見て不自然な量になるうえ、単純に遅い。
 */
export async function downloadSegments(
	options: SegmentDownloadOptions,
): Promise<Result<Uint8Array<ArrayBuffer>[], SegmentDownloadError>> {
	const { segments, fetcher, decryptor, maxBytes, onProgress, isCancelled } = options;
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

	// 添字ごとに 1 回だけ書き込む。空で始めておけば、後段で穴の有無を
	// 確かめる分岐（起こり得ない）を持たずに済む
	const parts: Uint8Array<ArrayBuffer>[] = segments.map(() => new Uint8Array(new ArrayBuffer(0)));
	let completed = 0;
	let totalBytes = 0;
	let failure: SegmentDownloadError | undefined;
	let next = 0;

	/**
	 * 鍵の取得。同じ URL への同時要求は 1 本にまとめる。
	 *
	 * Promise をそのまま覚えることで、複数のワーカーが同時に同じ鍵を
	 * 要求しても取得は 1 回で済む。
	 */
	const keys = new Map<string, Promise<Result<Uint8Array<ArrayBuffer>, SegmentFetchFailure>>>();
	function fetchKey(url: string): Promise<Result<Uint8Array<ArrayBuffer>, SegmentFetchFailure>> {
		const pending = keys.get(url);
		if (pending !== undefined) return pending;

		// AES-128 の鍵は 16 バイトと決まっている。読み切ってから長さを見ると、
		// 巨大な応答を返す鍵 URL でメモリを食い潰される
		const request = fetcher.fetchBytes(url, { maxBytes: AES_BLOCK_BYTES });
		keys.set(url, request);
		return request;
	}

	async function resolveBytes(
		segment: PlannedSegment,
		index: number,
	): Promise<Result<Uint8Array<ArrayBuffer>, SegmentDownloadError>> {
		const fetched = await fetcher.fetchBytes(
			segment.url,
			segment.byteRange === undefined
				? undefined
				: { range: { offset: segment.byteRange.offset, length: segment.byteRange.length } },
		);
		if (!fetched.ok) return err({ type: 'fetch-failed', index, failure: fetched.error });

		if (segment.decryption === undefined) return ok(fetched.value);

		// 復号できない状態で平文として返さない。暗号文をそのまま保存してしまう
		if (decryptor === undefined) return err({ type: 'decrypt-failed', index });

		const key = await fetchKey(segment.decryption.keyUrl);
		if (!key.ok) return err({ type: 'key-failed', index, failure: key.error });
		if (key.value.byteLength !== AES_BLOCK_BYTES) return err({ type: 'decrypt-failed', index });

		const decrypted = await decryptor.decryptAesCbc(
			fetched.value,
			key.value,
			segment.decryption.iv,
		);
		if (!decrypted.ok) return err({ type: 'decrypt-failed', index });

		return ok(decrypted.value);
	}

	async function worker(): Promise<void> {
		for (;;) {
			if (isCancelled?.() === true) {
				failure ??= { type: 'cancelled' };
				return;
			}

			const index = next++;
			const segment = segments[index];
			if (segment === undefined) return;

			const resolved = await resolveBytes(segment, index);

			// 待っている間に他のワーカーが失敗していることがある。
			// ここで降りないと、失敗が確定した後も取り続けてしまう
			if (failure !== undefined) return;

			if (!resolved.ok) {
				failure = resolved.error;
				return;
			}

			parts[index] = resolved.value;
			completed += 1;
			totalBytes += resolved.value.byteLength;

			if (totalBytes > maxBytes) {
				failure = { type: 'too-large', limitBytes: maxBytes };
				return;
			}

			onProgress?.(completed, totalBytes);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, worker));

	// 1 本でも失敗したら全体を失敗にする。穴の空いたファイルを作らない
	if (failure !== undefined) return err(failure);

	return ok(parts);
}

/** 取得した並びの合計バイト数。 */
export function totalByteLength(parts: readonly Uint8Array[]): number {
	return parts.reduce((total, part) => total + part.byteLength, 0);
}
