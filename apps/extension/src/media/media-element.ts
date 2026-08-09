import type { MediaElementCandidate } from '../shared/types';

/**
 * `<video>` / `<audio>` 要素から検出候補を組み立てる（要件定義 2.2）。
 *
 * DOM に触れず、要素から読み取った値のスナップショットを受け取る。
 * 実際の DOM 走査は Content Script 側が担う。
 */

export type MediaElementSnapshot = {
	kind: 'video' | 'audio';
	/** src 属性。未設定なら null */
	src: string | null;
	/** ブラウザが実際に選択した URL（絶対 URL に解決済み） */
	currentSrc: string | null;
	/** 子の `<source src>` を記述順に並べたもの */
	sourceUrls: string[];
	/** 秒。読み込み前は NaN になるため null で渡してよい */
	duration: number | null;
	/** 映像の実サイズ（videoWidth / videoHeight）。CSS 上の表示サイズではない */
	width: number | null;
	height: number | null;
	/** title / aria-label 等から得たラベル */
	label: string | null;
};

/**
 * 拡張機能から再取得できないスキーム。
 *
 * MSE を使うサイトの `<video src>` は `blob:` になる。元ストリームは
 * ネットワーク検出が拾うため、ここでは候補にしない（要件定義 2.2）。
 */
const NON_FETCHABLE_SCHEME = /^(blob|data|filesystem|mediastream):/i;

/** ページ由来の文字列をそのまま持ち回らないよう、長さを制限する。 */
const MAX_LABEL_LENGTH = 200;

function normalizeLabel(label: string | null): string | undefined {
	if (!label) return undefined;
	const trimmed = label.trim().slice(0, MAX_LABEL_LENGTH);
	return trimmed.length > 0 ? trimmed : undefined;
}

function positiveNumber(value: number | null): number | undefined {
	if (value === null) return undefined;
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

export function toDetectionCandidates(snapshot: MediaElementSnapshot): MediaElementCandidate[] {
	const detectedBy = snapshot.kind === 'video' ? 'video-element' : 'audio-element';
	const label = normalizeLabel(snapshot.label);

	const candidates: MediaElementCandidate[] = [];
	const seen = new Set<string>();

	for (const url of [snapshot.currentSrc, snapshot.src, ...snapshot.sourceUrls]) {
		if (!url) continue;
		if (NON_FETCHABLE_SCHEME.test(url)) continue;
		if (seen.has(url)) continue;
		seen.add(url);

		// 再生時間・解像度はブラウザが選択した URL のものでしかない。
		// 選ばれなかった <source> へ付けると誤った情報になる
		const isSelected = url === snapshot.currentSrc;
		const duration = isSelected ? positiveNumber(snapshot.duration) : undefined;
		const width = isSelected ? positiveNumber(snapshot.width) : undefined;
		const height = isSelected ? positiveNumber(snapshot.height) : undefined;

		candidates.push({
			sourceUrl: url,
			detectedBy,
			...(duration !== undefined && { duration }),
			...(width !== undefined && { width }),
			...(height !== undefined && { height }),
			...(label !== undefined && { title: label }),
		});
	}

	return candidates;
}
