// src/icons/icon.svg から manifest が参照する PNG を書き出す。
// PNG は生成物だが、Chrome Web Store 提出物に含める必要があるため
// リポジトリへコミットする。図案を変えたときはこのスクリプトを実行して
// 差分ごとコミットすること。
//
// ラスタライズには Playwright の Chromium を使う（E2E で既に導入済み）。
// 実際に拡張機能を表示するのと同じエンジンで縮小されるため、小サイズでの
// 見え方がブラウザ上の結果と一致する。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// 16: ツールバー / 32: Windows の一部 / 48: 拡張機能管理画面 / 128: Web Store・インストール時
const SIZES = [16, 32, 48, 128];

/**
 * SVG ルートの width/height。viewBox は据え置きで、ここだけ実寸へ差し替える。
 *
 * `<rect width="128" height="128">` にも当たらないよう `<svg` の属性列に限定する
 * （`[^>]` は開始タグを越えられない）。
 */
const ROOT_SIZE = /(<svg\b[^>]*?)width="128" height="128"/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = resolve(root, 'src/icons');
const svg = readFileSync(resolve(iconsDir, 'icon.svg'), 'utf8');

// 置換が当たらないと 128px のまま描画され、全サイズが同じ大きさの PNG になる。
// `wrote:` を出して exit 0 で終わるので、当たらなかった時点で落とす
if (!ROOT_SIZE.test(svg)) {
	throw new Error('icon.svg のルート要素に width="128" height="128" が見つかりません');
}

const browser = await chromium.launch();
try {
	// ラスタライズに JS は要らない。切っておかないと、差し替えられた icon.svg の
	// <script> や onload がこのマシン上で実行される（図案の変更に見えて通りやすい）
	const page = await browser.newPage({ javaScriptEnabled: false });

	// 途中で失敗したときに新旧の図案が混ざったまま残らないよう、
	// 全サイズを描き終えてから書き出す
	const rendered = [];

	for (const size of SIZES) {
		await page.setViewportSize({ width: size, height: size });
		await page.setContent(
			`<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg.replace(
				ROOT_SIZE,
				`$1width="${size}" height="${size}"`,
			)}`,
		);

		// screenshot はビューポートではなく要素の実寸で撮る。
		// 実寸がずれたまま撮ると、意図しない大きさの PNG が黙って出来上がる
		const box = await page.locator('svg').boundingBox();
		if (box?.width !== size || box?.height !== size) {
			throw new Error(`${size}px で描画されませんでした: ${JSON.stringify(box)}`);
		}

		rendered.push({ size, png: await page.locator('svg').screenshot({ omitBackground: true }) });
	}

	for (const { size, png } of rendered) {
		writeFileSync(resolve(iconsDir, `icon-${size}.png`), png);
		console.info(`wrote: src/icons/icon-${size}.png`);
	}
} finally {
	await browser.close();
}
