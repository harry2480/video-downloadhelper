import { readFile, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { popupUrl } from '../e2e/fixtures';
import {
	type Harness,
	readStoredTasks,
	resolveTabId,
	searchDownloads,
	snapshot,
	startHarness,
	stopHarness,
	waitFor,
} from './helpers';

/**
 * 直接メディアのダウンロードの Integration テスト。
 *
 * MVP 完了条件「通常の MP4 動画を保存できる」「ダウンロード中の基本的な状態が
 * 表示される」に対応する。実際にファイルが生成されるところまで確かめる。
 */

/** `test/fixtures/pages/sample.mp4` の中身。生成されたファイルと突き合わせる。 */
const EXPECTED_BYTES = Buffer.from('FAKE_MP4_FOR_DETECTION_ONLY');

let harness: Harness;
/** 生成されたファイル。後片付けのために覚えておく */
const savedFiles: string[] = [];

beforeAll(async () => {
	harness = await startHarness();
}, 60_000);

afterAll(async () => {
	await stopHarness(harness);

	for (const file of savedFiles) {
		await rm(file, { force: true });
	}
});

describe('直接メディアの保存', () => {
	it('ポップアップの保存ボタンで実ファイルが生成される', async () => {
		const contentPage = await harness.context.newPage();
		await contentPage.goto(`${harness.server.origin}/media-mp4.html`);
		const tabId = await resolveTabId(harness, 'media-mp4.html');

		const popup = await harness.context.newPage();
		await popup.goto(popupUrl(harness.extensionId));

		// ポップアップのタブがアクティブになるため、いったん元のタブへ戻す
		await contentPage.bringToFront();
		await popup.reload();

		await expect
			.poll(() => popup.getByRole('button', { name: '保存' }).count(), { timeout: 15_000 })
			.toBe(1);

		await popup.getByRole('button', { name: '保存' }).click();

		const completed = await waitFor(
			async () => (await searchDownloads(harness)).find((item) => item.state === 'complete'),
			(item) => item !== undefined,
			{ timeoutMs: 20_000, label: 'ダウンロードの完了', diagnose: () => snapshot(harness) },
		);
		if (completed === undefined) throw new Error('ダウンロードが完了しませんでした');

		savedFiles.push(completed.filename);

		expect(completed.filename).toMatch(/\.mp4$/);
		expect(completed.bytesReceived).toBe(EXPECTED_BYTES.byteLength);

		// ファイルの中身まで確認する。状態だけ見ても中身が空のことがある
		const saved = await readFile(completed.filename);
		expect(saved.byteLength).toBe(EXPECTED_BYTES.byteLength);
		expect(saved.subarray(0, 8)).toEqual(EXPECTED_BYTES.subarray(0, 8));

		// 進捗は storage 側に残る。Service Worker が止まっても復元できる形
		const tasks = await readStoredTasks(harness);
		expect(tasks?.[0]).toMatchObject({ tabId, status: 'completed', progress: 100 });

		await popup.close();
		await contentPage.close();
	}, 60_000);
});
