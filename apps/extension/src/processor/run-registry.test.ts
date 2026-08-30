import { describe, expect, it } from 'vitest';
import { createRunRegistry } from './run-registry';

/**
 * 同じタスク ID で走り直したときに、旧実行と新実行が混ざらないことが要点。
 * 混ざると別物の Blob を保存したり、中止が効かなくなったりする。
 */

const TASK = 'task-1';

describe('createRunRegistry', () => {
	it('始めた実行が現行になる', () => {
		const runs = createRunRegistry();
		const run = runs.start(TASK);

		expect(runs.isCurrent(TASK, run)).toBe(true);
	});

	it('走り直すと旧実行は現行でなくなる', () => {
		// 中止した旧実行が取得の待ちから戻ってきて結果を送ることがある
		const runs = createRunRegistry();
		const first = runs.start(TASK);
		const second = runs.start(TASK);

		expect(runs.isCurrent(TASK, first)).toBe(false);
		expect(runs.isCurrent(TASK, second)).toBe(true);
	});

	it('旧実行が終わっても新実行の記録を消さない', () => {
		const runs = createRunRegistry();
		const first = runs.start(TASK);
		const second = runs.start(TASK);

		runs.end(TASK, first);

		expect(runs.isCurrent(TASK, second)).toBe(true);
	});

	it('現行の実行を終えたら記録を落とす', () => {
		const runs = createRunRegistry();
		const run = runs.start(TASK);

		runs.end(TASK, run);

		expect(runs.isCurrent(TASK, run)).toBe(false);
		expect(runs.size()).toBe(0);
	});

	it('中止は現行の実行にだけ伝わる', () => {
		const runs = createRunRegistry();
		const first = runs.start(TASK);
		const second = runs.start(TASK);

		runs.cancel(TASK);

		expect(first.cancelled).toBe(false);
		expect(second.cancelled).toBe(true);
	});

	it('走っていないタスクの中止は覚えない', () => {
		// 覚えておくと、次に始めた実行を即座に止めてしまう
		const runs = createRunRegistry();
		runs.cancel('unknown');

		const run = runs.start('unknown');

		expect(run.cancelled).toBe(false);
		expect(runs.size()).toBe(1);
	});

	it('タスクごとに独立して数える', () => {
		const runs = createRunRegistry();
		const first = runs.start('a');
		runs.start('b');

		runs.cancel('b');

		expect(first.cancelled).toBe(false);
		expect(runs.size()).toBe(2);
	});
});
