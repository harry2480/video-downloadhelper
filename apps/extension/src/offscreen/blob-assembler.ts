/**
 * セグメントの連結と Blob 化（要件定義 2.6 の保存方式）。
 *
 * **Service Worker では `URL.createObjectURL` が使えない。**
 * Manifest V3 の Service Worker に `URL.createObjectURL` は存在しないため、
 * Blob 生成とオブジェクト URL の発行は Offscreen Document でしか行えない。
 *
 * 発行したオブジェクト URL は、`chrome.downloads` が読み終わるまで
 * 生かしておく必要がある。解放は保存の完了・失敗を見てから行う。
 */

/** TS セグメントを連結したファイルの MIME タイプ。 */
const MPEG_TS = 'video/mp2t';

type AssembledBlob = {
	objectUrl: string;
	bytes: number;
};

/**
 * 取得済みのセグメントを 1 本の Blob にしてオブジェクト URL を返す。
 *
 * 連結は Blob のコンストラクタへ渡すだけにする。自前で 1 つの
 * `Uint8Array` へコピーすると、同じ内容をもう一度メモリに載せることになる。
 */
export function assembleBlob(
	parts: readonly Uint8Array<ArrayBuffer>[],
	type: string = MPEG_TS,
): AssembledBlob {
	const blob = new Blob([...parts], { type });

	return { objectUrl: URL.createObjectURL(blob), bytes: blob.size };
}

/** オブジェクト URL を解放する。保存が終わった後に必ず呼ぶ。 */
export function releaseObjectUrl(objectUrl: string): void {
	URL.revokeObjectURL(objectUrl);
}
