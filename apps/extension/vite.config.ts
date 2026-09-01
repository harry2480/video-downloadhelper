import { crx } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import manifest from './src/manifest.json' with { type: 'json' };

export default defineConfig({
	plugins: [react(), tailwindcss(), crx({ manifest })],
	build: {
		/**
		 * **modulepreload を出力しない。**
		 *
		 * Vite は `<link rel="modulepreload" crossorigin>` を吐くが、拡張機能の
		 * ページでは `crossorigin` によって先読みが CORS モードで走り、本体の
		 * モジュール取得（同一オリジン）と食い違う。Chrome は先読み結果を捨てて
		 * 取り直すため、**毎回無駄な取得とコンソール警告**が出る。
		 *
		 *   A preload for '...' is found, but is not used because it is a
		 *   cross-world extension resource mismatch.
		 *
		 * 資産はローカルから読み込むので先読みの利点は無く、ポリフィルも
		 * Chrome には要らない（`modulepreload` は標準で対応している）。
		 */
		modulePreload: false,
		rollupOptions: {
			input: {
				// Offscreen Document は manifest ではなく chrome.offscreen.createDocument() で
				// 生成するため、CRXJS のエントリ自動検出が効かない。ここで明示的に登録する。
				offscreen: 'src/offscreen/index.html',
			},
		},
	},
	server: {
		// CRXJS の HMR クライアントが接続するポートを固定する
		port: 5173,
		strictPort: true,
		hmr: { port: 5173 },
	},
});
