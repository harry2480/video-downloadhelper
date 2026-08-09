import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { popupUrl } from '../e2e/fixtures';
import {
	type Harness,
	resolveTabId,
	snapshot,
	startHarness,
	stopHarness,
	waitFor,
} from './helpers';

/**
 * ポップアップの Integration テスト。
 *
 * Fake Port ではなく実際の chrome.runtime.connect を通し、
 * Background が所有する状態が届くことを確認する。
 */

let harness: Harness;

beforeAll(async () => {
	harness = await startHarness();
}, 60_000);

afterAll(async () => {
	await stopHarness(harness);
});

/** ポップアップを新しいタブとして開く。実際のポップアップと同じ URL を読む。 */
async function openPopup() {
	const page = await harness.context.newPage();
	await page.goto(popupUrl(harness.extensionId));
	return page;
}

describe('検出結果の表示', () => {
	it('アクティブなタブの検出結果を表示する', async () => {
		const contentPage = await harness.context.newPage();
		await contentPage.goto(`${harness.server.origin}/media-dom-only.html`);
		await resolveTabId(harness, 'media-dom-only.html');

		const popup = await openPopup();

		// ポップアップのタブがアクティブになるため、いったん元のタブへ戻す
		await contentPage.bringToFront();
		await popup.reload();

		await expect
			.poll(() => popup.getByRole('list', { name: '検出したメディア' }).count(), {
				timeout: 15_000,
			})
			.toBe(1);

		expect(await popup.getByText('DOM だけで見つかる動画').isVisible()).toBe(true);

		await popup.close();
		await contentPage.close();
	});

	it('メディアがないページでは未検出と表示する', async () => {
		const contentPage = await harness.context.newPage();
		await contentPage.goto(`${harness.server.origin}/basic.html`);

		const popup = await openPopup();
		await contentPage.bringToFront();
		await popup.reload();

		await expect
			.poll(() => popup.getByText(/見つかりませんでした/).isVisible(), { timeout: 15_000 })
			.toBe(true);

		await popup.close();
		await contentPage.close();
	});
});

describe('更新ボタン', () => {
	it('押しても状態が壊れない', async () => {
		const contentPage = await harness.context.newPage();
		await contentPage.goto(`${harness.server.origin}/media-dom-only.html`);
		const tabId = await resolveTabId(harness, 'media-dom-only.html');

		const popup = await openPopup();
		await contentPage.bringToFront();
		await popup.reload();

		await expect
			.poll(() => popup.getByRole('list', { name: '検出したメディア' }).count(), {
				timeout: 15_000,
			})
			.toBe(1);

		await popup.getByRole('button', { name: '再スキャン' }).click();

		// 再スキャン後も件数が変わらないこと（重複して増えない）
		await waitFor(
			async () => popup.getByRole('listitem').count(),
			(count) => count === 1,
			{ label: '再スキャン後の件数', diagnose: () => snapshot(harness) },
		);
		expect(tabId).toBeGreaterThanOrEqual(0);

		await popup.close();
		await contentPage.close();
	});
});
