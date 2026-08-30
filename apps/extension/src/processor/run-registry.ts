/**
 * 組み立ての実行世代（要件定義 2.6 の再試行・キャンセル）。
 *
 * **同じタスク ID で何度も走り得る。** 中止したあと再試行すると、旧実行が
 * 取得の待ちから戻ってきて結果を送ることがある。ID だけで突き合わせると、
 * それが新しい実行の結果として扱われ、別物の Blob を保存してしまう。
 * 「今の実行はどれか」をここで持ち、旧実行には自分から降りてもらう。
 *
 * 副作用を持たない。実際の取得と通知は実行コンテキスト層が行う。
 */

export type RunToken = {
	readonly id: number;
	/** 中止を要求されたか。取得ループが 1 件ごとに見る */
	cancelled: boolean;
};

type RunRegistry = {
	/** 新しい実行を始める。同じタスクの旧実行はこの時点で「今」ではなくなる */
	start: (taskId: string) => RunToken;
	/** その実行が今も現行か */
	isCurrent: (taskId: string, run: RunToken) => boolean;
	/** 現行なら記録を落とす。旧実行からの呼び出しでは何もしない */
	end: (taskId: string, run: RunToken) => void;
	/** 現行の実行へ中止を伝える。走っていなければ何もしない */
	cancel: (taskId: string) => void;
	/** 記録している実行の数。取り残しの検出に使う */
	size: () => number;
};

export function createRunRegistry(): RunRegistry {
	const runs = new Map<string, RunToken>();
	let lastId = 0;

	function isCurrent(taskId: string, run: RunToken): boolean {
		return runs.get(taskId)?.id === run.id;
	}

	return {
		start(taskId) {
			lastId += 1;
			const run: RunToken = { id: lastId, cancelled: false };
			runs.set(taskId, run);
			return run;
		},

		isCurrent,

		end(taskId, run) {
			if (isCurrent(taskId, run)) runs.delete(taskId);
		},

		cancel(taskId) {
			// 走っていないものを覚えておくと、次の再試行を即座に止めてしまう
			const run = runs.get(taskId);
			if (run !== undefined) run.cancelled = true;
		},

		size: () => runs.size,
	};
}
