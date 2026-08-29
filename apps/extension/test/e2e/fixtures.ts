import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
	/** `chrome.downloads` の保存先。テストごとに使い捨てる */
	downloadDir: string;
	close: () => Promise<void>;
};

/**
 * プロファイルの設定へ保存先を書き込む。
 *
 * `chrome.downloads` の保存先はコマンドライン引数では変えられないため、
 * 初回起動時に読まれる Preferences を用意しておく。実ユーザーの
 * ダウンロードフォルダを汚さないために必要。
 */
async function seedDownloadPreferences(userDataDir: string, downloadDir: string): Promise<void> {
	const profileDir = path.join(userDataDir, 'Default');
	await mkdir(profileDir, { recursive: true });

	const preferences = {
		download: { default_directory: downloadDir, prompt_for_download: false },
		savefile: { default_directory: downloadDir },
		profile: { exit_type: 'Normal', exited_cleanly: true },
	};

	await writeFile(path.join(profileDir, 'Preferences'), JSON.stringify(preferences), 'utf8');
}

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
	const downloadDir = await mkdtemp(path.join(tmpdir(), 'vdh-downloads-'));
	await seedDownloadPreferences(userDataDir, downloadDir);

	const context = await chromium.launchPersistentContext(userDataDir, {
		downloadsPath: downloadDir,
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
		downloadDir,
		close: async () => {
			await context.close();
			await rm(userDataDir, { recursive: true, force: true });
			await rm(downloadDir, { recursive: true, force: true });
		},
	};
}

/** ポップアップの URL。manifest の action.default_popup と一致させること。 */
export function popupUrl(extensionId: string): string {
	return `chrome-extension://${extensionId}/src/popup/index.html`;
}
