import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const manifestName = 'kcoder-release-manifest.json';
const blocked = new Set(['example-skill', 'example-command', '.git', '.ssh', '.kcoder', 'credentials.json', 'settings.json', 'settings.local.json', 'servers.json', 'known_hosts', 'id_rsa', 'id_ed25519', 'test-results', 'playwright-report', '__tests__', '__fixtures__']);
const secret = /(?<![A-Za-z0-9_-])sk-cp-[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64}/;
export function assertPublicPath(path) {
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some(part => blocked.has(part.toLowerCase()) || /^example-(skill|command)(?:\.|$)/i.test(part) || /^\.env(?:\.|$)/i.test(part) || /\.(log|jsonl)$/i.test(part) || /\.test\.[cm]?[jt]sx?$/i.test(part))) {
    throw new Error(`Release contains a forbidden resource path: ${path}`);
  }
  if (parts.some(part => part === '..') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new Error('Release inventory path escapes its root');
}
async function digestFile(path) {
  const hash = createHash('sha256'); let tail = '';
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    const text = tail + chunk.toString('utf8');
    if (secret.test(text)) throw new Error('Release resource contains credential material (contents suppressed)');
    tail = text.slice(-512);
  }
  return hash.digest('hex');
}
async function tree(root, prefix = '') {
  const result = [];
  for (const name of (await readdir(resolve(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (path === manifestName) continue;
    assertPublicPath(path);
    const info = await lstat(resolve(root, path));
    if (info.isSymbolicLink()) throw new Error(`Release resource is a symbolic link: ${path}`);
    if (info.isDirectory()) result.push(...await tree(root, path));
    else if (info.isFile()) result.push(path);
    else throw new Error(`Unsupported release resource type: ${path}`);
  }
  return result;
}
async function asarEntries(path) {
  const require = createRequire(resolve(repository, 'apps/kcoder-studio/package.json'));
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const asar = libraryRequire('@electron/asar');
  const entries = asar.listPackage(path).map(entry => entry.replace(/^[/\\]+/, ''));
  for (const entry of entries) if (asar.statFile(path, entry, false).link) throw new Error(`Release ASAR contains a symbolic link: ${entry}`);
  return entries;
}
export async function inventory(root, { files, inspectAsar = asarEntries } = {}) {
  root = resolve(root);
  const paths = [...new Set(files ?? await tree(root))].filter(path => path !== manifestName).sort();
  const result = [];
  for (const path of paths) {
    assertPublicPath(path);
    const full = resolve(root, path);
    if (relative(root, full).startsWith(`..${sep}`)) throw new Error('Release inventory escapes root');
    // Validate every parent too: explicitly enumerated npm files must not follow a link.
    let current = full;
    while (current !== root) {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Release resource follows a symbolic link: ${path}`);
      current = dirname(current);
    }
    const info = await lstat(full);
    if (!info.isFile()) throw new Error(`Release resource is not a file: ${path}`);
    if (path.endsWith('.asar')) for (const entry of await inspectAsar(full)) assertPublicPath(entry);
    result.push({ path, bytes: info.size, sha256: await digestFile(full) });
  }
  return result;
}
export async function releaseIdentity(root = repository) {
  const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const cargo = await readFile(resolve(root, 'Cargo.toml'), 'utf8');
  const protocol = await readFile(resolve(root, 'crates/kcoder_app_protocol/src/lib.rs'), 'utf8');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const capabilityFiles = (await readdir(resolve(root, 'crates/kcoder_app_protocol/src'))).filter(name => name.endsWith('.rs')).sort();
  const declared = new Set(['approvals', 'questions', 'threadResume']);
  const contract = [];
  for (const file of capabilityFiles) {
    const text = await readFile(resolve(root, 'crates/kcoder_app_protocol/src', file), 'utf8');
    for (const match of text.matchAll(/pub const [A-Z0-9_]*CAPABILITY[A-Z0-9_]*:\s*&str\s*=\s*"([A-Za-z0-9]+)"/g)) declared.add(match[1]);
    contract.push({ path: file, sha256: createHash('sha256').update(text).digest('hex') });
  }
  const serverSource = await readFile(resolve(root, 'crates/kcoder_cli/src/app_server.rs'), 'utf8');
  const serverDeclaration = /fn server_capabilities\([\s\S]*?\n}\n/.exec(serverSource)?.[0];
  if (!serverDeclaration) throw new Error('Cannot locate the app-server capability declaration');
  for (const match of serverDeclaration.matchAll(/"([A-Za-z][A-Za-z0-9]+)"\.to_string\(\)/g)) declared.add(match[1]);
  for (const match of serverSource.matchAll(/capabilities\.experimental\.insert\("([A-Za-z0-9]+)"/g)) declared.add(match[1]);
  contract.push({ path: '../kcoder_cli/src/app_server.rs', sha256: createHash('sha256').update(serverSource).digest('hex') });
  return {
    versions: { cli: /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1], studio: (await json('apps/kcoder-studio/package.json')).version, mobile: (await json('apps/kcoder-studio/mobile/package.json')).version },
    packagingSource: { commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain', '--untracked-files=no'])) },
    protocol: { version: /pub const PROTOCOL_VERSION:\s*&str\s*=\s*"([^"]+)"/.exec(protocol)?.[1], sourceDeclaredCapabilities: [...declared].sort(), contract,
      note: 'Source contract declarations are not runtime negotiation. Verify initialize capabilities and embedded CLI build identity on the target using the packaged smoke gate.' },
  };
}
export async function writeManifest(root, { kind, platform, files, identity, inspectAsar, hostRuntime } = {}) {
  const resources = await inventory(root, { files, inspectAsar });
  const manifest = { schemaVersion: 1, kind, platform, ...(identity ?? await releaseIdentity()), ...(hostRuntime ? { hostRuntime } : {}), resources };
  const output = resolve(root, manifestName); const temporary = `${output}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
  return manifest;
}
export async function verifyManifest(root, options = {}) {
  const manifest = JSON.parse(await readFile(resolve(root, manifestName), 'utf8'));
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.packagingSource?.commit ?? '')) throw new Error('Invalid release manifest identity');
  if (options.expectedCommit && manifest.packagingSource.commit !== options.expectedCommit) throw new Error('Release manifest has a different source commit');
  const actual = await inventory(root, options);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.resources)) throw new Error('Packaged resources do not match the release manifest');
  return manifest;
}
export async function npmManifest(root, kind) {
  // Ask npm for its real allowlist including its mandatory files; never run lifecycle scripts recursively.
  const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];
  const npmCli = /^npm-cli\.[cm]?js$/.test(basename(process.env.npm_execpath ?? "")) ? process.env.npm_execpath : null;
  let output;
  try {
    output = execFileSync(npmCli ? process.execPath : process.platform === 'win32' ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : process.platform === 'win32' ? [resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args] : args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new Error('npm release inventory failed (subprocess output suppressed)'); }
  const [pack] = JSON.parse(output);
  if (!Array.isArray(pack?.files)) throw new Error('npm did not report its package inventory');
  const required = kind === 'mobile-web' ? ['dist/index.html'] : ['renderer/dist/index.html', 'dev-server.mjs'];
  if (required.some(path => !pack.files.some(file => file.path === path))) throw new Error('Web release is missing its built entry points; run the product build first');
  return writeManifest(root, { kind, platform: 'web', files: pack.files.map(file => file.path) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, path, kind, platform] = process.argv.slice(2);
  try {
    if (mode === '--npm') await npmManifest(resolve(path), kind);
    else if (mode === '--verify') await verifyManifest(resolve(path), { expectedCommit: kind ?? process.env.KCODER_RELEASE_EXPECTED_COMMIT });
    else if (mode === '--stage' && path && kind) await writeManifest(resolve(path), { kind, platform });
    else throw new Error('Usage: artifact-manifest.mjs --stage DIR KIND PLATFORM | --npm DIR KIND | --verify DIR');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
