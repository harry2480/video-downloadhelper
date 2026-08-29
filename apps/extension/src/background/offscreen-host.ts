import type { BackgroundToOffscreen } from '../shared/messages';
import type { AssemblerPort } from '../shared/ports/assembler.port';

/**
 * Offscreen Document の生成と、そこへの依頼（要件定義 2.6）。
 *
 * **Offscreen Document は 1 つしか作れない。** 生成の要求が重なると
 * 2 つ目で例外になるため、生成は直列化して使い回す。
 *
 * 生成した Document は閉じない。組み立て結果のオブジェクト URL は
 * この Document に属し、閉じると `chrome.downloads` が読む前に失効するため。
 */

const OFFSCREEN_PATH = 'src/offscreen/index.html';
const JUSTIFICATION = 'HLS のセグメントを結合して保存用の Blob を作るため';

/** 生成直後は受け手のスクリプトがまだ動いていないことがある。 */
const SEND_RETRIES = 3;
const RETRY_INTERVAL_MS = 50;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createOffscreenHost(): AssemblerPort {
	let creating: Promise<void> | undefined;

	async function ensureDocument(): Promise<void> {
		if (await chrome.offscreen.hasDocument()) return;

		// 同時に呼ばれても生成は 1 回にする
		creating ??= chrome.offscreen
			.createDocument({
				url: OFFSCREEN_PATH,
				reasons: [chrome.offscreen.Reason.BLOBS],
				justification: JUSTIFICATION,
			})
			.finally(() => {
				creating = undefined;
			});

		try {
			await creating;
		} catch {
			// 別の呼び出しが先に作り終えていた場合に投げる。存在すれば成功として扱う
			if (!(await chrome.offscreen.hasDocument())) {
				throw new Error('Offscreen Document を作成できませんでした');
			}
		}
	}

	async function send(message: BackgroundToOffscreen): Promise<void> {
		await ensureDocument();

		for (let attempt = 1; ; attempt += 1) {
			try {
				await chrome.runtime.sendMessage(message);
				return;
			} catch (error) {
				// 生成直後はリスナー登録前で「受け手が居ない」になる
				if (attempt >= SEND_RETRIES) throw error;
				await wait(RETRY_INTERVAL_MS);
			}
		}
	}

	return {
		async start(job) {
			await send({
				kind: 'assemble-hls',
				taskId: job.taskId,
				playlistUrl: job.playlistUrl,
				maxBytes: job.maxBytes,
			});
		},

		async cancel(taskId) {
			try {
				await send({ kind: 'cancel-assembly', taskId });
			} catch {
				// Document が無ければ組み立ても走っていない
			}
		},

		async release(objectUrl) {
			try {
				await send({ kind: 'release-object-url', objectUrl });
			} catch {
				// Document が無ければオブジェクト URL も既に失効している
			}
		},
	};
}
