import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const studio = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(studio, '../..');
const renderer = join(studio, 'renderer');
const source = join(root, 'logo/icon.png');
const desktopNames = [
  '32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns',
  'Square30x30Logo.png', 'Square44x44Logo.png', 'Square71x71Logo.png',
  'Square89x89Logo.png', 'Square107x107Logo.png', 'Square142x142Logo.png',
  'Square150x150Logo.png', 'Square284x284Logo.png', 'Square310x310Logo.png', 'StoreLogo.png',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function canonicalizeIcns(bytes) {
  if (bytes.length < 8 || bytes.toString('ascii', 0, 4) !== 'icns' || bytes.readUInt32BE(4) !== bytes.length) {
    throw new Error('Invalid ICNS container');
  }
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error('Truncated ICNS chunk');
    const length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > bytes.length) throw new Error('Invalid ICNS chunk length');
    chunks.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  // Tauri emits ICNS entries in hash-map order; preserve payloads while stabilizing their order.
  chunks.sort(Buffer.compare);
  return Buffer.concat([bytes.subarray(0, 8), ...chunks]);
}

export async function generateDesktopIcons({ check = false } = {}) {
  const input = await readFile(source);
  if (input.length < 24 || !input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      input.readUInt32BE(16) !== input.readUInt32BE(20)) {
    throw new Error('logo/icon.png must be a square PNG');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'kcoder-generated-icons-'));
  try {
    await run(process.execPath, [join(renderer, 'node_modules/@tauri-apps/cli/tauri.js'),
      'icon', source, '--output', temporary], { cwd: renderer, timeout: 120000, maxBuffer: 1024 * 1024 });
    const outputs = new Map();
    for (const name of desktopNames) {
      const bytes = await readFile(join(temporary, name));
      outputs.set(`renderer/src-tauri/icons/${name}`, name.endsWith('.icns') ? canonicalizeIcns(bytes) : bytes);
    }
    outputs.set('renderer/src-tauri/icons/icon-dev.icns', outputs.get('renderer/src-tauri/icons/icon.icns'));
    outputs.set('renderer/src/assets/studio-icon.png', await readFile(join(temporary, '128x128@2x.png')));
    outputs.set('renderer/public/favicon.png', await readFile(join(temporary, '32x32.png')));
    const manifest = {
      source: 'logo/icon.png', sourceSha256: sha256(input),
      files: Object.fromEntries([...outputs].map(([path, bytes]) => [path, sha256(bytes)])),
    };
    outputs.set('desktop/icon-assets.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    const stale = [];
    for (const [relative, bytes] of outputs) {
      const target = join(studio, relative);
      if (check) {
        const existing = await readFile(target).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!existing?.equals(bytes)) stale.push(relative);
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
    }
    if (stale.length) throw new Error(`Application icons do not match logo/icon.png: ${stale.join(', ')}`);
    return { sourceSha256: manifest.sourceSha256, files: outputs.size, check };
  } finally {
    // Only the directory allocated by this invocation is removed.
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check')) throw new Error('Usage: node desktop/generate-icons.mjs [--check]');
  console.log(JSON.stringify(await generateDesktopIcons({ check: args.includes('--check') })));
}
