import type { DownloadTask } from '../types';

/**
 * ダウンロードタスクの永続化。
 *
 * **Service Worker はいつ停止してもよい**（要件定義 2.7）。進捗はここに置き、
 * 再起動後は storage から復元する。インスタンス変数に溜め込まない。
 *
 * `chrome.storage.session` を使う。タスクにはメディア URL 由来のファイル名が
 * 含まれるため、`local` に置くと閲覧の痕跡がディスクへ残る。
 *
 * このファイルは `shared/` にありながら `chrome.*` を直接呼ぶ例外層
 * （docs/リポジトリ層設計規約.md 参照）。`media/` `processor/` からは参照しない。
 */

const KEY = 'download-tasks';

export type DownloadTaskRepository = {
	findAll: () => Promise<DownloadTask[]>;
	saveAll: (tasks: readonly DownloadTask[]) => Promise<void>;
};

export function createDownloadTaskRepository(): DownloadTaskRepository {
	return {
		async findAll() {
			try {
				const stored = await chrome.storage.session.get(KEY);
				return (stored[KEY] as DownloadTask[] | undefined) ?? [];
			} catch (error) {
				throw new Error(`ダウンロード状態の取得に失敗しました: ${String(error)}`);
			}
		},

		async saveAll(tasks) {
			try {
				// 構造化クローン可能な plain object のみを保存する
				await chrome.storage.session.set({ [KEY]: [...tasks] });
			} catch (error) {
				throw new Error(`ダウンロード状態の保存に失敗しました: ${String(error)}`);
			}
		},
	};
}
