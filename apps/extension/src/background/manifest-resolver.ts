import { analyzeHlsManifest, withEstimatedSizes } from '../media/hls/analysis';
import type { MediaFetcherPort } from '../shared/ports/media-fetcher.port';
import type { DetectedMedia } from '../shared/types';
import type { MediaRegistry } from './media-registry';

/**
 * 検出した HLS マニフェストを取得し直して解析する（要件定義 2.2 の再フェッチ方式）。
 *
 * 取得に失敗する URL（認証付き・有効期限付き）は珍しくない。
 * その場合は対応外として理由を記録し、検出自体は残す。
 */

/** 再フェッチ失敗時にユーザーへ出す理由。 */
const FETCH_FAILED = 'マニフェストを取得できませんでした（認証や有効期限が原因の可能性があります）';
const NOT_A_PLAYLIST = 'マニフェストとして解析できませんでした';

/** タブ ID と dedupeKey を混ぜない区切り。URL に現れない文字を使う。 */
const handledKey = (tabId: number, dedupeKey: string) => `${tabId}\u0000${dedupeKey}`;

export class ManifestResolver {
	/**
	 * 解析済み・解析中のキー。`タブID + dedupeKey` で持つ。
	 *
	 * ライブ HLS はマニフェストが繰り返し読み込まれるため、
	 * 抑止しないと同じ URL を何度も取得してしまう。
	 * タブごとに持つのは、ページ遷移で抑止を解除できるようにするため。
	 */
	private readonly handled = new Set<string>();

	constructor(
		private readonly fetcher: MediaFetcherPort,
		private readonly registry: MediaRegistry,
	) {}

	/** タブの検出結果が変わったときに呼ぶ。未解析の HLS があれば解析する。 */
	async resolvePending(tabId: number, media: DetectedMedia[], generation: number): Promise<void> {
		for (const item of media) {
			if (item.type !== 'hls') continue;
			if (item.manifestResolved === true) continue;

			const key = handledKey(tabId, item.dedupeKey);
			if (this.handled.has(key)) continue;

			this.handled.add(key);
			await this.resolve(tabId, item, generation);
		}
	}

	/**
	 * 当該タブの抑止を解除する。ページ遷移・タブ破棄時に呼ぶ。
	 * 解除しないと、同じページを開き直しても再解析されない。
	 */
	forgetTab(tabId: number): void {
		const prefix = handledKey(tabId, '');
		for (const key of this.handled) {
			if (key.startsWith(prefix)) this.handled.delete(key);
		}
	}

	private async resolve(tabId: number, media: DetectedMedia, generation: number): Promise<void> {
		const fetched = await this.fetcher.fetchText(media.sourceUrl);

		if (!fetched.ok) {
			await this.registry.enrich(tabId, media.dedupeKey, generation, {
				unsupportedReason: FETCH_FAILED,
			});
			return;
		}

		const analyzed = analyzeHlsManifest(fetched.text, media.sourceUrl);
		if (!analyzed.ok) {
			await this.registry.enrich(tabId, media.dedupeKey, generation, {
				unsupportedReason: NOT_A_PLAYLIST,
			});
			return;
		}

		const analysis = analyzed.value;
		await this.registry.enrich(tabId, media.dedupeKey, generation, {
			...analysis,
			...(analysis.variants !== undefined && {
				variants: withEstimatedSizes(analysis.variants, analysis.duration ?? media.duration),
			}),
		});
	}
}
