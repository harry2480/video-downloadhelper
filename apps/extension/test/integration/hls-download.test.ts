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

/**
 * ページを開いて保存ボタンを押し、完了したファイルを返す。
 *
 * 保存の経路は形式によらず同じ。**解析の完了を待ってから押すこと。**
 * 保存ボタンの有無で待つと、解析前でも「出ていない」ことの確認にしかならず、
 * Master Playlist を渡してしまう。
 */
async function downloadFrom(pageName: string): Promise<{
	filename: string;
	tabId: number;
	close: () => Promise<void>;
}> {
	const contentPage = await harness.context.newPage();
	await contentPage.goto(`${harness.server.origin}/${pageName}`);
	const tabId = await resolveTabId(harness, pageName);

	const popup = await harness.context.newPage();
	await popup.goto(popupUrl(harness.extensionId));

	// ポップアップのタブがアクティブになるため、いったん元のタブへ戻す
	await contentPage.bringToFront();
	await popup.reload();

	await waitFor(
		() => readStoredMedia(harness, tabId),
		(media) => media?.[0]?.manifestResolved === true,
		{ timeoutMs: 20_000, label: `${pageName} の解析`, diagnose: () => snapshot(harness) },
	);

	await expect
		.poll(() => popup.getByRole('button', { name: '保存' }).count(), { timeout: 20_000 })
		.toBe(1);

	// **押す前の分を控えておく。** ブラウザのダウンロード履歴は
	// テストをまたいで残るため、先頭の完了を拾うと前のテストの
	// ファイルを検証してしまう
	const before = new Set((await searchDownloads(harness)).map((item) => item.id));

	await popup.getByRole('button', { name: '保存' }).click();

	const completed = await waitFor(
		async () =>
			(await searchDownloads(harness)).find(
				(item) => item.state === 'complete' && !before.has(item.id),
			),
		(item) => item !== undefined,
		{ timeoutMs: 30_000, label: `${pageName} の保存の完了`, diagnose: () => snapshot(harness) },
	);
	if (completed === undefined) throw new Error('保存が完了しませんでした');

	return {
		filename: completed.filename,
		tabId,
		close: async () => {
			await popup.close();
			await contentPage.close();
		},
	};
}

/** フィクスチャのファイルをそのまま読む。期待値の組み立てに使う。 */
const fixture = (relative: string) => readFile(path.join(FIXTURES_DIR, relative));

describe('HLS の保存', () => {
	it('セグメントを連結した 1 本のファイルが生成される', async () => {
		const saved = await downloadFrom('media-hls.html');

		try {
			// セグメントが順番どおりに連結されていること。順序が狂うと再生できない
			expect(await readFile(saved.filename)).toEqual(await expectedBytes());

			const tasks = await readStoredTasks(harness);
			expect(tasks?.[0]).toMatchObject({ tabId: saved.tabId, status: 'completed', progress: 100 });
			// 既定は最高品質。ファイル名にも解像度が入る
			expect(tasks?.[0]?.filename).toMatch(/1080p\.ts$/);
		} finally {
			await saved.close();
		}
	}, 90_000);

	it('fMP4 は初期化セグメントを先頭に置いて mp4 として保存する', async () => {
		// moov を含む初期化セグメントが先頭に無いと再生できない。
		// 拡張子も中身に合わせないと、プレイヤーが開けないファイルになる
		const saved = await downloadFrom('media-hls-fmp4.html');

		try {
			expect(await readFile(saved.filename)).toEqual(
				Buffer.concat([await fixture('hls/init.mp4'), await fixture('hls/seg0.m4s')]),
			);
			// **拡張機能が決める保存名はタスク側にある。** ブラウザが実際に
			// 置くパスはテスト環境の都合で UUID になるため、そこでは判定しない
			const tasks = await readStoredTasks(harness);
			expect(tasks?.at(-1)?.filename).toMatch(/\.mp4$/);
		} finally {
			await saved.close();
		}
	}, 90_000);

	it('バイトレンジ指定のセグメントを範囲どおりに取り出す', async () => {
		// 範囲を無視して全体を取ると、同じ内容を繰り返した壊れたファイルになる。
		// 連結した結果が元のファイルと一致することで、範囲と順序の両方を確かめる
		const saved = await downloadFrom('media-hls-ranged.html');

		try {
			expect(await readFile(saved.filename)).toEqual(await fixture('hls/ranged.ts'));
		} finally {
			await saved.close();
		}
	}, 90_000);

	it('要求と違う範囲が返ってきたら保存しない', async () => {
		// **206 は「要求した範囲」を保証しない。** 同じ長さの別範囲を返す
		// サーバーでは長さの検証も通り、中身がずれたまま連結される
		const contentPage = await harness.context.newPage();
		const popup = await harness.context.newPage();

		try {
			await contentPage.goto(`${harness.server.origin}/media-hls-ranged-shifted.html`);
			const tabId = await resolveTabId(harness, 'media-hls-ranged-shifted.html');

			await popup.goto(popupUrl(harness.extensionId));
			await contentPage.bringToFront();
			await popup.reload();

			await waitFor(
				() => readStoredMedia(harness, tabId),
				(media) => media?.[0]?.manifestResolved === true,
				{ timeoutMs: 20_000, label: '解析', diagnose: () => snapshot(harness) },
			);

			await expect
				.poll(() => popup.getByRole('button', { name: '保存' }).count(), { timeout: 20_000 })
				.toBe(1);

			await popup.getByRole('button', { name: '保存' }).click();

			const failed = await waitFor(
				async () => (await readStoredTasks(harness))?.find((task) => task.tabId === tabId),
				(task) => task?.status === 'failed',
				{ timeoutMs: 30_000, label: '範囲不一致の失敗', diagnose: () => snapshot(harness) },
			);

			expect(failed?.error).toContain('バイトレンジ');
		} finally {
			await popup.close();
			await contentPage.close();
		}
	}, 90_000);

	it('AES-128 で暗号化されたセグメントを復号して保存する', async () => {
		// 復号せずに保存すると、暗号文のまま「保存できた」ことになる
		const saved = await downloadFrom('media-hls-aes.html');

		try {
			expect(await readFile(saved.filename)).toEqual(
				Buffer.concat([await fixture('hls/aes-plain0.bin'), await fixture('hls/aes-plain1.bin')]),
			);
		} finally {
			await saved.close();
		}
	}, 90_000);
});
