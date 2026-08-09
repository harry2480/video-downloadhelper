import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `pnpm build` の出力先。拡張機能はここからロードする。 */
export const DIST_PATH = path.resolve(here, '../../dist');

export type ExtensionContext = {
	context: BrowserContext;
	/** 起動ごとに変わるため、Service Worker の URL から動的に取得する */
	extensionId: string;
	close: () => Promise<void>;
};

/**
 * 拡張機能をロードした Chrome を起動する。
 *
 * 拡張機能は launchPersistentContext でしか読み込めない。
 * さらに Playwright の既定である Chrome Headless Shell は拡張機能を
 * サポートしないため、`channel: 'chromium'` でフルビルドを明示する。
 * これを省くと Service Worker が永久に現れずタイムアウトする。
 */
export async function launchExtension(): Promise<ExtensionContext> {
	const userDataDir = await mkdtemp(path.join(tmpdir(), 'vdh-e2e-'));

	const context = await chromium.launchPersistentContext(userDataDir, {
		channel: 'chromium',
		args: [
			`--disable-extensions-except=${DIST_PATH}`,
			`--load-extension=${DIST_PATH}`,
			'--no-first-run',
			'--no-default-browser-check',
		],
	});

	const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
	// chrome-extension://<id>/service-worker-loader.js
	const extensionId = new URL(worker.url()).host;

	return {
		context,
		extensionId,
		close: async () => {
			await context.close();
			await rm(userDataDir, { recursive: true, force: true });
		},
	};
}

/** ポップアップの URL。manifest の action.default_popup と一致させること。 */
export function popupUrl(extensionId: string): string {
	return `chrome-extension://${extensionId}/src/popup/index.html`;
}
