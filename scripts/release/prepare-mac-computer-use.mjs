// Reuse the locked upstream macOS MCP server rather than reimplement desktop input.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const MAC_COMPUTER_USE_PACKAGE = '@steipete/peekaboo';
export const MAC_COMPUTER_USE_VERSION = '4.9.6';
const marker = 'kcoder-macos-computer-use.json';
const run = promisify(execFile);

export async function prepareMacComputerUse({ destination, arch = process.arch } = {}) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('Native macOS Computer Use staging required');
  const require = createRequire(new URL('../../apps/kcoder-studio/package.json', import.meta.url));
  const source = await realpath(dirname(require.resolve(`${MAC_COMPUTER_USE_PACKAGE}/package.json`)));
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (metadata.name !== MAC_COMPUTER_USE_PACKAGE || metadata.version !== MAC_COMPUTER_USE_VERSION) throw new Error('macOS Computer Use package does not match the lock');
  async function verify(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('Unsafe macOS Computer Use resource');
    if (info.isDirectory()) for (const name of await readdir(path)) await verify(join(path, name));
  }
  await verify(source);
  await run('/usr/bin/lipo', [join(source, 'peekaboo'), '-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64']);
  const output = resolve(destination), parent = dirname(output);
  await mkdir(parent, { recursive: true });
  let previous = false;
  try {
    const info = await lstat(output);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid macOS Computer Use destination');
    const prior = JSON.parse(await readFile(join(output, marker), 'utf8'));
    if (prior.schemaVersion !== 1 || prior.package !== MAC_COMPUTER_USE_PACKAGE) throw new Error('Refusing to replace unowned macOS Computer Use resources');
    previous = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = await mkdtemp(join(parent, '.mac-computer-use-'));
  let retain = false;
  try {
    const fresh = join(stage, 'fresh');
    await mkdir(fresh);
    await cp(source, join(fresh, 'peekaboo'), { recursive: true, errorOnExist: true, force: false });
    await chmod(join(fresh, 'peekaboo/peekaboo'), 0o755);
    await writeFile(join(fresh, marker), JSON.stringify({ schemaVersion: 1, package: metadata.name,
      version: metadata.version, arch, transport: 'stdio', command: 'peekaboo/peekaboo', args: ['mcp', 'serve', '--no-remote'],
      requires: ['macOS Screen Recording', 'macOS Accessibility'], license: metadata.license }, null, 2) + '\n');
    if (previous) await rename(output, join(stage, 'previous'));
    try { await rename(fresh, output); }
    catch (error) {
      if (previous) try { await rename(join(stage, 'previous'), output); }
      catch { retain = true; throw new Error(`macOS Computer Use rollback requires recovery from ${stage}`); }
      throw error;
    }
    return { directory: output, version: metadata.version };
  } finally { if (!retain) await rm(stage, { recursive: true, force: true }); }
}
