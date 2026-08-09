/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackgroundToPopup } from '../shared/messages';
import type { DetectedMedia } from '../shared/types';
import { App } from './App';

/**
 * Popup は状態を所有せず Background から受け取るだけなので、
 * Fake Port を注入すればブラウザなしで検証できる。
 */

afterEach(cleanup);

type FakePort = chrome.runtime.Port & {
	emit: (message: BackgroundToPopup) => void;
	sent: unknown[];
	disconnected: boolean;
};

function createFakePort(): FakePort {
	const listeners = new Set<(message: BackgroundToPopup) => void>();
	const sent: unknown[] = [];
	const port = {
		name: 'popup',
		sent,
		disconnected: false,
		onMessage: {
			addListener: (listener: (message: BackgroundToPopup) => void) => listeners.add(listener),
			removeListener: (listener: (message: BackgroundToPopup) => void) =>
				listeners.delete(listener),
		},
		onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
		postMessage: (message: unknown) => sent.push(message),
		disconnect: () => {
			port.disconnected = true;
		},
		emit: (message: BackgroundToPopup) => {
			for (const listener of listeners) listener(message);
		},
	} as unknown as FakePort;

	return port;
}

function media(overrides: Partial<DetectedMedia> = {}): DetectedMedia {
	return {
		id: `1:${overrides.sourceUrl ?? 'https://cdn.example.com/v.mp4'}`,
		tabId: 1,
		pageUrl: 'https://example.com/watch',
		sourceUrl: 'https://cdn.example.com/v.mp4',
		dedupeKey: 'https://cdn.example.com/v.mp4',
		type: 'direct',
		detectedBy: 'network',
		detectedAt: 1_000,
		...overrides,
	};
}

function renderApp() {
	const port = createFakePort();
	render(<App portFactory={() => port} />);
	return port;
}

describe('状態表示', () => {
	it('初期状態では検出中と表示する', () => {
		renderApp();

		expect(screen.getByRole('status')).toHaveTextContent('検出しています');
	});

	it('検出結果が空なら未検出と表示する', async () => {
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [], blocked: false });

		expect(await screen.findByText(/見つかりませんでした/)).toBeInTheDocument();
	});

	it('ブロックリスト対象サイトでは無効である旨を表示する', async () => {
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [], blocked: true });

		expect(await screen.findByText(/利用規約により/)).toBeInTheDocument();
	});

	it('状態の変化をスクリーンリーダーへ通知する', () => {
		renderApp();

		expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
	});
});

describe('メディア一覧', () => {
	it('検出したメディアを一覧表示する', async () => {
		const port = renderApp();
		port.emit({
			kind: 'media-list',
			media: [
				media({ title: 'サンプル動画', type: 'hls', height: 1080, bitrate: 5_200_000 }),
				media({ sourceUrl: 'https://cdn.example.com/b.mp4', title: '2 本目' }),
			],
			blocked: false,
		});

		const list = await screen.findByRole('list', { name: '検出したメディア' });
		expect(within(list).getAllByRole('listitem')).toHaveLength(2);
		expect(screen.getByText('サンプル動画')).toBeInTheDocument();
		expect(screen.getByText('1080p / 5.2 Mbps')).toBeInTheDocument();
		expect(screen.getByText('HLS')).toBeInTheDocument();
	});

	it('検出件数を表示する', async () => {
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media()], blocked: false });

		expect(await screen.findByText('1 件')).toBeInTheDocument();
	});

	it('DRM 保護されたメディアは理由を表示する', async () => {
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media({ drm: true })], blocked: false });

		expect(await screen.findByText(/DRM で保護されているため/)).toBeInTheDocument();
	});

	it('詳細を開閉できる', async () => {
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media()], blocked: false });

		const toggle = await screen.findByRole('button', { name: '詳細' });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');

		await user.click(toggle);

		expect(screen.getByText('https://cdn.example.com/v.mp4')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '詳細を隠す' })).toHaveAttribute(
			'aria-expanded',
			'true',
		);
	});

	it('詳細の URL は認証トークンをマスキングする', async () => {
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({
			kind: 'media-list',
			media: [media({ sourceUrl: 'https://cdn.example.com/v.mp4?token=secret' })],
			blocked: false,
		});

		await user.click(await screen.findByRole('button', { name: '詳細' }));

		expect(screen.getByText(/token=\*\*\*/)).toBeInTheDocument();
		expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
	});

	it('ページ由来の長いタイトルでも描画できる', async () => {
		const port = renderApp();
		port.emit({
			kind: 'media-list',
			media: [media({ title: 'あ'.repeat(500) })],
			blocked: false,
		});

		expect(await screen.findByRole('list', { name: '検出したメディア' })).toBeInTheDocument();
	});
});

describe('更新ボタン', () => {
	it('押すと再スキャンを要求する', async () => {
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [], blocked: false });

		await user.click(screen.getByRole('button', { name: '再スキャン' }));

		expect(port.sent).toEqual([{ kind: 'rescan' }]);
	});

	it('ブロックリスト対象サイトでは押せない', async () => {
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [], blocked: true });

		await waitFor(() => {
			expect(screen.getByRole('button', { name: '再スキャン' })).toBeDisabled();
		});
	});
});

describe('購読の後始末', () => {
	it('アンマウント時に Port を切断する', () => {
		const port = createFakePort();
		const { unmount } = render(<App portFactory={() => port} />);

		unmount();

		expect(port.disconnected).toBe(true);
	});
});

describe('キーボード操作', () => {
	it('Tab だけで更新ボタンと詳細ボタンへ到達できる', async () => {
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media()], blocked: false });

		await screen.findByRole('list', { name: '検出したメディア' });

		await user.tab();
		expect(screen.getByRole('button', { name: '再スキャン' })).toHaveFocus();

		await user.tab();
		expect(screen.getByRole('button', { name: '詳細' })).toHaveFocus();
	});
});
