import { crx } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import manifest from './src/manifest.json' with { type: 'json' };

export default defineConfig({
	plugins: [react(), tailwindcss(), crx({ manifest })],
	build: {
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
