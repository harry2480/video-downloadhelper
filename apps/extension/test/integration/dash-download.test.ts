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
 * DASH 保存の Integration テスト。
 *
 * MPD の解析からセグメントの取得・結合までを実 Chrome で通しで確認する。
 * **Service Worker には DOMParser が無い**ため、自前の XML パーサーが
 * 実環境でも動くことをここで担保する（Unit テストは Node.js 上で走る）。
 */

let harness: Harness;

beforeAll(async () => {
	harness = await startHarness();
}, 60_000);

afterAll(async () => {
	await stopHarness(harness);
});

const fixture = (relative: string) => readFile(path.join(FIXTURES_DIR, relative));

describe('DASH の解析', () => {
	it('MPD から画質一覧を取得して高画質順に並べる', async () => {
		const page = await harness.context.newPage();

		try {
			await page.goto(`${harness.server.origin}/media-dash.html`);
			const tabId = await resolveTabId(harness, 'media-dash.html');

			const stored = await waitFor(
				() => readStoredMedia(harness, tabId),
				(media) => media?.[0]?.manifestResolved === true,
				{ label: 'MPD の解析', diagnose: () => snapshot(harness) },
			);

			const dash = stored?.[0];
			expect(dash?.type).toBe('dash');
			expect(dash?.unsupportedReason).toBeUndefined();
			expect(dash?.variants?.map((variant) => variant.height)).toEqual([1080, 360]);
			expect(dash?.variants?.[0]?.url).toContain('init-hi.mp4');
		} finally {
			await page.close();
		}
	}, 60_000);

	it('映像と音声が分かれていれば理由を出す', async () => {
		// 映像だけを保存すると「音の出ない動画」が黙って出来上がる。
		// 一覧は出しつつ、保存の段で理由を返す
		const page = await harness.context.newPage();

		try {
			await page.goto(`${harness.server.origin}/media-dash-separate.html`);
			const tabId = await resolveTabId(harness, 'media-dash-separate.html');

			const stored = await waitFor(
				() => readStoredMedia(harness, tabId),
				(media) => media?.[0]?.manifestResolved === true,
				{ label: '分離 MPD の解析', diagnose: () => snapshot(harness) },
			);

			// 解析の時点では対応外にしない（画質は選べる）
			expect(stored?.[0]?.unsupportedReason).toBeUndefined();
			expect(stored?.[0]?.variants).toHaveLength(1);
		} finally {
			await page.close();
		}
	}, 60_000);
});

describe('DASH の保存', () => {
	it('初期化セグメントとセグメントを連結した mp4 を保存する', async () => {
		const contentPage = await harness.context.newPage();
		const popup = await harness.context.newPage();

		try {
			await contentPage.goto(`${harness.server.origin}/media-dash.html`);
			const tabId = await resolveTabId(harness, 'media-dash.html');

			await popup.goto(popupUrl(harness.extensionId));
			await contentPage.bringToFront();
			await popup.reload();

			await waitFor(
				() => readStoredMedia(harness, tabId),
				(media) => media?.[0]?.manifestResolved === true,
				{ timeoutMs: 20_000, label: '画質一覧の取得', diagnose: () => snapshot(harness) },
			);

			await expect
				.poll(() => popup.getByRole('button', { name: '保存' }).count(), { timeout: 20_000 })
				.toBe(1);

			const before = new Set((await searchDownloads(harness)).map((item) => item.id));
			await popup.getByRole('button', { name: '保存' }).click();

			const completed = await waitFor(
				async () =>
					(await searchDownloads(harness)).find(
						(item) => item.state === 'complete' && !before.has(item.id),
					),
				(item) => item !== undefined,
				{ timeoutMs: 30_000, label: 'DASH の保存の完了', diagnose: () => snapshot(harness) },
			);
			if (completed === undefined) throw new Error('保存が完了しませんでした');

			// 既定は最高品質。初期化セグメントが先頭に来る
			expect(await readFile(completed.filename)).toEqual(
				Buffer.concat([
					await fixture('dash/init-hi.mp4'),
					await fixture('dash/hi-1.m4s'),
					await fixture('dash/hi-2.m4s'),
				]),
			);

			const tasks = await readStoredTasks(harness);
			expect(tasks?.at(-1)).toMatchObject({ tabId, status: 'completed', progress: 100 });
			expect(tasks?.at(-1)?.filename).toMatch(/\.mp4$/);
		} finally {
			await popup.close();
			await contentPage.close();
		}
	}, 90_000);

	it('選んだ画質のセグメントを取得する', async () => {
		// **位置ではなく実体で選ぶ。** Representation の指定は URL で渡している
		const contentPage = await harness.context.newPage();
		const popup = await harness.context.newPage();

		try {
			await contentPage.goto(`${harness.server.origin}/media-dash.html`);
			const tabId = await resolveTabId(harness, 'media-dash.html');

			await popup.goto(popupUrl(harness.extensionId));
			await contentPage.bringToFront();
			await popup.reload();

			await waitFor(
				() => readStoredMedia(harness, tabId),
				(media) => media?.[0]?.manifestResolved === true,
				{ timeoutMs: 20_000, label: '画質一覧の取得', diagnose: () => snapshot(harness) },
			);

			await expect.poll(() => popup.getByRole('radio').count(), { timeout: 20_000 }).toBe(2);

			// 2 つ目（360p）を選ぶ
			await popup.getByRole('radio').nth(1).click();

			const before = new Set((await searchDownloads(harness)).map((item) => item.id));
			await popup.getByRole('button', { name: '保存' }).click();

			const completed = await waitFor(
				async () =>
					(await searchDownloads(harness)).find(
						(item) => item.state === 'complete' && !before.has(item.id),
					),
				(item) => item !== undefined,
				{ timeoutMs: 30_000, label: '低画質の保存の完了', diagnose: () => snapshot(harness) },
			);
			if (completed === undefined) throw new Error('保存が完了しませんでした');

			expect(await readFile(completed.filename)).toEqual(
				Buffer.concat([
					await fixture('dash/init-lo.mp4'),
					await fixture('dash/lo-1.m4s'),
					await fixture('dash/lo-2.m4s'),
				]),
			);
		} finally {
			await popup.close();
			await contentPage.close();
		}
	}, 90_000);

	it('映像と音声が分かれていれば保存せずに理由を出す', async () => {
		const contentPage = await harness.context.newPage();
		const popup = await harness.context.newPage();

		try {
			await contentPage.goto(`${harness.server.origin}/media-dash-separate.html`);
			const tabId = await resolveTabId(harness, 'media-dash-separate.html');

			await popup.goto(popupUrl(harness.extensionId));
			await contentPage.bringToFront();
			await popup.reload();

			await waitFor(
				() => readStoredMedia(harness, tabId),
				(media) => media?.[0]?.manifestResolved === true,
				{ timeoutMs: 20_000, label: '分離 MPD の解析', diagnose: () => snapshot(harness) },
			);

			await expect
				.poll(() => popup.getByRole('button', { name: '保存' }).count(), { timeout: 20_000 })
				.toBe(1);

			await popup.getByRole('button', { name: '保存' }).click();

			// 「音の出ない動画」を黙って作らず、理由を出して失敗させる
			const failed = await waitFor(
				async () => (await readStoredTasks(harness))?.find((task) => task.tabId === tabId),
				(task) => task?.status === 'failed',
				{ timeoutMs: 30_000, label: '分離 DASH の失敗', diagnose: () => snapshot(harness) },
			);

			expect(failed?.error).toContain('結合');
		} finally {
			await popup.close();
			await contentPage.close();
		}
	}, 90_000);
});
