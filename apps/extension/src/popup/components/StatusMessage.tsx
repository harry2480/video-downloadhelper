import { BLOCKED_SITE_MESSAGE } from '../../media/blocklist';

/** 一覧に出すものがない状態の表示（要件定義 4.5）。 */
export type Status = 'detecting' | 'empty' | 'blocked';

const MESSAGES: Record<Status, string> = {
	detecting: 'このページの動画を検出しています…',
	empty: 'ダウンロード可能な動画が見つかりませんでした',
	blocked: BLOCKED_SITE_MESSAGE,
};

export function StatusMessage({ status }: { status: Status }) {
	return (
		// <output> は role="status" を持つ。状態の変化がスクリーンリーダーへ通知される
		<output className="block px-4 py-6 text-muted text-sm" aria-live="polite">
			{MESSAGES[status]}
		</output>
	);
}
