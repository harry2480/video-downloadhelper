import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { popupUrl } from '../e2e/fixtures';
import { FIXTURES_DIR } from '../e2e/static-server';
import {
	type Harness,
	readStoredMedia,
	readStoredTasks,
	resolveTabId,
	searchDownloads,
	snapshot,
	startHarness,
	stopHarness,
	waitFor,
} from './helpers';

/**
 * HLS（TS セグメント）保存の Integration テスト。
 *
 * MVP 完了条件「非 DRM・非暗号化の HLS 動画（TS セグメント）を
 * 単一の .ts ファイルとして保存できる」に対応する。
 *
 * Offscreen Document でのセグメント取得・結合を通し、実際に
 * セグメントを連結したファイルができることを実 Chrome で確認する。
 */

let harness: Harness;

beforeAll(async () => {
	harness = await startHarness();
}, 60_000);

afterAll(async () => {
	await stopHarness(harness);
});

/** 期待するファイルの中身。フィクスチャのセグメントを順に連結したもの。 */
async function expectedBytes(): Promise<Buffer> {
	const dir = path.join(FIXTURES_DIR, 'hls/1080p');
	const segments = await Promise.all([
		readFile(path.join(dir, 'seg0.ts')),
		readFile(path.join(dir, 'seg1.ts')),
	]);

	return Buffer.concat(segments);
}

describe('HLS の保存', () => {
	it('セグメントを連結した 1 本のファイルが生成される', async () => {
		const contentPage = await harness.context.newPage();
		await contentPage.goto(`${harness.server.origin}/media-hls.html`);
		const tabId = await resolveTabId(harness, 'media-hls.html');

		const popup = await harness.context.newPage();
		await popup.goto(popupUrl(harness.extensionId));

		// ポップアップのタブがアクティブになるため、いったん元のタブへ戻す
		await contentPage.bringToFront();
		await popup.reload();

		// **解析の完了を待つ。** 保存ボタンの有無で待つと、解析前でも
		// 出ていないことの確認にしかならず、Master Playlist を渡してしまう
		await waitFor(
			() => readStoredMedia(harness, tabId),
			(media) => media?.[0]?.manifestResolved === true,
			{ timeoutMs: 20_000, label: '画質一覧の取得', diagnose: () => snapshot(harness) },
		);

		await expect
			.poll(() => popup.getByRole('button', { name: '保存' }).count(), { timeout: 20_000 })
			.toBe(1);

		await popup.getByRole('button', { name: '保存' }).click();

		const completed = await waitFor(
			async () => (await searchDownloads(harness)).find((item) => item.state === 'complete'),
			(item) => item !== undefined,
			{ timeoutMs: 30_000, label: 'HLS の保存の完了', diagnose: () => snapshot(harness) },
		);
		if (completed === undefined) throw new Error('保存が完了しませんでした');

		// セグメントが順番どおりに連結されていること。順序が狂うと再生できない
		const expected = await expectedBytes();
		expect(await readFile(completed.filename)).toEqual(expected);

		const tasks = await readStoredTasks(harness);
		expect(tasks?.[0]).toMatchObject({ tabId, status: 'completed', progress: 100 });
		// 既定は最高品質。ファイル名にも解像度が入る
		expect(tasks?.[0]?.filename).toMatch(/1080p\.ts$/);

		await popup.close();
		await contentPage.close();
	}, 90_000);
});
