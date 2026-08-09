/**
 * 拡張機能全体で共有するドメイン型。
 *
 * このファイルは **型宣言のみ** を持つ。生成・検証・変換のロジックは
 * `media/` 配下のモデル（例: detected-media.model.ts）に置く。
 * shared は最内層であり `media/` へ依存できないため、この分離が必要になる。
 *
 * ここで宣言する値は chrome.storage / メッセージング経由で構造化クローンされる。
 * クラスインスタンス・Map・Set・関数を持たせないこと。
 */

export type MediaType = 'direct' | 'hls' | 'dash' | 'audio' | 'unknown';

export type DetectionSource = 'network' | 'video-element' | 'audio-element' | 'manifest';

/** HLS / DASH で選択可能な品質のひとつ。 */
export type MediaVariant = {
	id: string;
	url: string;

	width?: number;
	height?: number;

	/** bit/s */
	bandwidth?: number;
	fps?: number;

	videoCodec?: string;
	audioCodec?: string;

	/** 音声のみの Representation / Variant か */
	audioOnly?: boolean;

	/** bytes */
	estimatedSize?: number;
};

/**
 * Content Script が `<video>` / `<audio>` から拾った検出候補。
 *
 * タブ ID とページ URL は送信元（`sender`）から Background 側で補うため
 * ここには含めない。Content Script から送られた値は信用しない。
 */
export type MediaElementCandidate = {
	sourceUrl: string;
	detectedBy: 'video-element' | 'audio-element';
	duration?: number;
	width?: number;
	height?: number;
	title?: string;
};

export type DetectedMedia = {
	id: string;

	tabId: number;

	pageUrl: string;
	pageTitle?: string;

	/** 検出した実際の URL。fetch に使うため正規化しない */
	sourceUrl: string;

	/**
	 * 重複判定に使う正規化済み URL。
	 * 揮発的なクエリ（キャッシュバスター、LL-HLS のシーケンス番号等）を除去してある。
	 */
	dedupeKey: string;

	type: MediaType;

	mimeType?: string;
	title?: string;

	/** 秒 */
	duration?: number;

	width?: number;
	height?: number;
	/** bit/s */
	bitrate?: number;

	videoCodec?: string;
	audioCodec?: string;

	/** bytes */
	estimatedSize?: number;

	detectedBy: DetectionSource;

	/** DRM 保護の候補と判定されたか。true の場合ダウンロード操作を提供しない */
	drm?: boolean;

	variants?: MediaVariant[];

	/** 検出時刻（epoch ms）。一覧の並び順に使う */
	detectedAt: number;
};
