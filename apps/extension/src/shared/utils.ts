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
	const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;

	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (host === '::1' || host === '0.0.0.0') return true;
	if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
		return true;
	}
	// IPv6 のユニークローカル / リンクローカル
	if (/^(fc|fd|fe8|fe9|fea|feb)/.test(host)) return true;

	const parts = host.split('.');
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;

	const [a, b] = parts.map(Number) as [number, number, number, number];
	if (a === 10 || a === 127 || a === 0) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	// リンクローカル（クラウドのメタデータ 169.254.169.254 を含む）
	if (a === 169 && b === 254) return true;

	return false;
}
