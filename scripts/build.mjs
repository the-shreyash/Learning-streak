/** Packages extension/ into dist/learningstreak-v<version>.zip (for backup or Chrome Web Store). */
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });
const zip = path.join(dist, `learningstreak-v${version}.zip`);
if (existsSync(zip)) rmSync(zip);
execFileSync('zip', ['-r', '-q', '-X', zip, '.', '-x', '*.DS_Store', 'icons/icon.svg'], { cwd: path.join(root, 'extension') });
console.log(`Built ${path.relative(root, zip)}`);
