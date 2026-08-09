import { type Result, err, ok } from '../shared/utils';

export type UrlError = { type: 'invalid-url'; input: string };

/**
 * 重複判定から除外するクエリパラメータ。
 *
 * ライブ HLS では Media Playlist が繰り返しリロードされ、そのたびに
 * シーケンス番号やキャッシュバスターだけが異なる URL が流れてくる。
 * これらを落とさないと同一ストリームが何十件も一覧に並ぶ。
 *
 * 比較用のキーを作るためだけに使う。実際の取得には元の URL を使うこと。
 */
const VOLATILE_QUERY_PARAMS = new Set([
	// LL-HLS のデルタ更新・部分セグメント要求
	'_hls_msn',
	'_hls_part',
	'_hls_skip',
	'_hls_report',
	// 一般的なキャッシュバスター
	'_',
	'cb',
	'cachebuster',
	'rnd',
	'random',
	'ts',
	'timestamp',
]);

/**
 * マニフェスト内の相対 URL を絶対 URL へ解決する。
 *
 * baseUrl はマニフェスト自身の URL。HLS / DASH のセグメント URL は
 * 相対で書かれていることが多く、これを誤ると全セグメントの取得に失敗する。
 */
export function resolveUrl(url: string, baseUrl: string): Result<string, UrlError> {
	try {
		return ok(new URL(url, baseUrl).toString());
	} catch {
		return err({ type: 'invalid-url', input: url });
	}
}

/**
 * 重複判定用の正規化キーを作る。
 *
 * - フラグメントを除去する
 * - 揮発的なクエリパラメータを除去する
 * - 残ったクエリパラメータをキー順にソートする（順序違いを同一とみなすため）
 *
 * scheme / host の小文字化とデフォルトポート（80 / 443）の除去は
 * URL API が自動で行うため、ここでは何もしない。
 *
 * 認証トークン等のクエリは **残す**。異なるトークンで同じ実体を指す場合も
 * あるが、落とすと本来別物のストリームまで同一視してしまうため。
 */
export function toDedupeKey(url: string): Result<string, UrlError> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return err({ type: 'invalid-url', input: url });
	}

	parsed.hash = '';

	const kept: [string, string][] = [];
	for (const [key, value] of parsed.searchParams) {
		if (VOLATILE_QUERY_PARAMS.has(key.toLowerCase())) continue;
		kept.push([key, value]);
	}
	kept.sort(([a, aValue], [b, bValue]) => a.localeCompare(b) || aValue.localeCompare(bValue));

	// searchParams を直接書き換えると反復中の変更になるため、作り直して差し替える
	const search = new URLSearchParams(kept);
	parsed.search = search.toString();

	return ok(parsed.toString());
}

/**
 * URL のパス部分の拡張子を小文字で返す（先頭のドットを含まない）。
 * クエリやフラグメントに引きずられないよう pathname のみを見る。
 */
export function getPathExtension(url: string): string | undefined {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return undefined;
	}

	const lastSegment = pathname.split('/').pop();
	if (!lastSegment) return undefined;

	const dotIndex = lastSegment.lastIndexOf('.');
	if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) return undefined;

	return lastSegment.slice(dotIndex + 1).toLowerCase();
}

/**
 * URL クエリに含まれる認証トークンらしき値をマスキングする。
 * ログ出力・UI 表示の前に必ず通すこと（要件定義 12 章）。
 */
const SENSITIVE_QUERY_PARAMS = [
	'token',
	'access_token',
	'auth',
	'authorization',
	'key',
	'signature',
	'sig',
	'password',
	'session',
	'sid',
];

export function maskSensitiveParams(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}

	let changed = false;
	for (const key of [...parsed.searchParams.keys()]) {
		const lower = key.toLowerCase();
		if (SENSITIVE_QUERY_PARAMS.some((s) => lower === s || lower.endsWith(`_${s}`))) {
			parsed.searchParams.set(key, '***');
			changed = true;
		}
	}

	return changed ? parsed.toString() : url;
}
