/**
 * マニフェストの再フェッチ。
 *
 * Chrome 拡張はネットワークレスポンスのボディを読めない
 * （`webRequest.filterResponseData` は Firefox 専用）ため、検出した URL を
 * 拡張機能側で取得し直して解析する（要件定義 2.2）。
 *
 * コアロジック層はこの interface だけを知る。実装は実行コンテキスト層が注入する。
 */

/** 取得できなかった理由。FetchTextResult からのみ参照する。 */
type FetchTextFailure =
	/** 通信に失敗した。オフライン、DNS、CORS 等 */
	| { reason: 'network' }
	/** 2xx 以外が返った。認証・有効期限切れの URL で起きる */
	| { reason: 'http-error'; status: number }
	/** マニフェストとしては大きすぎる。取り違えの可能性が高い */
	| { reason: 'too-large' };

export type FetchTextResult = { ok: true; text: string } | ({ ok: false } & FetchTextFailure);

export type MediaFetcherPort = {
	/** テキストとして取得する。マニフェストの取得にのみ使う */
	fetchText: (url: string) => Promise<FetchTextResult>;
};
