import { parseMpd } from '../media/dash/parser';
import { detectPlaylistKind, parseMediaPlaylist } from '../media/hls/parser';
import { planDashDownload } from '../processor/dash-download';
import type { MediaContainer, PlannedSegment } from '../processor/download-plan';
import { planHlsDownload } from '../processor/hls-download';
import { type RunToken, createRunRegistry } from '../processor/run-registry';
import { type SegmentDownloadError, downloadSegments } from '../processor/segment-download';
import {
	type BackgroundToOffscreen,
	type OffscreenToBackground,
	parseAssemblyCommand,
} from '../shared/messages';
import { assembleBlob, releaseObjectUrl } from './blob-assembler';
import { createDecryptor } from './decryptor.adapter';
import { createSegmentFetcher } from './segment-fetcher';

/**
 * Offscreen Document のエントリ兼 Composition Root。
 *
 * Manifest V3 の Service Worker では `URL.createObjectURL` が使えないため、
 * セグメント結合・Blob 生成・オブジェクト URL 発行はここで行う。
 * Service Worker が停止しても処理が続く場所でもある（要件定義 2.7）。
 *
 * **ここは実行コンテキスト層。** 取得制御と保存可否の判定は
 * `processor/` `media/` の純粋なロジックに任せ、ここは副作用の配線に徹する。
 */

const FETCH_FAILED = 'セグメントを取得できませんでした';
const KEY_FAILED = '復号鍵を取得できませんでした';
const DECRYPT_FAILED = 'セグメントを復号できませんでした';
const RANGE_FAILED = '配信側がバイトレンジ指定に対応していませんでした';
const PLAYLIST_FAILED = 'マニフェストを取得できませんでした';
const NOT_A_PLAYLIST = 'プレイリストとして解析できませんでした';
const NOT_AN_MPD = 'MPD として解析できませんでした';
const MASTER_PLAYLIST = '画質を選び直してからもう一度お試しください';
const TOO_LARGE = 'サイズが上限を超えたため中止しました';
const CANCELLED = 'ダウンロードを中止しました';

type AssembleCommand = Extract<BackgroundToOffscreen, { kind: 'assemble' }>;

type AssemblyPlan = {
	segments: readonly PlannedSegment[];
	container: MediaContainer;
};

/** 出力するコンテナに対応する MIME タイプ。 */
const MIME_BY_CONTAINER: Record<MediaContainer, string> = {
	ts: 'video/mp2t',
	mp4: 'video/mp4',
};

/**
 * 進行中の組み立て。
 *
 * 同じタスク ID で走り直したときに旧実行と混ざらないよう、世代で区別する
 * （`processor/run-registry.ts`）。
 */
const runs = createRunRegistry();

/**
 * 進捗を通知する間隔（ms）。
 *
 * 1 本ごとに通知すると、セグメント数と同じ回数だけ Service Worker を起こし、
 * storage への書き込みと Popup への配信が走る。
 */
const PROGRESS_INTERVAL_MS = 500;

function notify(message: OffscreenToBackground): void {
	// Service Worker が停止していても、送信で起こされる
	void chrome.runtime.sendMessage(message).catch(() => {
		// 受け手が居ない場合に投げる。組み立て自体は続ける
	});
}

function fail(taskId: string, run: RunToken, reason: string): void {
	// 旧実行の失敗で、走り直している実行を巻き込まない
	if (!runs.isCurrent(taskId, run)) return;

	runs.end(taskId, run);
	notify({ kind: 'assembly-failed', taskId, reason });
}

/**
 * 組み立ての結果を伝える。
 *
 * **送れなかったら自分で解放する。** 受け手が居なければ、この Blob を
 * 解放できる者が居なくなる（Offscreen Document は閉じない）。
 */
function notifyDone(
	taskId: string,
	objectUrl: string,
	bytes: number,
	container: MediaContainer,
): void {
	void chrome.runtime
		.sendMessage({ kind: 'assembly-done', taskId, objectUrl, bytes, container })
		.catch(() => {
			releaseObjectUrl(objectUrl);
		});
}

/**
 * 取得の失敗を、そのままユーザーへ出せる文言にする。
 *
 * 引数を `SegmentDownloadError` で受けて網羅させる。緩い型にすると、
 * 種別を足したときに既定の文言へ黙って丸まる。
 */
function describeFailure(error: SegmentDownloadError): string {
	switch (error.type) {
		case 'too-large':
			return TOO_LARGE;
		case 'key-failed':
			return KEY_FAILED;
		case 'decrypt-failed':
			return DECRYPT_FAILED;
		case 'cancelled':
			return CANCELLED;
		case 'fetch-failed':
			return error.failure.reason === 'range-not-satisfied' ? RANGE_FAILED : FETCH_FAILED;
	}
}

/**
 * マニフェストを解析して保存計画を作る。
 *
 * 形式ごとの違いはここだけに閉じる。取得と結合から先は共通。
 */
function buildPlan(
	command: AssembleCommand,
	text: string,
): { ok: true; value: AssemblyPlan } | { ok: false; reason: string } {
	const { manifestUrl, allowPrivateHosts } = command;

	if (command.format === 'dash') {
		const parsed = parseMpd(text, manifestUrl);
		if (!parsed.ok) return { ok: false, reason: NOT_AN_MPD };

		const plan = planDashDownload(parsed.value, {
			allowPrivateHosts,
			...(command.representationId !== undefined && {
				representationId: command.representationId,
			}),
		});
		return plan.ok ? { ok: true, value: plan.value } : { ok: false, reason: plan.error.reason };
	}

	// Master Playlist を渡されたら、画質が未確定のまま押されている
	if (detectPlaylistKind(text) === 'master') return { ok: false, reason: MASTER_PLAYLIST };

	const parsed = parseMediaPlaylist(text, manifestUrl);
	if (!parsed.ok) return { ok: false, reason: NOT_A_PLAYLIST };

	const plan = planHlsDownload(parsed.value, { allowPrivateHosts });
	return plan.ok ? { ok: true, value: plan.value } : { ok: false, reason: plan.error.reason };
}

async function assemble(command: AssembleCommand): Promise<void> {
	const { taskId, manifestUrl, maxBytes, allowPrivateHosts } = command;

	const run = runs.start(taskId);
	// 取得の宛先は依頼ごとに決まる。使い回さず、この実行のためだけに作る
	const fetcher = createSegmentFetcher({ allowPrivateHosts });

	const manifest = await fetcher.fetchText(manifestUrl);
	if (!manifest.ok) {
		fail(taskId, run, PLAYLIST_FAILED);
		return;
	}

	const plan = buildPlan(command, manifest.text);
	if (!plan.ok) {
		fail(taskId, run, plan.reason);
		return;
	}

	const total = plan.value.segments.length;
	let lastNotifiedAt = 0;

	const fetched = await downloadSegments({
		segments: plan.value.segments,
		fetcher,
		// 暗号化されていなければ使われない。作るだけなら副作用はない
		decryptor: createDecryptor(),
		maxBytes,
		onProgress: (completed, bytes) => {
			if (!runs.isCurrent(taskId, run)) return;

			const now = Date.now();
			if (completed < total && now - lastNotifiedAt < PROGRESS_INTERVAL_MS) return;

			lastNotifiedAt = now;
			notify({ kind: 'assembly-progress', taskId, completed, total, bytes });
		},
		// 走り直された旧実行も、ここで自分から降りる
		isCancelled: () => run.cancelled || !runs.isCurrent(taskId, run),
	});

	if (!fetched.ok) {
		fail(taskId, run, describeFailure(fetched.error));
		return;
	}

	// **中身に合った MIME タイプを付ける。** fMP4 を video/mp2t として
	// 保存すると、保存先によっては拡張子まで書き換えられる
	const assembled = assembleBlob(fetched.value, MIME_BY_CONTAINER[plan.value.container]);

	// 走り直された旧実行の結果は渡さない。渡すと新しい実行の結果として扱われる
	if (!runs.isCurrent(taskId, run)) {
		releaseObjectUrl(assembled.objectUrl);
		return;
	}

	runs.end(taskId, run);
	notifyDone(taskId, assembled.objectUrl, assembled.bytes, plan.value.container);
}

chrome.runtime.onMessage.addListener((raw, sender) => {
	// 送信元を検証する。Background 以外から動かされないための防壁。
	// Content Script は拡張機能の ID を名乗れるが、その場合 tab を持つ
	if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;

	const command = parseAssemblyCommand(raw);
	if (command === undefined) return false;

	if (command.kind === 'assemble') {
		void assemble(command).catch(() => {
			// 例外で降りたときも、走っている実行として残さない
			const run = runs.start(command.taskId);
			fail(command.taskId, run, FETCH_FAILED);
		});
		return false;
	}

	if (command.kind === 'cancel-assembly') {
		runs.cancel(command.taskId);
		return false;
	}

	releaseObjectUrl(command.objectUrl);
	return false;
});
