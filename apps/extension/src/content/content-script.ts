import { toDetectionCandidates } from '../media/media-element';
import type { ContentToBackground } from '../shared/messages';
import type { MediaElementCandidate } from '../shared/types';
import { observeMediaElements } from './dom-observer';
import { scanMediaElements } from './media-element-detector';

/**
 * Content Script のエントリ兼 Composition Root。
 *
 * **状態を持たない。** 検出のたびに Background へ送るだけにする。
 * Background 側が検出結果を所有し、タブ単位で集約する。
 *
 * このスクリプトはページと同じプロセスで動くため、ここから送る値は
 * Background 側で必ず検証される（要件定義 12 章）。
 */

/** 直前に送った内容。同じ内容を送り続けないためのもの。 */
let lastSentKey = '';

function candidateKey(candidates: MediaElementCandidate[]): string {
	return candidates.map((candidate) => candidate.sourceUrl).join('\n');
}

function collectCandidates(): MediaElementCandidate[] {
	const seen = new Set<string>();
	const candidates: MediaElementCandidate[] = [];

	for (const snapshot of scanMediaElements()) {
		for (const candidate of toDetectionCandidates(snapshot)) {
			if (seen.has(candidate.sourceUrl)) continue;
			seen.add(candidate.sourceUrl);
			candidates.push(candidate);
		}
	}

	return candidates;
}

function report(): void {
	const candidates = collectCandidates();
	if (candidates.length === 0) return;

	// メタデータ読み込みで情報が増えることがあるため、URL 集合が同じでも
	// 初回は必ず送る。2 回目以降は URL 集合が変わったときだけ送る
	const key = candidateKey(candidates);
	if (key === lastSentKey) return;
	lastSentKey = key;

	const message: ContentToBackground = { kind: 'media-elements-detected', candidates };

	// Service Worker が停止していると sendMessage は失敗する。
	// 次の走査で送り直されるため、ここでは握って進む
	void chrome.runtime.sendMessage(message).catch(() => {
		lastSentKey = '';
	});
}

report();
observeMediaElements(report);
