import { parseMediaPlaylist } from '../media/hls/parser';
import { planHlsDownload } from '../processor/hls-download';
import { downloadSegments } from '../processor/segment-download';
import { type OffscreenToBackground, parseAssemblyCommand } from '../shared/messages';
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
const TOO_LARGE = 'サイズが上限を超えたため中止しました';
const CANCELLED = 'ダウンロードを中止しました';

const fetcher = createSegmentFetcher();

/** 進行中の組み立て。中止の要求を受け取るために持つ。 */
const cancelled = new Set<string>();

function notify(message: OffscreenToBackground): void {
	// Service Worker が停止していても、送信で起こされる
	void chrome.runtime.sendMessage(message).catch(() => {
		// 受け手が居ない場合に投げる。組み立て自体は続ける
	});
}

function fail(taskId: string, reason: string): void {
	cancelled.delete(taskId);
	notify({ kind: 'assembly-failed', taskId, reason });
}

async function assemble(taskId: string, playlistUrl: string, maxBytes: number): Promise<void> {
	const manifest = await fetcher.fetchText(playlistUrl);
	if (!manifest.ok) {
		fail(taskId, PLAYLIST_FAILED);
		return;
	}

	const parsed = parseMediaPlaylist(manifest.text, playlistUrl);
	if (!parsed.ok) {
		fail(taskId, NOT_A_PLAYLIST);
		return;
	}

	const plan = planHlsDownload(parsed.value);
	if (!plan.ok) {
		fail(taskId, plan.error.reason);
		return;
	}

	const total = plan.value.segmentUrls.length;
	const fetched = await downloadSegments({
		urls: plan.value.segmentUrls,
		fetcher,
		maxBytes,
		onProgress: (completed, bytes) => {
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
	cancelled.delete(taskId);

	notify({
		kind: 'assembly-done',
		taskId,
		objectUrl: assembled.objectUrl,
		bytes: assembled.bytes,
	});
}

chrome.runtime.onMessage.addListener((raw, sender) => {
	// 送信元を検証する。Background 以外から動かされないための防壁。
	// Content Script は拡張機能の ID を名乗れるが、その場合 tab を持つ
	if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;

	const command = parseAssemblyCommand(raw);
	if (command === undefined) return false;

	if (command.kind === 'assemble-hls') {
		void assemble(command.taskId, command.playlistUrl, command.maxBytes).catch(() => {
			fail(command.taskId, FETCH_FAILED);
		});
		return false;
	}

	if (command.kind === 'cancel-assembly') {
		cancelled.add(command.taskId);
		return false;
	}

	releaseObjectUrl(command.objectUrl);
	return false;
});
