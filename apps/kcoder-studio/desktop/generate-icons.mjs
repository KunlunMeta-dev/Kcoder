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
const linuxIconPath = 'desktop/icons/icon.png';
const inventoryPaths = [...desktopNames.map(name => `desktop/icons/${name}`),
  'renderer/src/assets/studio-icon.png', 'renderer/public/favicon.png'].sort();

function squarePngSize(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(16) !== bytes.readUInt32BE(20)) {
    throw new Error('Application icon must be a square PNG');
  }
  return bytes.readUInt32BE(16);
}

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

export async function generateDesktopIcons({ check = false, targetRoot = studio } = {}) {
  const input = await readFile(source);
  const sourceSize = squarePngSize(input);
  const packageMetadata = JSON.parse(await readFile(join(studio, 'package.json'), 'utf8'));
  const generatorVersion = packageMetadata.devDependencies['electron-builder'];
  const derivation = { source: 'logo/icon.png', width: 512, height: 512,
    method: 'electron-builder-icons-set', generatorVersion };
  if (check) {
    const manifest = JSON.parse(await readFile(join(targetRoot, 'desktop/icon-assets.json'), 'utf8'));
    if (manifest.sourceSha256 !== sha256(input)) throw new Error('Application icon source changed; regenerate the icon inventory');
    if (manifest.source !== 'logo/icon.png' || manifest.sourceDimensions?.width !== sourceSize || manifest.sourceDimensions?.height !== sourceSize ||
        JSON.stringify(manifest.derivations?.[linuxIconPath]) !== JSON.stringify(derivation)) {
      throw new Error('Application icon derivation changed; regenerate the icon inventory');
    }
    if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(inventoryPaths)) throw new Error('Application icon inventory paths changed');
    for (const [name, expected] of Object.entries(manifest.files)) {
      const actual = await readFile(join(targetRoot, name));
      if (sha256(actual) !== expected) throw new Error(`Application icon inventory differs: ${name}`);
      if (name === linuxIconPath && squarePngSize(actual) !== 512) throw new Error('Linux icon must be the approved 512x512 derivative');
    }
    return { sourceSha256: manifest.sourceSha256, files: Object.keys(manifest.files).length + 1, check };
  }
  const temporary = await mkdtemp(join(tmpdir(), 'kcoder-generated-icons-'));
  try {
    // Reuse the pinned Electron Builder conversion tool instead of a second host CLI.
    const require = createRequire(import.meta.url);
    if (require('electron-builder/package.json').version !== generatorVersion) throw new Error('Install the locked Electron Builder before deriving icons');
    const builder = createRequire(require.resolve('electron-builder'));
    const { runIconsTool } = builder('app-builder-lib/out/toolsets/icons.js');
    await runIconsTool({ inputFile: source, outputFormat: 'set', outDir: temporary });
    for (const outputFormat of ['ico', 'icns'])
      await runIconsTool({ inputFile: source, outputFormat, outDir: temporary });
    const outputs = new Map();
    for (const name of desktopNames) {
      const generatedName = name === '128x128@2x.png' ? '256x256.png' : name === 'icon.png' ? '512x512.png' : name;
      const bytes = await readFile(join(temporary, generatedName));
      if (name === 'icon.png' && squarePngSize(bytes) !== 512) throw new Error('Icon converter did not produce its 512x512 Linux derivative');
      outputs.set(`desktop/icons/${name}`, name.endsWith('.icns') ? canonicalizeIcns(bytes) : bytes);
    }
    outputs.set('renderer/src/assets/studio-icon.png', await readFile(join(temporary, '256x256.png')));
    outputs.set('renderer/public/favicon.png', await readFile(join(temporary, '32x32.png')));
    const manifest = {
      source: 'logo/icon.png', sourceSha256: sha256(input),
      sourceDimensions: { width: sourceSize, height: sourceSize }, derivations: { [linuxIconPath]: derivation },
      files: Object.fromEntries([...outputs].map(([path, bytes]) => [path, sha256(bytes)])),
    };
    outputs.set('desktop/icon-assets.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    for (const [relative, bytes] of outputs) {
      const target = join(targetRoot, relative);
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
