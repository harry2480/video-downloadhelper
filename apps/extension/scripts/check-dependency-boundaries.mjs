// dependency-cruiser を実行し、**実際に解析できたか**まで確かめる。
//
// depcruise は解析できたファイルが 0 件でも「違反なし」で正常終了する。
// dependency-cruiser 17 + TypeScript 7 の組み合わせでは、対応する
// コンパイラを見つけられず 0 modules のまま素通りしていた。境界の検査が
// 丸ごと効かなくなっているのに `pnpm verify` は緑になる。
//
// src 配下のソース数（テストを除く）を下限として突き合わせる。数を固定値で
// 持たないので、ファイルが増えても保守が要らない。
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = '.dependency-cruiser.cjs';
const TARGET = 'src';

/** depcruise の exclude と同じ条件で数える（テストは対象外）。 */
function countSources(dir) {
	let count = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			count += countSources(path);
			continue;
		}
		if (!/\.tsx?$/.test(entry.name)) continue;
		if (/\.test\.tsx?$/.test(entry.name)) continue;
		count += 1;
	}
	return count;
}

function depcruise(extraArgs, options = {}) {
	return execFileSync('depcruise', [TARGET, '--config', CONFIG, ...extraArgs], {
		cwd: root,
		encoding: 'utf8',
		...options,
	});
}

const expected = countSources(resolve(root, TARGET));

let report;
try {
	report = JSON.parse(depcruise(['--output-type', 'json']));
} catch (error) {
	// 違反があると depcruise は非ゼロで終わる。stdout に結果は載っている
	if (error.stdout === undefined) throw error;
	report = JSON.parse(error.stdout);
}

const { totalCruised, totalDependenciesCruised, error: errors, warn } = report.summary;

if (totalCruised < expected) {
	console.error(
		[
			`依存関係の解析が空振りしています: ${totalCruised} modules（src のソースは ${expected} 件）。`,
			'dependency-cruiser が TypeScript を解析できていない可能性があります。',
			'`npx depcruise src --config .dependency-cruiser.cjs` の警告を確認してください。',
		].join('\n'),
	);
	process.exit(1);
}

if (errors > 0 || warn > 0) {
	// 人が読める形で出し直す。違反があれば非ゼロで終わるので、それ自体は握る
	try {
		depcruise([], { stdio: 'inherit' });
	} catch {
		// 出力は inherit 済み。ここで欲しいのは表示だけ
	}
	process.exit(1);
}

console.info(
	`✔ no dependency violations found (${totalCruised} modules, ${totalDependenciesCruised} dependencies cruised)`,
);
