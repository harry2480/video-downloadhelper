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

	/**
	 * 保存できない場合の理由（要件定義 2.1 の対応外通知）。
	 * fMP4 セグメントの HLS、マニフェストの再フェッチ失敗など。
	 */
	unsupportedReason?: string;

	/** マニフェストを解析済みか。未解析と「解析したが品質が 1 つ」を区別する */
	manifestResolved?: boolean;

	variants?: MediaVariant[];

	/** 検出時刻（epoch ms）。一覧の並び順に使う */
	detectedAt: number;
};

/**
 * ダウンロードの要求（要件定義 5.3）。
 *
 * **選択した品質はここに載せて渡す。** Popup 側で共有状態として保持しない
 * （Popup はいつ閉じられてもよい前提のため。要件定義 2.7）。
 */
export type DownloadRequest = {
	mediaId: string;

	/**
	 * 選択した映像品質。未指定なら既定（最高品質）を使う。
	 *
	 * **variant の `id` ではなく `variantKey()` の値を載せる。** `id` は解析時の
	 * 並び順で振る位置ベースの値で、再解析で別の品質を指しうる
	 * （`media/variant-selection.ts`）。
	 */
	variantKey?: string;

	/** 映像と音声が分離している場合の音声。Phase 2 の DASH で使う */
	audioVariantKey?: string;
};

/** ダウンロードの状態（要件定義 5.4）。DownloadTask からのみ参照する。 */
type DownloadStatus =
	/** 開始待ち */
	| 'queued'
	/** 取得中 */
	| 'downloading'
	/** 取得後の結合・変換中。Phase 2 の HLS / DASH で使う */
	| 'processing'
	| 'completed'
	| 'failed'
	| 'cancelled';

export type DownloadTask = {
	id: string;

	mediaId: string;

	/** 要求時に選ばれていた品質。`media/variant-selection.ts` の `variantKey()` の値 */
	variantKey?: string;
	audioVariantKey?: string;

	tabId: number;

	filename: string;

	status: DownloadStatus;

	/**
	 * 0〜100。映像・音声など複数ストリームを取得する場合も全体を通算した値にする。
	 * 総バイト数が分からない間は 0 のままにする。
	 */
	progress: number;

	downloadedBytes?: number;
	totalBytes?: number;

	/** 失敗の理由。ユーザーへ出せる日本語にしてから入れる */
	error?: string;

	/** ブラウザのダウンロード ID。取得を開始できた場合のみ持つ */
	browserDownloadId?: number;

	/**
	 * Offscreen Document が発行したオブジェクト URL（HLS の組み立て結果）。
	 *
	 * `chrome.downloads` が読み終わるまで生かしておく必要があるため、
	 * Service Worker の停止をまたいで解放できるようここに持つ。
	 */
	objectUrl?: string;

	/** 一覧の並び順に使う（epoch ms） */
	startedAt: number;
};
