/**
 * ツールバーアイコンのバッジ文言（要件定義 4.1）。
 *
 * - メディア未検出: 空文字（バッジ非表示）
 * - 1件以上検出: 件数を表示
 *
 * 表示の判断は純粋関数として切り出し、`chrome.action` の呼び出しとは分ける。
 */

/** バッジに表示できる上限。超過分は "99+" にまとめる。 */
const MAX_DISPLAY_COUNT = 99;

export function formatBadgeText(count: number): string {
	if (count <= 0) return '';
	if (count > MAX_DISPLAY_COUNT) return `${MAX_DISPLAY_COUNT}+`;
	return String(count);
}
