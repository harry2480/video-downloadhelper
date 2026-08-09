import { isBlockedUrl } from '../media/blocklist';
import type { DetectionInput } from '../media/detected-media.model';
import { parseContentMessage } from '../shared/messages';
import type { MediaElementCandidate } from '../shared/types';
import { fireAndForget } from './fire-and-forget';
import type { MediaRegistry } from './media-registry';

/**
 * 拡張機能内部メッセージの受け口。
 *
 * **送信元を必ず検証する。** 外部ページから任意の処理を呼び出せないように
 * するための最初の防壁（要件定義 12 章）。
 *
 * タブ ID とページ URL は `sender` から取る。Content Script が送ってきた値は
 * 信用しない。ページと同じプロセスで動く以上、改ざんされ得るため。
 */
export function registerMessageHandler(registry: MediaRegistry): void {
	chrome.runtime.onMessage.addListener((message, sender) => {
		if (sender.id !== chrome.runtime.id) return false;

		const tabId = sender.tab?.id;
		if (tabId === undefined || tabId < 0) return false;

		const pageUrl = sender.tab?.url ?? sender.url;
		if (!pageUrl) return false;

		// ブロックリスト対象サイトでは検出そのものを行わない（要件定義 2.1）
		if (isBlockedUrl(pageUrl)) return false;

		const parsed = parseContentMessage(message);
		if (!parsed) return false;

		// 世代はメッセージを受け取った時点で確定させる
		const generation = registry.currentGeneration(tabId);
		const pageTitle = sender.tab?.title;
		const detectedAt = Date.now();

		fireAndForget(
			registerCandidates(registry, parsed.candidates, {
				tabId,
				pageUrl,
				pageTitle,
				detectedAt,
				generation,
			}),
			'DOM 検出の取り込み',
		);

		// 応答しない。返り値の true は sendResponse を非同期で呼ぶ場合のみ
		return false;
	});
}

async function registerCandidates(
	registry: MediaRegistry,
	candidates: MediaElementCandidate[],
	context: {
		tabId: number;
		pageUrl: string;
		pageTitle: string | undefined;
		detectedAt: number;
		generation: number;
	},
): Promise<void> {
	for (const candidate of candidates) {
		const input: DetectionInput = {
			tabId: context.tabId,
			pageUrl: context.pageUrl,
			...(context.pageTitle !== undefined && { pageTitle: context.pageTitle }),
			sourceUrl: candidate.sourceUrl,
			detectedBy: candidate.detectedBy,
			detectedAt: context.detectedAt,
			...(candidate.title !== undefined && { title: candidate.title }),
			...(candidate.duration !== undefined && { duration: candidate.duration }),
			...(candidate.width !== undefined && { width: candidate.width }),
			...(candidate.height !== undefined && { height: candidate.height }),
		};

		// 直列に取り込む。並行にすると同一タブのキューが交錯して順序が読めなくなる
		await registry.register(input, context.generation);
	}
}
