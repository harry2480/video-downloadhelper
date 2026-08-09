import type { MediaElementSnapshot } from '../media/media-element';

/**
 * DOM から `<video>` / `<audio>` の状態を読み取る。
 *
 * 判定ロジックは持たず、読み取りに徹する。候補の組み立ては
 * `media/media-element.ts` の純粋関数が担う。
 */

function readLabel(element: HTMLMediaElement): string | null {
	const candidates = [
		element.getAttribute('title'),
		element.getAttribute('aria-label'),
		// <video> 直下の <track label> ではなく、囲む figure のキャプションを拾う
		element.closest('figure')?.querySelector('figcaption')?.textContent,
	];

	// `??` で繋がないこと。getAttribute は未設定なら null だが
	// `title=""` では空文字を返すため、後続の候補へ進まなくなる
	return (
		candidates.find((candidate): candidate is string => (candidate?.trim().length ?? 0) > 0) ?? null
	);
}

function readSourceUrls(element: HTMLMediaElement): string[] {
	return [...element.querySelectorAll('source')]
		.map((source) => source.src)
		.filter((src) => src.length > 0);
}

function snapshotMediaElement(element: HTMLMediaElement): MediaElementSnapshot {
	const isVideo = element instanceof HTMLVideoElement;

	return {
		kind: isVideo ? 'video' : 'audio',
		// getAttribute ではなく src プロパティを使う。相対 URL が解決済みになる
		src: element.src.length > 0 ? element.src : null,
		currentSrc: element.currentSrc.length > 0 ? element.currentSrc : null,
		sourceUrls: readSourceUrls(element),
		// メタデータ読み込み前は NaN になる
		duration: Number.isFinite(element.duration) ? element.duration : null,
		width: isVideo && element.videoWidth > 0 ? element.videoWidth : null,
		height: isVideo && element.videoHeight > 0 ? element.videoHeight : null,
		label: readLabel(element),
	};
}

/** ドキュメント内のメディア要素を走査する。 */
export function scanMediaElements(root: ParentNode = document): MediaElementSnapshot[] {
	return [...root.querySelectorAll('video, audio')]
		.filter((element): element is HTMLMediaElement => element instanceof HTMLMediaElement)
		.map(snapshotMediaElement);
}
