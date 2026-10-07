/**
 * Static checks: syntax of every JS file, manifest sanity + permission review,
 * referenced files exist, no network calls / remote code, debug tools off.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
let failures = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const fail = (msg) => { failures += 1; console.log(`  ✘ ${msg}`); };

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(ext);
const jsFiles = files.filter((f) => f.endsWith('.js'));

console.log('\nSyntax');
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { fail(`${path.relative(root, f)}: ${e.stderr}`); }
}
ok(`${jsFiles.length} JavaScript files parse`);

console.log('\nManifest');
const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
manifest.manifest_version === 3 ? ok('Manifest V3') : fail('manifest_version must be 3');
const ALLOWED_PERMS = new Set(['storage', 'alarms', 'notifications', 'idle', 'scripting']);
const extraPerms = (manifest.permissions || []).filter((p) => !ALLOWED_PERMS.has(p));
extraPerms.length ? fail(`unexpected permissions: ${extraPerms}`) : ok(`permissions limited to: ${manifest.permissions.join(', ')}`);
const hosts = manifest.host_permissions || [];
// V2.1: YouTube is opt-in (Learning Library), and only www.youtube.com is needed.
const HOST_RE = /^https:\/\/(\*\.udemy\.com|www\.youtube\.com)\/\*$/;
hosts.every((h) => HOST_RE.test(h)) ? ok(`host access limited to: ${hosts.join(', ')}`) : fail(`host permissions too broad: ${hosts}`);
JSON.stringify(manifest).includes('<all_urls>') ? fail('<all_urls> present') : ok('no <all_urls>');
(manifest.content_scripts || []).every((cs) => cs.matches.every((m) => HOST_RE.test(m))) ? ok('content scripts match Udemy / www.youtube.com only') : fail('content script matches other URLs');
manifest.web_accessible_resources ? fail('web_accessible_resources should not be needed') : ok('no web-accessible resources exposed to pages');
manifest.externally_connectable ? fail('externally_connectable should be absent') : ok('not externally connectable');

const referenced = [
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  manifest.background?.service_worker,
  ...(manifest.content_scripts || []).flatMap((c) => c.js || []),
].filter(Boolean);
const missing = referenced.filter((r) => !existsSync(path.join(ext, r)));
missing.length ? fail(`missing files: ${missing}`) : ok(`${referenced.length} manifest-referenced files exist`);

console.log('\nPages & imports');
for (const html of files.filter((f) => f.endsWith('.html'))) {
  const src = readFileSync(html, 'utf8');
  const refs = [...src.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  const bad = refs.filter((r) => !existsSync(path.resolve(path.dirname(html), r)));
  bad.length ? fail(`${path.relative(root, html)} → missing ${bad}`) : ok(`${path.relative(ext, html)}: ${refs.length} local refs resolve`);
}
for (const js of jsFiles) {
  const src = readFileSync(js, 'utf8');
  for (const m of src.matchAll(/^\s*import\s+(?:[^'"]+from\s+)?['"](\.[^'"]+)['"]/gm)) {
    if (!existsSync(path.resolve(path.dirname(js), m[1]))) fail(`${path.relative(root, js)} imports missing ${m[1]}`);
  }
}
ok('all relative ES module imports resolve');

console.log('\nPrivacy & safety');
const NET = /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|navigator\.sendBeacon|EventSource|importScripts\s*\(\s*['"]http/;
const netHits = jsFiles.filter((f) => NET.test(readFileSync(f, 'utf8')));
netHits.length ? fail(`network APIs used in: ${netHits.map((f) => path.relative(root, f))}`) : ok('no network requests in extension code');
const URL_RE = /https?:\/\/[^\s'"`)<>]+/g;
const urls = new Set(files.filter((f) => /\.(js|html|css)$/.test(f)).flatMap((f) => readFileSync(f, 'utf8').match(URL_RE) || []));
const foreign = [...urls].filter((u) => !/^https:\/\/(\*\.|www\.)?udemy\.com/.test(u) && !/^https:\/\/www\.youtube\.com\//.test(u) && !u.startsWith('http://www.w3.org/'));
foreign.length ? fail(`external URLs referenced: ${foreign}`) : ok('no external URLs (only udemy.com / www.youtube.com / SVG namespace)');
const contentSrc = jsFiles.filter((f) => f.includes(`${path.sep}content${path.sep}`)).map((f) => readFileSync(f, 'utf8')).join('\n');
/\.(play|pause)\s*\(\s*\)|currentTime\s*=|playbackRate\s*=|dispatchEvent\(new (Mouse|Keyboard|Pointer)Event|\.click\(\)/.test(contentSrc)
  ? fail('content script appears to control playback or simulate input')
  : ok('content scripts only observe (no playback control, no synthetic input)');
/eval\(|new Function\(/.test(jsFiles.map((f) => readFileSync(f, 'utf8')).join('\n')) ? fail('eval/new Function used') : ok('no eval / dynamic code');
/DEBUG_TOOLS\s*=\s*false/.test(readFileSync(path.join(ext, 'src/config/config.js'), 'utf8')) ? ok('DEBUG_TOOLS is off') : fail('DEBUG_TOOLS must be false for release');

console.log(failures ? `\n${failures} problem(s) found\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
