import { describe, expect, it } from 'vitest';
import type { DetectionInput } from '../media/detected-media.model';
import type { DetectedMediaRepository } from '../shared/storage/detected-media.repository';
import type { DetectedMedia } from '../shared/types';
import { MediaRegistry } from './media-registry';

/**
 * MediaRegistry は chrome.* に触れず Repository を注入で受け取るため、
 * Node.js 上でそのまま検証できる。
 *
 * 世代の突き合わせは実ブラウザでは競合のタイミングに依存して再現しづらい。
 * ここで決定的に検証しておく。
 */

const TAB_ID = 1;

function fakeRepository(options: { findDelayMs?: number } = {}) {
	const store = new Map<number, DetectedMedia[]>();

	const repository: DetectedMediaRepository = {
		async findByTab(tabId) {
			if (options.findDelayMs) {
				await new Promise((resolve) => setTimeout(resolve, options.findDelayMs));
			}
			return store.get(tabId) ?? [];
		},
		async saveForTab(tabId, media) {
			store.set(tabId, [...media]);
		},
		async clearTab(tabId) {
			store.delete(tabId);
		},
	};

	return { repository, store };
}

function input(sourceUrl: string, overrides: Partial<DetectionInput> = {}): DetectionInput {
	return {
		tabId: TAB_ID,
		pageUrl: 'https://example.com/watch',
		sourceUrl,
		detectedBy: 'network',
		detectedAt: 1_000,
		...overrides,
	};
}

function createRegistry(options: { findDelayMs?: number } = {}) {
	const { repository, store } = fakeRepository(options);
	const changes: { tabId: number; count: number }[] = [];
	const registry = new MediaRegistry(repository, (tabId, media) => {
		changes.push({ tabId, count: media.length });
	});
	return { registry, store, changes };
}

describe('register', () => {
	it('現在の世代なら保存する', async () => {
		const { registry, store } = createRegistry();

		await registry.register(
			input('https://cdn.example.com/a.mp4'),
			registry.currentGeneration(TAB_ID),
		);

		expect(store.get(TAB_ID)).toHaveLength(1);
	});

	it('生成に失敗する候補を黙って捨てる', async () => {
		const { registry, store } = createRegistry();

		await registry.register(input('blob:https://example.com/8f3a'), 0);

		expect(store.get(TAB_ID)).toBeUndefined();
	});

	it('並行して届いた検出を取りこぼさない', async () => {
		// read-modify-write を直列化していないと後勝ちで消える
		const { registry, store } = createRegistry({ findDelayMs: 5 });

		await Promise.all(
			['a', 'b', 'c', 'd', 'e'].map((name) =>
				registry.register(input(`https://cdn.example.com/${name}.mp4`), 0),
			),
		);

		expect(store.get(TAB_ID)).toHaveLength(5);
	});
});

describe('タブあたりの上限', () => {
	async function registerMany(registry: MediaRegistry, count: number, offset = 0): Promise<void> {
		for (let index = 0; index < count; index++) {
			await registry.register(input(`https://cdn.example.com/${offset + index}.mp4`), 0);
		}
	}

	it('上限を超えた新規追加を取り込まない', async () => {
		// DOM 検出は内容がページ側の操作で決まるため、上限がないと際限なく増える
		const { registry, store } = createRegistry();

		await registerMany(registry, 210);

		expect(store.get(TAB_ID)).toHaveLength(200);
	});

	it('上限に達していても既存項目の統合は通す', async () => {
		const { registry, store } = createRegistry();

		await registerMany(registry, 200);
		// 既に登録済みの URL を、より情報の多い検出方式で送り直す
		await registry.register(input('https://cdn.example.com/0.mp4', { detectedBy: 'manifest' }), 0);

		expect(store.get(TAB_ID)).toHaveLength(200);
		expect(store.get(TAB_ID)?.[0]?.detectedBy).toBe('manifest');
	});

	it('クリア後は再び取り込める', async () => {
		const { registry, store } = createRegistry();

		await registerMany(registry, 200);
		await registry.clearTab(TAB_ID);
		await registry.register(
			input('https://cdn.example.com/after.mp4'),
			registry.currentGeneration(TAB_ID),
		);

		expect(store.get(TAB_ID)).toHaveLength(1);
	});
});

describe('ページ遷移との競合', () => {
	it('遷移前のイベント由来の登録を遷移後に保存しない', async () => {
		const { registry, store } = createRegistry();

		// 旧ページのレスポンスを受け取った時点の世代
		const generation = registry.currentGeneration(TAB_ID);

		// 通常遷移が起き、検出結果がクリアされる
		await registry.clearTab(TAB_ID);

		// タブ情報の取得を待っていた旧ページの登録が、遅れて到着する
		await registry.register(input('https://cdn.example.com/old.mp4'), generation);

		expect(store.get(TAB_ID)).toBeUndefined();
	});

	it('クリアがキュー待ちの間に届いた旧世代の登録も破棄する', async () => {
		// findByTab を遅らせて、clearTab の完了前に register が並ぶ状況を作る
		const { registry, store } = createRegistry({ findDelayMs: 20 });

		const generation = registry.currentGeneration(TAB_ID);

		// clearTab は世代を同期的に進めてからキューへ入る
		const clearing = registry.clearTab(TAB_ID);
		const registering = registry.register(input('https://cdn.example.com/old.mp4'), generation);

		await Promise.all([clearing, registering]);

		expect(store.get(TAB_ID)).toBeUndefined();
	});

	it('遷移後の世代で登録すれば保存する', async () => {
		const { registry, store } = createRegistry();

		await registry.clearTab(TAB_ID);
		await registry.register(
			input('https://cdn.example.com/new.mp4'),
			registry.currentGeneration(TAB_ID),
		);

		expect(store.get(TAB_ID)).toHaveLength(1);
		expect(store.get(TAB_ID)?.[0]?.sourceUrl).toContain('new.mp4');
	});

	it('遷移前に保存済みの検出結果はクリアで消える', async () => {
		const { registry, store } = createRegistry();

		await registry.register(input('https://cdn.example.com/old.mp4'), 0);
		expect(store.get(TAB_ID)).toHaveLength(1);

		await registry.clearTab(TAB_ID);

		expect(store.get(TAB_ID)).toBeUndefined();
	});

	it('タブごとに世代を独立して進める', async () => {
		const { registry, store } = createRegistry();

		await registry.clearTab(TAB_ID);

		// 別タブは影響を受けない
		await registry.register(input('https://cdn.example.com/other.mp4', { tabId: 2 }), 0);

		expect(store.get(2)).toHaveLength(1);
	});
});

describe('通知', () => {
	it('保存とクリアのたびに件数を通知する', async () => {
		const { registry, changes } = createRegistry();

		await registry.register(input('https://cdn.example.com/a.mp4'), 0);
		await registry.clearTab(TAB_ID);

		expect(changes).toEqual([
			{ tabId: TAB_ID, count: 1 },
			{ tabId: TAB_ID, count: 0 },
		]);
	});

	it('破棄した登録では通知しない', async () => {
		const { registry, changes } = createRegistry();

		await registry.clearTab(TAB_ID);
		changes.length = 0;

		await registry.register(input('https://cdn.example.com/old.mp4'), 0);

		expect(changes).toEqual([]);
	});
});
