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
