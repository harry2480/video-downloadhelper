import { formatBadgeText } from '../media/badge-text';

/** バッジの背景色。ポップアップの primary と揃える。 */
const BADGE_COLOR = '#1a73e8';

/**
 * ツールバーアイコンのバッジを更新する。
 *
 * 表示文言の決定は `media/badge-text.ts` の純粋関数が持つ。
 * ここは `chrome.action` を叩くだけに留める。
 */
export async function updateBadge(tabId: number, count: number): Promise<void> {
	try {
		await chrome.action.setBadgeText({ tabId, text: formatBadgeText(count) });
		await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
	} catch {
		// タブが既に閉じられている場合に失敗する。検出処理を止める理由にはならない
	}
}
