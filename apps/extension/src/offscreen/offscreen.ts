import { detectPlaylistKind, parseMediaPlaylist } from '../media/hls/parser';
import { planHlsDownload } from '../processor/hls-download';
import { downloadSegments } from '../processor/segment-download';
import {
	type BackgroundToOffscreen,
	type OffscreenToBackground,
	parseAssemblyCommand,
} from '../shared/messages';
import { assembleBlob, releaseObjectUrl } from './blob-assembler';
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
const PLAYLIST_FAILED = 'プレイリストを取得できませんでした';
const NOT_A_PLAYLIST = 'プレイリストとして解析できませんでした';
const MASTER_PLAYLIST = '画質を選び直してからもう一度お試しください';
const TOO_LARGE = 'サイズが上限を超えたため中止しました';
const CANCELLED = 'ダウンロードを中止しました';

type AssembleCommand = Extract<BackgroundToOffscreen, { kind: 'assemble-hls' }>;

const fetcher = createSegmentFetcher();

/** 進行中の組み立て。中止の要求を受け取るために持つ。 */
const running = new Set<string>();
const cancelled = new Set<string>();

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

function finish(taskId: string): void {
	running.delete(taskId);
	cancelled.delete(taskId);
}

function fail(taskId: string, reason: string): void {
	finish(taskId);
	notify({ kind: 'assembly-failed', taskId, reason });
}

/**
 * 組み立ての結果を伝える。
 *
 * **送れなかったら自分で解放する。** 受け手が居なければ、この Blob を
 * 解放できる者が居なくなる（Offscreen Document は閉じない）。
 */
function notifyDone(taskId: string, objectUrl: string, bytes: number): void {
	void chrome.runtime.sendMessage({ kind: 'assembly-done', taskId, objectUrl, bytes }).catch(() => {
		releaseObjectUrl(objectUrl);
	});
}

async function assemble(command: AssembleCommand): Promise<void> {
	const { taskId, playlistUrl, maxBytes, allowPrivateHosts } = command;

	// 前回の中止指示を持ち越さない。同じ ID で再試行されることがある
	cancelled.delete(taskId);
	running.add(taskId);

	const manifest = await fetcher.fetchText(playlistUrl);
	if (!manifest.ok) {
		fail(taskId, PLAYLIST_FAILED);
		return;
	}

	// Master Playlist を渡されたら、画質が未確定のまま押されている
	if (detectPlaylistKind(manifest.text) === 'master') {
		fail(taskId, MASTER_PLAYLIST);
		return;
	}

	const parsed = parseMediaPlaylist(manifest.text, playlistUrl);
	if (!parsed.ok) {
		fail(taskId, NOT_A_PLAYLIST);
		return;
	}

	const plan = planHlsDownload(parsed.value, { allowPrivateHosts });
	if (!plan.ok) {
		fail(taskId, plan.error.reason);
		return;
	}

	const total = plan.value.segmentUrls.length;
	let lastNotifiedAt = 0;

	const fetched = await downloadSegments({
		urls: plan.value.segmentUrls,
		fetcher,
		maxBytes,
		onProgress: (completed, bytes) => {
			const now = Date.now();
			if (completed < total && now - lastNotifiedAt < PROGRESS_INTERVAL_MS) return;

			lastNotifiedAt = now;
			notify({ kind: 'assembly-progress', taskId, completed, total, bytes });
		},
		isCancelled: () => cancelled.has(taskId),
	});

	if (!fetched.ok) {
		if (fetched.error.type === 'cancelled') {
			fail(taskId, CANCELLED);
			return;
		}
		fail(taskId, fetched.error.type === 'too-large' ? TOO_LARGE : FETCH_FAILED);
		return;
	}

	const assembled = assembleBlob(fetched.value);
	finish(taskId);

	notifyDone(taskId, assembled.objectUrl, assembled.bytes);
}

chrome.runtime.onMessage.addListener((raw, sender) => {
	// 送信元を検証する。Background 以外から動かされないための防壁。
	// Content Script は拡張機能の ID を名乗れるが、その場合 tab を持つ
	if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;

	const command = parseAssemblyCommand(raw);
	if (command === undefined) return false;

	if (command.kind === 'assemble-hls') {
		void assemble(command).catch(() => {
			fail(command.taskId, FETCH_FAILED);
		});
		return false;
	}

	if (command.kind === 'cancel-assembly') {
		// 走っていないものを覚えても、次の再試行を邪魔するだけ
		if (running.has(command.taskId)) cancelled.add(command.taskId);
		return false;
	}

	releaseObjectUrl(command.objectUrl);
	return false;
});
