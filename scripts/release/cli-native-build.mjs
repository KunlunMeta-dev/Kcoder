import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargoPackageVersion } from './artifact-manifest.mjs';
import { stageCliReleaseMetadata } from './cli-release-metadata.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));

function sourceIdentity(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_OPTIONAL_LOCKS = '0';
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    if (resolve(git(['rev-parse', '--show-toplevel'])) !== resolve(root)) throw new Error('Not the selected checkout');
    return { commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain', '--untracked-files=no'])) };
  }
  catch { return { commit: 'unknown', dirty: true }; }
}

export async function cliReleaseIdentity(root = repository, env = process.env) {
  const pkg = JSON.parse(await readFile(resolve(root, 'apps/kcoder-studio/package.json'), 'utf8'));
  const actual = sourceIdentity(root);
  const timeUnix = Number(env.KCODER_BUILD_TIME_UNIX || env.SOURCE_DATE_EPOCH || 0);
  return { version: pkg.version, commit: env.KCODER_BUILD_COMMIT || actual.commit,
    dirty: env.KCODER_BUILD_DIRTY == null ? actual.dirty : ['true', '1'].includes(env.KCODER_BUILD_DIRTY), timeUnix };
}

async function digest(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid Cargo CLI artifact');
  const file = await open(path, 'r');
  try {
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally { await file.close(); }
}

async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

/** Cargo remains authoritative about whether native inputs actually rebuilt. */
export async function buildNativeCli(args, { root = repository, env = process.env, cargo = 'cargo', output = process.stdout } = {}) {
  const before = sourceIdentity(root);
  let artifact, pending = '';
  const consume = line => {
    let value;
    try { value = JSON.parse(line); } catch { output.write(line + '\n'); return; }
    if (value.reason === 'compiler-artifact' && value.target?.name === 'kcoder' && value.executable) artifact = value;
    if (value.reason === 'compiler-message' && value.message?.rendered) output.write(value.message.rendered);
  };
  await new Promise((complete, reject) => {
    const child = spawn(cargo, [...args, '--message-format=json-render-diagnostics'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'], shell: false });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { pending += chunk; let index; while ((index = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, index)); pending = pending.slice(index + 1); } });
    child.once('error', reject);
    child.once('close', code => { if (pending) consume(pending); code === 0 ? complete() : reject(new Error(`cargo build failed (${code})`)); });
  });
  if (!artifact) throw new Error('Cargo did not report the CLI executable');
  const path = artifact.executable, artifactSha256 = await digest(path), receiptPath = path + '.native-build.json';
  if (artifact.fresh) {
    const previous = JSON.parse(await readFile(receiptPath, 'utf8').catch(() => { throw new Error('Cached CLI has no native build receipt; rebuild the CLI once in this target directory'); }));
    if (previous.schemaVersion !== 1 || previous.native?.artifactSha256 !== artifactSha256) throw new Error('Cached CLI bytes differ from their native build receipt; refusing false provenance');
    return { ...previous, artifactSha256, executable: path, fresh: true };
  }
  const after = sourceIdentity(root);
  const version = cargoPackageVersion(await readFile(resolve(root, 'crates/kcoder_cli/Cargo.toml'), 'utf8'), await readFile(resolve(root, 'Cargo.toml'), 'utf8'));
  const native = { version, commit: before.commit, dirty: before.dirty || after.dirty || before.commit !== after.commit,
    timeUnix: Math.floor(Date.now() / 1000), artifactSha256 };
  const receipt = { schemaVersion: 1, native };
  await save(receiptPath, receipt);
  return { ...receipt, artifactSha256, executable: path, fresh: false };
}

export async function stageBuiltCli(build, destination, release) {
  if (build.schemaVersion !== 1) throw new Error('Unsupported native CLI build receipt');
  return stageCliReleaseMetadata(build.executable, destination, { schemaVersion: 1, release, native: build.native });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, executable, destination] = process.argv.slice(2);
  if (mode === '--build') {
    const args = process.argv.slice(3); if (args[0] === '--') args.shift();
    if (args[0] !== 'build') throw new Error('The native CLI builder requires cargo build arguments');
    const result = await buildNativeCli(args, { cargo: process.env.KCODER_CARGO_BIN || 'cargo' });
    console.log(JSON.stringify({ executable: result.executable, fresh: result.fresh, native: result.native }));
  } else if (mode === '--stage' && executable && destination) {
    const receipt = JSON.parse(await readFile(executable + '.native-build.json', 'utf8'));
    await stageBuiltCli({ ...receipt, executable }, destination, await cliReleaseIdentity());
  } else throw new Error('Usage: cli-native-build.mjs --build -- build ARGS | --stage CARGO_BINARY DESTINATION');
}
