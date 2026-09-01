// dependency-cruiser を実行し、**実際に解析できたか**まで確かめる。
//
// depcruise は解析できたファイルが 0 件でも「違反なし」で正常終了する。
// dependency-cruiser 17 + TypeScript 7 の組み合わせでは、対応するコンパイラを
// 見つけられず 0 modules のまま素通りしていた。境界の検査が丸ごと効かなく
// なっているのに `pnpm verify` は緑になる。
//
// 塞ぐのは 2 種類の空振り:
//
// 1. **ファイルが解析されない** — src 配下のソース数と、報告に現れた
//    src 配下のモジュール数を突き合わせる。件数を固定値で持たないので、
//    ファイルが増えても保守が要らない
// 2. **依存の辺だけが失われる** — `tsPreCompilationDeps` が効かなくなると、
//    ファイルは全部数えられるのに型のみ import が消え、
//    `import type { X } from '../background/...'` の違反だけが見えなくなる
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = '.dependency-cruiser.cjs';
const TARGET = 'src';

/**
 * 型のみ import しか持たないモジュールと、その依存先。
 *
 * ここが 0 件になったら `tsPreCompilationDeps` が効いていない。
 * 対象を動かしたときは、同じ性質（型のみ import を持つ）の組へ更新すること。
 */
const TYPE_ONLY_CANARY = {
	from: 'src/shared/ports/segment-fetcher.port.ts',
	to: 'src/shared/utils.ts',
};

const require = createRequire(import.meta.url);
const config = require(resolve(root, CONFIG));

/**
 * depcruise の実体。
 *
 * PATH に頼らず解決する。`pnpm depcruise` 経由なら node_modules/.bin が
 * PATH に入るが、このスクリプトを直接叩くと ENOENT で落ちる。
 * dependency-cruiser は `exports` で bin へのサブパス解決を塞いでいるため、
 * require.resolve ではなく .bin の位置を使う。
 */
const LOCAL_BIN = resolve(root, 'node_modules/.bin/depcruise');
const DEPCRUISE_BIN = existsSync(LOCAL_BIN) ? LOCAL_BIN : 'depcruise';
/** depcruise 側の除外条件を単一の情報源にする。ここで数え方をずらさない。 */
const EXCLUDED = new RegExp(config.options.exclude.path);

function countSources(dir) {
	let count = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			count += countSources(path);
			continue;
		}
		if (!/\.tsx?$/.test(entry.name)) continue;
		if (EXCLUDED.test(relative(root, path))) continue;
		count += 1;
	}
	return count;
}

function depcruise(extraArgs, options = {}) {
	return execFileSync(DEPCRUISE_BIN, [TARGET, '--config', CONFIG, ...extraArgs], {
		cwd: root,
		encoding: 'utf8',
		...options,
	});
}

function fail(lines) {
	console.error(lines.join('\n'));
	process.exit(1);
}

const expected = countSources(resolve(root, TARGET));

let report;
try {
	report = JSON.parse(depcruise(['--output-type', 'json']));
} catch (error) {
	// 違反があると depcruise は非ゼロで終わる。結果は stdout に載っている。
	// 空文字なら depcruise 自体が動いていない（設定不在など）。原因を隠さない
	if (!error.stdout) throw error;
	report = JSON.parse(error.stdout);
}

/** 外部モジュールや css を数に含めない。src のソースだけを突き合わせる。 */
const cruisedSources = report.modules.filter(
	(module) => module.source.startsWith(`${TARGET}/`) && /\.tsx?$/.test(module.source),
);

if (cruisedSources.length < expected) {
	fail([
		`依存関係の解析が空振りしています: ${cruisedSources.length} modules（${TARGET} のソースは ${expected} 件）。`,
		'dependency-cruiser が TypeScript を解析できていない可能性があります。',
		`\`npx depcruise ${TARGET} --config ${CONFIG}\` の警告を確認してください。`,
	]);
}

const canary = cruisedSources.find((module) => module.source === TYPE_ONLY_CANARY.from);
if (canary?.dependencies.some((dep) => dep.resolved === TYPE_ONLY_CANARY.to) !== true) {
	fail([
		`型のみ import が追えていません: ${TYPE_ONLY_CANARY.from} → ${TYPE_ONLY_CANARY.to}`,
		'tsPreCompilationDeps が効いていないと、ファイル数は変わらないまま',
		'型のみ import の違反だけが検出されなくなります。',
		'（対象ファイルを動かした場合は、このスクリプトの TYPE_ONLY_CANARY を更新してください）',
	]);
}

const { error: errors, warn } = report.summary;

// **warn も落とす。** 現行のルールはすべて error だが、境界の指摘を
// 「出るが落ちない」状態で放置しない（docs/品質チェック・テスト規約.md）
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
	`✔ no dependency violations found (${cruisedSources.length} modules, ${report.summary.totalDependenciesCruised} dependencies cruised)`,
);
