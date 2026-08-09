import type { DetectedMedia } from '../types';

/**
 * タブ単位の検出結果の永続化。
 *
 * `chrome.storage.session` を使う。要件定義 2.7 の「検出結果はタブの
 * ライフサイクル中のみ保持」を満たしつつ、Service Worker が停止しても
 * 状態を復元できる。`local` に置くと閲覧履歴がディスクへ残り、
 * プライバシー方針に反する。
 *
 * このファイルは `shared/` にありながら `chrome.*` を直接呼ぶ唯一の例外層
 * （docs/アーキテクチャ.md 参照）。`media/` `processor/` からは参照しない。
 */

const KEY_PREFIX = 'detected-media:';

const tabKey = (tabId: number) => `${KEY_PREFIX}${tabId}`;

export type DetectedMediaRepository = {
	findByTab: (tabId: number) => Promise<DetectedMedia[]>;
	saveForTab: (tabId: number, media: readonly DetectedMedia[]) => Promise<void>;
	clearTab: (tabId: number) => Promise<void>;
};

export function createDetectedMediaRepository(): DetectedMediaRepository {
	return {
		async findByTab(tabId) {
			const key = tabKey(tabId);
			try {
				const stored = await chrome.storage.session.get(key);
				return (stored[key] as DetectedMedia[] | undefined) ?? [];
			} catch (error) {
				throw new Error(`検出結果の取得に失敗しました: ${String(error)}`);
			}
		},

		async saveForTab(tabId, media) {
			try {
				// 構造化クローン可能な plain object のみを保存する。
				// Service Worker 再起動後にそのまま復元できる形を保つ
				await chrome.storage.session.set({ [tabKey(tabId)]: [...media] });
			} catch (error) {
				throw new Error(`検出結果の保存に失敗しました: ${String(error)}`);
			}
		},

		async clearTab(tabId) {
			try {
				await chrome.storage.session.remove(tabKey(tabId));
			} catch (error) {
				throw new Error(`検出結果の破棄に失敗しました: ${String(error)}`);
			}
		},
	};
}
