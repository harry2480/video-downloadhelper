// dist/ を Chrome Web Store 提出用の zip に固める。
// バージョンは manifest.json を単一の情報源とする。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

if (!existsSync(dist)) {
	console.error('dist/ がありません。先に `pnpm build` を実行してください。');
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
const zipPath = resolve(root, `video-downloadhelper-${manifest.version}.zip`);

rmSync(zipPath, { force: true });
execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: dist });

console.info(`created: ${zipPath}`);
