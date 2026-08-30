/**
 * ドメインの失敗を表す型。
 * コアロジック層(shared/media/processor)は例外を投げず、この型で失敗を返す。
 * 実行コンテキスト層がユーザー向けメッセージへ変換する責務を持つ。
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
	return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
	return result.ok;
}

/**
 * 拡張機能から取得してよい URL か。
 *
 * `http(s)` 以外（`file:` `data:` `blob:` `filesystem:` 等）は取得も保存もしない。
 * ページ由来の文字列が URL として流れてくる箇所すべてで、この関門を通すこと。
 */
export function isHttpUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/**
 * プライベートネットワーク宛の URL か。
 *
 * 公開ページが用意したマニフェストからイントラネットや localhost を
 * 叩かせる踏み台にしないための判定に使う。
 */
export function isPrivateHostUrl(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return true;
	}

	// IPv6 は URL.hostname が角括弧付きで返る
	if (hostname.startsWith('[')) return isPrivateIpv6(hostname.slice(1, -1));

	// **数値表記の IPv4 を自前で解く必要はない。** `new URL` が
	// 2130706433 / 0x7f000001 / 017700000001 / 127.1 をすべて
	// 127.0.0.1 の形へ正規化する
	const host = stripTrailingDots(hostname);

	return isLocalName(host) || isPrivateIpv4Host(host);
}

const MAPPED_IPV4_PREFIX = '::ffff:';

/** 4 組に分かれた IPv4 アドレスの表記。 */
const IPV4_HOST = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * 末尾のドットを落とす。
 *
 * `http://localhost./a` の hostname は `localhost.` になる。DNS 上は同じ名前で
 * 同じ宛先へ届くため、比較の前に正規化しないと素通りする。
 */
function stripTrailingDots(hostname: string): string {
	return hostname.replace(/\.+$/, '');
}

function isLocalName(host: string): boolean {
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	return host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa');
}

function isPrivateIpv6(host: string): boolean {
	if (host === '::1' || host === '::') return true;
	// ユニークローカル（fc00::/7）とリンクローカル（fe80::/10）
	if (/^(fc|fd|fe[89ab])/.test(host)) return true;
	if (!host.startsWith(MAPPED_IPV4_PREFIX)) return false;

	// IPv4 射影アドレス。URL の解析を通ると ::ffff:7f00:1 の形になる
	const embedded = host.slice(MAPPED_IPV4_PREFIX.length);
	const separator = embedded.indexOf(':');
	// 2 組に分かれていない形は読み取れない。安全側へ倒す
	if (separator < 0) return true;

	const high = Number.parseInt(embedded.slice(0, separator), 16);

	return isPrivateIpv4(high >> 8, high & 0xff);
}

function isPrivateIpv4Host(host: string): boolean {
	if (!IPV4_HOST.test(host)) return false;

	// 先頭 2 組だけで判定できる。添字アクセスを避けて切り出す
	const firstDot = host.indexOf('.');
	const secondDot = host.indexOf('.', firstDot + 1);

	return isPrivateIpv4(
		Number(host.slice(0, firstDot)),
		Number(host.slice(firstDot + 1, secondDot)),
	);
}

function isPrivateIpv4(a: number, b: number): boolean {
	if (a === 10 || a === 127 || a === 0) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	// リンクローカル（クラウドのメタデータ 169.254.169.254 を含む）
	return a === 169 && b === 254;
}
