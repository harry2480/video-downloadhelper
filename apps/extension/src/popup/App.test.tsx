/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackgroundToPopup } from '../shared/messages';
import type { DetectedMedia, DownloadTask } from '../shared/types';
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

describe('品質選択', () => {
	const hlsMedia = media({
		type: 'hls',
		manifestResolved: true,
		variants: [
			{ id: 'v0', url: 'https://cdn.example.com/1080.m3u8', height: 1080, bandwidth: 5_200_000 },
			{ id: 'v1', url: 'https://cdn.example.com/720.m3u8', height: 720, bandwidth: 2_500_000 },
			{ id: 'v2', url: 'https://cdn.example.com/480.m3u8', height: 480, bandwidth: 1_000_000 },
		],
	});

	it('品質を radiogroup として提示する', async () => {
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [hlsMedia], blocked: false });

		const options = await screen.findAllByRole('radio');
		expect(options).toHaveLength(3);
		expect(screen.getByText(/1080p/)).toBeInTheDocument();
		expect(screen.getByText(/5\.2 Mbps/)).toBeInTheDocument();
	});

	it('既定で最高品質を選択する', async () => {
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [hlsMedia], blocked: false });

		const [highest] = await screen.findAllByRole('radio');
		expect(highest).toBeChecked();
	});

	it('キーボードだけで品質を切り替えられる', async () => {
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [hlsMedia], blocked: false });

		const options = await screen.findAllByRole('radio');
		options[0]?.focus();
		await user.keyboard('{ArrowDown}');

		expect(options[1]).toBeChecked();
	});

	it('再解析で品質が入れ替わっても、選んだ画質を指し続ける', async () => {
		// **variant の id は解析時の並び順で振る位置ベースの値。**
		// 再解析で本数が変わると同じ id が別の画質を指す。id を覚えていると
		// 「720p を選んだのに 1080p で保存する」が気づかないまま起きる
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [hlsMedia], blocked: false });

		const [, second] = await screen.findAllByRole('radio');
		await user.click(second as HTMLElement);

		// 1080p が消え、720p の id が v1 → v0 へずれる
		port.emit({
			kind: 'media-list',
			media: [
				{
					...hlsMedia,
					variants: [
						{
							id: 'v0',
							url: 'https://cdn.example.com/720.m3u8',
							height: 720,
							bandwidth: 2_500_000,
						},
						{
							id: 'v1',
							url: 'https://cdn.example.com/480.m3u8',
							height: 480,
							bandwidth: 1_000_000,
						},
					],
				},
			],
			blocked: false,
		});

		// 再描画を待つ。findAllByRole は先に見つかった古い一覧を返してしまう
		await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
		const after = screen.getAllByRole('radio');
		// 選択は 720p のまま。位置ではなく画質そのものに追随する
		expect(after[0]).toBeChecked();

		await user.click(screen.getByRole('button', { name: '保存' }));
		expect(port.sent).toContainEqual({
			kind: 'start-download',
			request: { mediaId: hlsMedia.id, variantId: 'v0' },
		});
	});

	it('選んだ画質が消えたら最高品質へ戻し、保存できる状態を保つ', async () => {
		// どれにも一致しない id を保持し続けると、ラジオが未選択になり
		// DownloadControl が variant を解決できず保存ボタンごと消える
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [hlsMedia], blocked: false });

		const [, , third] = await screen.findAllByRole('radio');
		await user.click(third as HTMLElement);

		port.emit({
			kind: 'media-list',
			media: [
				{
					...hlsMedia,
					variants: [
						{
							id: 'v0',
							url: 'https://cdn.example.com/1080.m3u8',
							height: 1080,
							bandwidth: 5_200_000,
						},
						{
							id: 'v1',
							url: 'https://cdn.example.com/720.m3u8',
							height: 720,
							bandwidth: 2_500_000,
						},
					],
				},
			],
			blocked: false,
		});

		// 再描画を待つ。findAllByRole は先に見つかった古い一覧を返してしまう
		await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
		const after = screen.getAllByRole('radio');
		expect(after[0]).toBeChecked();
		expect(after.some((option) => (option as HTMLInputElement).checked)).toBe(true);

		await user.click(screen.getByRole('button', { name: '保存' }));
		expect(port.sent).toContainEqual({
			kind: 'start-download',
			request: { mediaId: hlsMedia.id, variantId: 'v0' },
		});
	});

	it('推定サイズが後から付いても選択を保つ', async () => {
		// 再生時間が分かった時点で estimatedSize が加わる。ここで選択が
		// 既定へ戻ると、解析の進行に合わせて選び直しを強いられる
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [hlsMedia], blocked: false });

		const [, second] = await screen.findAllByRole('radio');
		await user.click(second as HTMLElement);

		act(() => {
			port.emit({
				kind: 'media-list',
				media: [
					{
						...hlsMedia,
						variants: hlsMedia.variants?.map((variant) => ({
							...variant,
							estimatedSize: 100_000_000,
						})),
					},
				],
				blocked: false,
			});
		});

		expect(screen.getAllByRole('radio')[1]).toBeChecked();
	});

	it('品質が 1 つしかなければ選択 UI を出さない', async () => {
		const port = renderApp();
		port.emit({
			kind: 'media-list',
			media: [{ ...hlsMedia, variants: [hlsMedia.variants?.[0] as never] }],
			blocked: false,
		});

		await screen.findByRole('list', { name: '検出したメディア' });
		expect(screen.queryByRole('radio')).not.toBeInTheDocument();
	});
});

describe('マニフェスト解析の状態', () => {
	it('解析前の HLS には確認中と表示する', async () => {
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media({ type: 'hls' })], blocked: false });

		expect(await screen.findByText(/画質を確認しています/)).toBeInTheDocument();
	});

	it('解析済みなら確認中と表示しない', async () => {
		const port = renderApp();
		port.emit({
			kind: 'media-list',
			media: [media({ type: 'hls', manifestResolved: true })],
			blocked: false,
		});

		await screen.findByRole('list', { name: '検出したメディア' });
		expect(screen.queryByText(/画質を確認しています/)).not.toBeInTheDocument();
	});

	it('取得に失敗したら確認中ではなく理由を出す', async () => {
		// 再試行のため解析済みにはしない。確認中と理由を同時に出さない
		const port = renderApp();
		port.emit({
			kind: 'media-list',
			media: [media({ type: 'hls', unsupportedReason: 'マニフェストを取得できませんでした' })],
			blocked: false,
		});

		expect(await screen.findByText(/マニフェストを取得できませんでした/)).toBeInTheDocument();
		expect(screen.queryByText(/画質を確認しています/)).not.toBeInTheDocument();
	});

	it('対応外の理由を表示する', async () => {
		const port = renderApp();
		port.emit({
			kind: 'media-list',
			media: [
				media({
					type: 'hls',
					manifestResolved: true,
					unsupportedReason: 'fMP4 セグメントの HLS には未対応です',
				}),
			],
			blocked: false,
		});

		expect(await screen.findByText(/fMP4 セグメント/)).toBeInTheDocument();
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
	it('Tab だけで更新ボタンと保存ボタンと詳細ボタンへ到達できる', async () => {
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media()], blocked: false });

		await screen.findByRole('list', { name: '検出したメディア' });

		await user.tab();
		expect(screen.getByRole('button', { name: '再スキャン' })).toHaveFocus();

		await user.tab();
		expect(screen.getByRole('button', { name: '保存' })).toHaveFocus();

		await user.tab();
		expect(screen.getByRole('button', { name: '詳細' })).toHaveFocus();
	});
});

describe('ダウンロード', () => {
	function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
		return {
			id: 'task-1',
			mediaId: '1:https://cdn.example.com/v.mp4',
			tabId: 1,
			filename: 'video.mp4',
			status: 'downloading',
			progress: 0,
			startedAt: 1_000,
			...overrides,
		};
	}

	it('保存ボタンを押すとダウンロードを要求する', async () => {
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media()], blocked: false });

		await user.click(await screen.findByRole('button', { name: '保存' }));

		expect(port.sent).toContainEqual({
			kind: 'start-download',
			request: { mediaId: '1:https://cdn.example.com/v.mp4' },
		});
	});

	it('取得中は進捗と中止ボタンを出す', async () => {
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media()], blocked: false });
		port.emit({
			kind: 'download-updated',
			tasks: [task({ progress: 42, downloadedBytes: 420, totalBytes: 1_000 })],
		});

		expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
		expect(screen.getByRole('button', { name: '中止' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
	});

	it('中止ボタンを押すと中止を要求する', async () => {
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media()], blocked: false });
		port.emit({ kind: 'download-updated', tasks: [task()] });

		await user.click(await screen.findByRole('button', { name: '中止' }));

		expect(port.sent).toContainEqual({ kind: 'cancel-download', taskId: 'task-1' });
	});

	it('失敗したら理由と再試行ボタンを出す', async () => {
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media()], blocked: false });
		port.emit({
			kind: 'download-updated',
			tasks: [task({ status: 'failed', error: '通信に失敗しました' })],
		});

		expect(await screen.findByText('通信に失敗しました')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: '再試行' }));
		expect(port.sent).toContainEqual({ kind: 'retry-download', taskId: 'task-1' });
	});

	it('完了したら保存済みと表示し、もう一度保存できる', async () => {
		const user = userEvent.setup();
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media()], blocked: false });
		port.emit({ kind: 'download-updated', tasks: [task({ status: 'completed', progress: 100 })] });

		expect(await screen.findByText('保存しました')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'もう一度保存' }));
		expect(port.sent).toContainEqual({ kind: 'retry-download', taskId: 'task-1' });
	});

	it('HLS にも保存ボタンを出す', async () => {
		// セグメントの取得・結合は Offscreen Document が担う
		const port = renderApp();
		port.emit({
			kind: 'media-list',
			media: [media({ type: 'hls', manifestResolved: true })],
			blocked: false,
		});

		expect(await screen.findByRole('button', { name: '保存' })).toBeInTheDocument();
	});

	it('DASH には保存ボタンを出さない', async () => {
		// 押せるのに保存できない状態を作らない
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media({ type: 'dash' })], blocked: false });

		expect(await screen.findByText(/準備中/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
	});

	it('セグメントの取得中は進捗を出す', async () => {
		const port = renderApp();
		port.emit({
			kind: 'media-list',
			media: [media({ type: 'hls', manifestResolved: true })],
			blocked: false,
		});
		port.emit({
			kind: 'download-updated',
			tasks: [task({ status: 'processing', progress: 50, downloadedBytes: 500 })],
		});

		expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
		expect(screen.getByRole('button', { name: '中止' })).toBeInTheDocument();
	});

	it('選択中の品質が保存できないなら保存ボタンを出さない', async () => {
		// 品質ごとに URL が違う。メディア全体だけを見ると、押した瞬間に失敗する
		const port = renderApp();
		port.emit({
			kind: 'media-list',
			media: [
				media({
					variants: [
						{ id: 'v0', url: 'file:///etc/passwd', height: 1080 },
						{ id: 'v1', url: 'https://cdn.example.com/720.mp4', height: 720 },
					],
				}),
			],
			blocked: false,
		});

		await screen.findByRole('list', { name: '検出したメディア' });
		expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
	});

	it('DRM 保護されたメディアには操作を出さない', async () => {
		const port = renderApp();
		port.emit({ kind: 'media-list', media: [media({ drm: true })], blocked: false });

		await screen.findByRole('list', { name: '検出したメディア' });
		expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
	});

	it('対応外の理由があるメディアには操作を出さない', async () => {
		const port = renderApp();
		port.emit({
			kind: 'media-list',
			media: [media({ unsupportedReason: 'マニフェストを取得できませんでした' })],
			blocked: false,
		});

		await screen.findByRole('list', { name: '検出したメディア' });
		expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
	});
});
