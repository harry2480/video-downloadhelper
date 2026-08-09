/**
 * DOM の変化を監視して再走査のきっかけを作る（要件定義 2.2 の動的ページ対応）。
 *
 * **不要な走査を避ける。** `<all_urls>` に注入されるため、通常のブラウジングへ
 * 影響を与えないことが要件（2.7 低CPU使用率）。関係のない DOM 変更では
 * 走査しない。
 */

/** 変更が落ち着くまで待つ時間。SPA の描画は連続して起きるためまとめる。 */
const DEBOUNCE_MS = 300;

const MEDIA_TAGS = new Set(['VIDEO', 'AUDIO', 'SOURCE']);

function containsMediaElement(node: Node): boolean {
	if (!(node instanceof Element)) return false;
	if (MEDIA_TAGS.has(node.tagName)) return true;
	return node.querySelector('video, audio') !== null;
}

function isRelevantMutation(mutation: MutationRecord): boolean {
	if (mutation.type === 'attributes') return true;
	return [...mutation.addedNodes].some(containsMediaElement);
}

/**
 * メディア要素の追加・src 変更・メタデータ読み込みを監視する。
 *
 * @returns 監視を止める関数
 */
export function observeMediaElements(onChange: () => void): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const schedule = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(onChange, DEBOUNCE_MS);
	};

	const observer = new MutationObserver((mutations) => {
		if (mutations.some(isRelevantMutation)) schedule();
	});

	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		// src が書き換わるケースだけを見る。全属性を見ると通常操作で頻繁に発火する
		attributeFilter: ['src'],
	});

	// 再生時間・解像度はメタデータ読み込み後にしか取れない。
	// media 要素のイベントは bubble しないため capture で拾う
	const onLoadedMetadata = () => schedule();
	document.addEventListener('loadedmetadata', onLoadedMetadata, true);

	return () => {
		if (timer !== undefined) clearTimeout(timer);
		observer.disconnect();
		document.removeEventListener('loadedmetadata', onLoadedMetadata, true);
	};
}
