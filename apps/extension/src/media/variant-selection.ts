import type { MediaVariant } from '../shared/types';
import { toDedupeKey } from './url';

/**
 * 品質選択の解決（要件定義 4.4）。
 *
 * **variant の `id` は覚えてはいけない。** `id` は `hls/analysis.ts` が
 * 並べ替えたあとの位置で振る値（`v0`, `v1`, …）で、品質そのものには
 * 紐づいていない。再解析で本数や並びが変わると、同じ `id` が別の品質を
 * 指すか、どれにも一致しなくなる。
 *
 * 一致しなくなれば「ラジオがどれも選択されていない」「保存ボタンが出ない」、
 * 別の品質を指せば「意図しない画質で保存する」ことになる。後者は
 * 気づかないまま保存が終わるため、より悪い。
 *
 * そこで UI は品質そのものに紐づく識別子（`variantKey`）を覚え、
 * 描画のたびに現在の一覧から引き直す。
 */

/**
 * 並べ替えや `id` の振り直しに影響されない、品質の同一性。
 *
 * URL だけでは、同じ URL で codecs だけが違う variant を区別できない。
 * 推定サイズ（`estimatedSize`）は含めない。再生時間が後から分かって
 * 付与されるだけで、品質が変わったわけではないため。
 *
 * **URL は重複判定と同じ正規化を通す。** ライブ HLS では再読み込みのたびに
 * キャッシュバスターやシーケンス番号だけが異なる URL が流れてくる。素の URL を
 * 使うと、同じ画質なのに毎回「消えた」と判定して選択が既定へ戻ってしまう。
 */
export function variantKey(variant: MediaVariant): string {
	// 正規化できない URL は先に isFetchableUrl で落ちているはずだが、
	// 落ちなかった場合も素の URL で区別だけは付くようにする
	const normalized = toDedupeKey(variant.url);

	return JSON.stringify([
		normalized.ok ? normalized.value : variant.url,
		variant.bandwidth ?? null,
		variant.width ?? null,
		variant.height ?? null,
		variant.videoCodec ?? null,
		variant.audioCodec ?? null,
		// DASH では音声と映像の Representation が BaseURL を共有しうる。
		// 映像側に解像度が無く帯域も近いと、これが無いと衝突する
		variant.audioOnly ?? null,
	]);
}

/**
 * 覚えている選択から、現在の一覧の中の 1 件を決める。
 *
 * 選んだ品質が消えていれば既定（先頭＝最高品質）へ戻す。
 * **一覧に無い品質を返さないことがこの関数の役目。**
 */
export function resolveSelectedVariant(
	variants: readonly MediaVariant[],
	selectedKey: string | undefined,
): MediaVariant | undefined {
	if (selectedKey === undefined) return variants[0];
	return variants.find((variant) => variantKey(variant) === selectedKey) ?? variants[0];
}
