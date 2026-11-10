import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(studio, '../..');
const source = join(root, 'logo/icon.png');
const desktopNames = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns'];
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
  // Preserve payloads while stabilizing the container entry order.
  chunks.sort(Buffer.compare);
  return Buffer.concat([bytes.subarray(0, 8), ...chunks]);
}

export async function generateDesktopIcons({ check = false } = {}) {
  const input = await readFile(source);
  if (input.length < 24 || !input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      input.readUInt32BE(16) !== input.readUInt32BE(20)) {
    throw new Error('logo/icon.png must be a square PNG');
  }
  if (check) {
    const manifest = JSON.parse(await readFile(join(studio, 'desktop/icon-assets.json'), 'utf8'));
    if (manifest.sourceSha256 !== sha256(input)) throw new Error('Application icon source changed; regenerate the icon inventory');
    for (const [name, expected] of Object.entries(manifest.files)) {
      if (sha256(await readFile(join(studio, name))) !== expected) throw new Error(`Application icon inventory differs: ${name}`);
    }
    return { sourceSha256: manifest.sourceSha256, files: Object.keys(manifest.files).length + 1, check };
  }
  const temporary = await mkdtemp(join(tmpdir(), 'kcoder-generated-icons-'));
  try {
    // Reuse the pinned Electron Builder conversion tool instead of a second host CLI.
    const require = createRequire(import.meta.url);
    const builder = createRequire(require.resolve('electron-builder'));
    const { runIconsTool } = builder('app-builder-lib/out/toolsets/icons.js');
    await runIconsTool({ inputFile: source, outputFormat: 'set', outDir: temporary });
    for (const outputFormat of ['ico', 'icns'])
      await runIconsTool({ inputFile: source, outputFormat, outDir: temporary });
    const outputs = new Map();
    for (const name of desktopNames) {
      const generatedName = name === '128x128@2x.png' ? '256x256.png' : name;
      const bytes = name === 'icon.png' ? input : await readFile(join(temporary, generatedName));
      outputs.set(`desktop/icons/${name}`, name.endsWith('.icns') ? canonicalizeIcns(bytes) : bytes);
    }
    outputs.set('renderer/src/assets/studio-icon.png', await readFile(join(temporary, '256x256.png')));
    outputs.set('renderer/public/favicon.png', await readFile(join(temporary, '32x32.png')));
    // Mobile uses the original transparent artwork without another design or resize.
    outputs.set('mobile/assets/icon.png', input);
    outputs.set('mobile/assets/adaptive-foreground.png', input);
    const manifest = {
      source: 'logo/icon.png', sourceSha256: sha256(input),
      files: Object.fromEntries([...outputs].map(([path, bytes]) => [path, sha256(bytes)])),
    };
    outputs.set('desktop/icon-assets.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    for (const [relative, bytes] of outputs) {
      const target = join(studio, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
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
