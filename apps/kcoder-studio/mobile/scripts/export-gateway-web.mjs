import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseToken = '/__kcoder_mobile_mount_v1__';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !args[1])) throw new Error('Usage: export-gateway-web.mjs [--output-dir directory]');
const dist = resolve(mobile, args[1] ?? 'dist');
// Use Expo's official baseUrl transform for Router, Metro chunks and static assets.
const child = spawn(process.execPath, [resolve(mobile, 'node_modules/expo/bin/cli'), 'export', '--platform', 'web', '--output-dir', dist], {
  cwd: mobile, stdio: 'inherit', env: { ...process.env, KCODER_STUDIO_MOBILE_WEB_DEPLOY: '1' },
});
const exit = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept({ code, signal })); });
if (exit.code !== 0) throw new Error(`Mobile Web export failed (${exit.signal ?? exit.code})`);
const files = [];
let total = 0;
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (path === 'kcoder-mobile-web.json') continue;
    if ((entry.name.startsWith('.') && path !== '_expo/.routes.json') || /[\\%?#\x00-\x1f\x7f]/.test(entry.name) || entry.isSymbolicLink()) throw new Error('Unsupported Mobile Web resource');
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) { await collect(absolute, `${path}/`); continue; }
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > 32 * 1024 * 1024 || /\.(?:map|gz|br)$/i.test(path)) throw new Error('Unsupported Mobile Web resource');
    const bytes = await readFile(absolute);
    const text = /\.(?:js|css|json|html|svg|txt|xml|webmanifest)$/i.test(path);
    const decoded = bytes.toString('utf8');
    const replacements = text ? decoded.split(baseToken).length - 1 : 0;
    if ((text && !Buffer.from(decoded).equals(bytes)) || (!text && bytes.includes(Buffer.from(baseToken))) || (path.endsWith('.html') && /\bintegrity\s*=/i.test(decoded))) throw new Error('Unsupported Mobile Web token encoding or integrity attribute');
    total += bytes.length;
    if (total > 256 * 1024 * 1024 || files.length >= 10000) throw new Error('Mobile Web build exceeds resource limit');
    files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), text, replacements });
  }
}
await collect(dist);
if (!files.some(file => file.path === 'index.html') || !files.some(file => file.replacements > 0)) throw new Error('Export did not apply Mobile Web baseUrl');
files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(resolve(dist, 'kcoder-mobile-web.json'), JSON.stringify({ version: 1, baseToken, files }, null, 2) + '\n');
console.log(`Gateway Mobile Web build ready (${files.length} resources)`);
