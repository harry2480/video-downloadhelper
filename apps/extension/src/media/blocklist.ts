/**
 * 機能を無効化するサイトの判定（要件定義 2.1 / 8 章）。
 *
 * 利用規約および Chrome Web Store ポリシー上ダウンロードが禁止される
 * サイトでは、検出そのものを行わない。
 *
 * **このリストはポリシー遵守のためのものであり、緩めてはならない。**
 * サイト固有の検出ロジックを実装しないという方針とも対になっている。
 */

const BLOCKED_DOMAINS = [
	'youtube.com',
	'youtu.be',
	'youtube-nocookie.com',
	'googlevideo.com',
] as const;

/**
 * ホスト名がブロック対象ドメインに一致するか。
 *
 * 完全一致に加えてサブドメイン（`music.youtube.com` 等）も対象にする。
 * 一方 `notyoutube.com` のような部分文字列一致は対象にしない。
 */
export function isBlockedHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, '');

	return BLOCKED_DOMAINS.some(
		(domain) => normalized === domain || normalized.endsWith(`.${domain}`),
	);
}

/**
 * URL がブロック対象サイトのものか。
 *
 * パースできない URL は「判定できない」ためブロックしない。
 * ここで true を返すと検出が止まるため、誤検知は機能欠損に直結する。
 */
export function isBlockedUrl(url: string): boolean {
	try {
		return isBlockedHostname(new URL(url).hostname);
	} catch {
		return false;
	}
}

/** UI へ表示する無効化理由。 */
export const BLOCKED_SITE_MESSAGE =
	'このサイトでは利用規約により拡張機能を無効にしています' as const;
