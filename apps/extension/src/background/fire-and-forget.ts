/**
 * リスナー境界で Promise を捨てる際に、失敗を握り潰さず記録する。
 *
 * chrome.* のイベントリスナーは同期的に値を返す必要があり、非同期処理を
 * `void` で捨てることになる。素の `void` だと Repository が投げた
 * storage エラーが unhandled rejection になり、失敗が見えないまま埋もれる。
 *
 * **ログにページ URL・タイトル・メディア URL を出さないこと**（要件定義 12 章）。
 * 何の処理が失敗したかだけを記録する。
 */
export function fireAndForget(promise: Promise<unknown>, what: string): void {
	void promise.catch(() => {
		console.warn(`[vdh] ${what}に失敗しました`);
	});
}
