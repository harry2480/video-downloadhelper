import { describe, expect, it } from 'vitest';
import type { DownloadSnapshot } from '../shared/ports/download.port';
import type { DownloadTask } from '../shared/types';
import {
	applyDownloadSnapshot,
	describeInterruptReason,
	isActive,
	isFinished,
	markDownloadCancelled,
	markDownloadFailed,
	resetDownloadTask,
	toProgress,
} from './download-task';

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
	return {
		id: 'task-1',
		mediaId: '1:https://cdn.example.com/v.mp4',
		tabId: 1,
		filename: 'video.mp4',
		status: 'downloading',
		progress: 0,
		startedAt: 1_000,
		browserDownloadId: 7,
		...overrides,
	};
}

function snapshot(overrides: Partial<DownloadSnapshot> = {}): DownloadSnapshot {
	return { downloadId: 7, state: 'in-progress', bytesReceived: 0, ...overrides };
}

describe('toProgress', () => {
	it('受信バイト数から進捗率を出す', () => {
		expect(toProgress(50, 200)).toBe(25);
	});

	it('総バイト数が分からなければ 0 にする', () => {
		// 進んでいるように見せるより、分からないことを示す
		expect(toProgress(500, undefined)).toBe(0);
		expect(toProgress(500, 0)).toBe(0);
	});

	it('受信が総量を超えても 100 を上限にする', () => {
		expect(toProgress(300, 200)).toBe(100);
	});

	it('受信が 0 以下なら 0 にする', () => {
		expect(toProgress(0, 200)).toBe(0);
		expect(toProgress(-1, 200)).toBe(0);
	});
});

describe('describeInterruptReason', () => {
	it('既知の理由を日本語にする', () => {
		expect(describeInterruptReason('NETWORK_FAILED')).toBe('通信に失敗しました');
		expect(describeInterruptReason('SERVER_FORBIDDEN')).toContain('拒否されました');
	});

	it('未知の理由はそのまま出さず一般的な文言へ倒す', () => {
		// ブラウザ由来の文字列をユーザーへ素通しにしない
		expect(describeInterruptReason('SOMETHING_NEW')).toBe('ダウンロードが中断されました');
		expect(describeInterruptReason(undefined)).toBe('ダウンロードが中断されました');
	});
});

describe('applyDownloadSnapshot', () => {
	it('取得中は進捗とバイト数を反映する', () => {
		const applied = applyDownloadSnapshot(
			task(),
			snapshot({ bytesReceived: 300, totalBytes: 1_200 }),
		);

		expect(applied.status).toBe('downloading');
		expect(applied.progress).toBe(25);
		expect(applied.downloadedBytes).toBe(300);
		expect(applied.totalBytes).toBe(1_200);
	});

	it('総バイト数が後から分かった場合も進捗を出せる', () => {
		const known = applyDownloadSnapshot(task(), snapshot({ bytesReceived: 10, totalBytes: 100 }));
		const withoutTotal = applyDownloadSnapshot(known, snapshot({ bytesReceived: 50 }));

		expect(withoutTotal.progress).toBe(50);
	});

	it('完了したら 100% にする', () => {
		const applied = applyDownloadSnapshot(
			task(),
			snapshot({ state: 'complete', bytesReceived: 90 }),
		);

		expect(applied.status).toBe('completed');
		expect(applied.progress).toBe(100);
	});

	it('ユーザーによる中止は失敗ではなくキャンセルにする', () => {
		const applied = applyDownloadSnapshot(
			task(),
			snapshot({ state: 'interrupted', interruptReason: 'USER_CANCELED' }),
		);

		expect(applied.status).toBe('cancelled');
		expect(applied.error).toBeUndefined();
	});

	it('中断は理由を添えて失敗にする', () => {
		const applied = applyDownloadSnapshot(
			task(),
			snapshot({ state: 'interrupted', interruptReason: 'FILE_NO_SPACE' }),
		);

		expect(applied.status).toBe('failed');
		expect(applied.error).toBe('ディスクの空き容量が足りません');
	});

	it('終了済みのタスクは動かさない', () => {
		// ダウンロード ID が再利用された場合に状態が巻き戻らないようにする
		const done = task({ status: 'completed', progress: 100 });

		expect(applyDownloadSnapshot(done, snapshot({ bytesReceived: 1 }))).toBe(done);
	});

	it('元のオブジェクトを変更しない', () => {
		const original = task();
		applyDownloadSnapshot(original, snapshot({ state: 'complete', bytesReceived: 1 }));

		expect(original.status).toBe('downloading');
	});
});

describe('状態の遷移', () => {
	it('失敗を記録する', () => {
		expect(markDownloadFailed(task(), '通信に失敗しました')).toMatchObject({
			status: 'failed',
			error: '通信に失敗しました',
		});
	});

	it('中止を記録する', () => {
		expect(markDownloadCancelled(task()).status).toBe('cancelled');
	});

	it('再試行では失敗の痕跡を消し、ファイル名と選択品質を引き継ぐ', () => {
		const failed = task({
			status: 'failed',
			error: '通信に失敗しました',
			progress: 40,
			downloadedBytes: 400,
			totalBytes: 1_000,
			variantId: 'v1',
		});

		const restarted = resetDownloadTask(failed, 2_000);

		expect(restarted).toMatchObject({
			status: 'queued',
			progress: 0,
			filename: 'video.mp4',
			variantId: 'v1',
			startedAt: 2_000,
		});
		expect(restarted).not.toHaveProperty('error');
		expect(restarted).not.toHaveProperty('browserDownloadId');
		expect(restarted).not.toHaveProperty('downloadedBytes');
		// 総量を残すと、再試行先が Content-Length を返さないとき前回の値で割ってしまう
		expect(restarted).not.toHaveProperty('totalBytes');
	});

	it('進行中と終了済みを区別する', () => {
		expect(isActive(task({ status: 'queued' }))).toBe(true);
		expect(isActive(task({ status: 'downloading' }))).toBe(true);
		expect(isActive(task({ status: 'processing' }))).toBe(true);
		expect(isFinished(task({ status: 'completed' }))).toBe(true);
		expect(isFinished(task({ status: 'failed' }))).toBe(true);
		expect(isFinished(task({ status: 'cancelled' }))).toBe(true);
	});
});
