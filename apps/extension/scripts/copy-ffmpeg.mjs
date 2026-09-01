// ffmpeg.wasm のコアを public/ へ配置する。
//
// **リモートコードを実行しない**（要件定義 12 章 / Chrome Web Store ポリシー）。
// ffmpeg.wasm の既定は CDN から core を取りに行くため、依存関係に固定した
// ファイルを拡張機能へ同梱し、拡張機能内の URL から読み込む。
//
// wasm は 32MB あるためリポジトリへはコミットしない。`pnpm build` の前に
// このスクリプトが node_modules から複製する（バージョンは package.json が
// 単一の情報源）。
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'public/ffmpeg');

// ESM 版を使う。Worker から動的 import で読み込むため
const FILES = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

const require = createRequire(import.meta.url);
// package.json はサブパス解決を塞いでいる。エントリの位置から辿る
// エントリは UMD を指す。Worker からは ESM を動的 import するため差し替える
const coreDir = dirname(require.resolve('@ffmpeg/core')).replace(/umd$/, 'esm');

mkdirSync(destination, { recursive: true });

for (const file of FILES) {
	const from = join(coreDir, file);
	if (!existsSync(from)) throw new Error(`@ffmpeg/core に ${file} がありません: ${from}`);

	const to = join(destination, file);
	// 同じ内容なら触らない。32MB の複製を毎回行わない
	if (existsSync(to) && statSync(to).size === statSync(from).size) continue;

	copyFileSync(from, to);
	console.info(`copied: public/ffmpeg/${file}`);
}
