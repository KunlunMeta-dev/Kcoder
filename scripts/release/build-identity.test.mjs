import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildNativeCli, cliReleaseIdentity, stageBuiltCli } from './cli-native-build.mjs';
import { readCliReleaseMetadata, stampCliReleaseMetadata } from './cli-release-metadata.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('CLI links compressed Linux GNU Debug data and preserves release and Windows policies', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'kcoder-link-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, 'build.rs'), program = resolve(root, process.platform === 'win32' ? 'build-script.exe' : 'build-script');
  await writeFile(source, await readFile(new URL('../../crates/kcoder_cli/build.rs', import.meta.url)));
  execFileSync('rustc', ['--edition=2024', source, '-o', program], { cwd: root, stdio: 'pipe' });
  const policy = (target, profile) => execFileSync(program, [], {
    cwd: root, env: { ...process.env, TARGET: target, PROFILE: profile }, encoding: 'utf8',
  }).trim().split('\n').map(line => line.trim());
  const prefix = 'cargo:rerun-if-changed=build.rs';
  for (const target of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']) {
    assert.deepEqual(policy(target, 'debug'), [prefix, 'cargo:rustc-link-arg-bin=kcoder=-Wl,--compress-debug-sections=zlib']);
    assert.deepEqual(policy(target, 'release'), [prefix]);
  }
  for (const target of ['aarch64-apple-darwin', 'x86_64-unknown-linux-musl']) assert.deepEqual(policy(target, 'debug'), [prefix]);
  assert.deepEqual(policy('x86_64-pc-windows-gnu', 'debug'), [prefix, 'cargo:rustc-link-arg-bin=kcoder=-Wl,--stack,16777216']);
  assert.deepEqual(policy('x86_64-pc-windows-msvc', 'release'), [prefix, 'cargo:rustc-link-arg-bin=kcoder=/STACK:16777216']);
});

test('release version, Git source and timestamps leave the complete CLI fresh under release LTO', { timeout: 180_000 }, async t => {
  const owned = await mkdtemp(resolve(tmpdir(), 'kcoder-release-metadata-'));
  t.after(() => rm(owned, { recursive: true, force: true }));
  const root = resolve(owned, 'source'), source = resolve(root, 'crates/kcoder_cli');
  for (const path of ['crates/kcoder_cli/src', 'business/src', 'apps/kcoder-studio']) await mkdir(resolve(root, path), { recursive: true });
  await writeFile(resolve(root, 'Cargo.toml'), '[workspace]\nmembers=["crates/kcoder_cli","business"]\nresolver="2"\n[workspace.package]\nversion="0.1.0"\n[profile.release]\nlto="thin"\ncodegen-units=1\n');
  await writeFile(resolve(source, 'Cargo.toml'), '[package]\nname="kcoder_cli"\nversion.workspace=true\nedition="2024"\n[[bin]]\nname="kcoder"\npath="src/main.rs"\n[dependencies]\nserde_json="1"\nbusiness={path="../../business"}\n');
  await writeFile(resolve(root, 'business/Cargo.toml'), '[package]\nname="business"\nversion="0.1.0"\nedition="2024"\n');
  await writeFile(resolve(root, 'business/src/lib.rs'), 'pub fn result()->u64{42}\n');
  for (const [input, output] of [
    ['../../crates/kcoder_cli/build.rs', 'build.rs'],
    ['../../crates/kcoder_cli/src/release_metadata.rs', 'src/release_metadata.rs'],
    ['../../crates/kcoder_cli/release-metadata-marker.txt', 'release-metadata-marker.txt'],
    ['../../crates/kcoder_cli/src/internal/cli_commands/build_identity.rs', 'src/build_identity.rs'],
  ]) await writeFile(resolve(source, output), await readFile(new URL(input, import.meta.url)));
  await writeFile(resolve(source, 'src/main.rs'), `mod release_metadata;mod build_identity;
fn main(){let payload=release_metadata::payload().unwrap();build_identity::initialize_release_metadata(payload.as_deref(),env!("CARGO_PKG_VERSION")).unwrap();println!("{}",serde_json::json!({"version":build_identity::version(),"nativeCommit":build_identity::current().commit,"metadata":build_identity::release_metadata(),"result":business::result()}));}`);
  const product = resolve(root, 'apps/kcoder-studio/package.json');
  await writeFile(product, '{"version":"2.0.37"}\n');
  await writeFile(resolve(root, '.gitignore'), 'target/\n');
  const run = (program, args, env = process.env) => execFileSync(program, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const env = { ...process.env, RUSTC_WRAPPER: '', CARGO_TARGET_DIR: resolve(owned, 'cargo-target'), KCODER_BUILD_COMMIT: '1'.repeat(40), KCODER_BUILD_DIRTY: 'false', KCODER_BUILD_TIME_UNIX: '100' };
  run('git', ['init', '-b', 'main']); run('git', ['config', 'user.email', 'fixture@example.invalid']); run('git', ['config', 'user.name', 'Fixture']);
  run('cargo', ['generate-lockfile', '--offline'], env); run('git', ['add', '.']); run('git', ['commit', '-m', 'native source']);
  const firstSource = run('git', ['rev-parse', 'HEAD']);
  const output = new PassThrough(); output.resume();
  const args = ['build', '--release', '--locked', '--offline', '-p', 'kcoder_cli'];
  await t.test('Linux GNU Debug links compressed debug sections and preserves metadata stamping', {
    skip: process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) ||
      !/host: .*linux-gnu/.test(run('rustc', ['-vV'])),
  }, async () => {
    const debug = await buildNativeCli(['build', '--locked', '--offline', '-p', 'kcoder_cli'], { root, env, output });
    const elf = await readFile(debug.executable);
    assert.deepEqual([...elf.subarray(0, 6)], [0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    const table = Number(elf.readBigUInt64LE(40)), entryBytes = elf.readUInt16LE(58), count = elf.readUInt16LE(60);
    const namesEntry = table + elf.readUInt16LE(62) * entryBytes;
    const names = Number(elf.readBigUInt64LE(namesEntry + 24));
    const compressed = [];
    for (let index = 0; index < count; index++) {
      const entry = table + index * entryBytes, start = names + elf.readUInt32LE(entry);
      const name = elf.toString('utf8', start, elf.indexOf(0, start));
      if (name.startsWith('.debug') && (elf.readBigUInt64LE(entry + 8) & 0x800n)) compressed.push(name);
    }
    assert.ok(compressed.includes('.debug_info'), 'The actual linker must compress DWARF data');
    const stagedDebug = resolve(owned, 'staged-debug-kcoder');
    await stageBuiltCli(debug, stagedDebug, await cliReleaseIdentity(root, env));
    const actual = JSON.parse(run(stagedDebug, [], env));
    assert.equal(actual.result, 42);
    assert.equal(actual.version, '2.0.37');
    assert.equal(actual.metadata.native.artifactSha256, digest(elf));
  });
  const first = await buildNativeCli(args, { root, env, output });
  assert.equal(first.fresh, false);
  const original = await readFile(first.executable);
  assert.equal(JSON.parse(run(first.executable, [], env)).version, '0.1.0');
  const staged = resolve(owned, 'published-kcoder');
  await stageBuiltCli(first, staged, await cliReleaseIdentity(root, env));
  let actual = JSON.parse(run(staged, [], env));
  assert.equal(actual.version, '2.0.37'); assert.equal(actual.nativeCommit, firstSource); assert.equal(actual.result, 42);
  await writeFile(product, '{"version":"2.0.38"}\n');
  await writeFile(resolve(root, 'settings.json'), '{"model":"runtime-only"}\n');
  await writeFile(resolve(root, '.env'), 'UI_LABEL=metadata-only\n');
  run('git', ['add', '.']); run('git', ['commit', '-m', 'frontend release and runtime configuration']);
  env.KCODER_BUILD_COMMIT = '2'.repeat(40); env.KCODER_BUILD_TIME_UNIX = '200'; env.KCODER_BUILD_DIRTY = 'true';
  const second = await buildNativeCli(args, { root, env, output });
  assert.equal(second.fresh, true, 'the executable itself must stay fresh');
  assert.deepEqual(second.native, first.native, 'preserve original native source and build time');
  assert.deepEqual(await readFile(second.executable), original, 'never rewrite Cargo outputs');
  const receipt = await readFile(second.executable + '.native-build.json');
  await rm(second.executable + '.native-build.json');
  await assert.rejects(buildNativeCli(args, { root, env, output }), /no native build receipt/);
  await writeFile(second.executable + '.native-build.json', receipt);
  const artifacts = run('cargo', [...args, '--message-format=json'], env).split('\n').map(line => JSON.parse(line)).filter(row => row.reason === 'compiler-artifact');
  for (const name of ['kcoder', 'business']) assert.equal(artifacts.find(row => row.target.name === name).fresh, true);
  await stageBuiltCli(second, staged, await cliReleaseIdentity(root, env));
  actual = JSON.parse(run(staged, [], env));
  assert.equal(actual.version, '2.0.38', 'post-link data survives Rust optimization and LTO');
  assert.equal(actual.metadata.release.commit, '2'.repeat(40)); assert.equal(actual.metadata.release.timeUnix, 200); assert.equal(actual.metadata.release.dirty, true);
  assert.equal(actual.nativeCommit, firstSource); assert.equal(actual.metadata.native.artifactSha256, digest(original));
  assert.equal((await readCliReleaseMetadata(staged)).release.version, '2.0.38');
  await writeFile(resolve(root, 'business/src/lib.rs'), 'pub fn result()->u64{43}\n');
  const changed = await buildNativeCli(args, { root, env, output });
  assert.equal(changed.fresh, false, 'real native changes must invalidate the executable');
  assert.notEqual(changed.artifactSha256, first.artifactSha256);
  await stageBuiltCli(changed, staged, await cliReleaseIdentity(root, env));
  assert.equal(JSON.parse(run(staged, [], env)).result, 43);
  run('cargo', ['test', '--release', '--locked', '--offline', '-p', 'kcoder_cli', '--bin', 'kcoder', 'build_identity::tests::executable_provenance_is_immutable'], env);
  const tampered = await readFile(changed.executable); tampered[0] ^= 1; await writeFile(changed.executable, tampered);
  await assert.rejects(buildNativeCli(args, { root, env, output }), /differ from their native build receipt/);
});

test('metadata staging rejects missing, duplicate, corrupt and mismatched slots', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'kcoder-metadata-validation-')); t.after(() => rm(root, { recursive: true, force: true }));
  const marker = await readFile(new URL('../../crates/kcoder_cli/release-metadata-marker.txt', import.meta.url));
  const file = resolve(root, 'kcoder'), original = Buffer.alloc(4200); marker.copy(original, 64);
  const identity = { version: '2.0.37', commit: 'a'.repeat(40), dirty: false, timeUnix: 42 };
  const metadata = { schemaVersion: 1, release: identity, native: { ...identity, version: '0.1.0', artifactSha256: digest(original) } };
  await writeFile(file, original); await stampCliReleaseMetadata(file, metadata);
  assert.equal((await readCliReleaseMetadata(file)).native.commit, identity.commit);
  await assert.rejects(stampCliReleaseMetadata(file, metadata), /do not match their original native build/);
  await assert.rejects(stampCliReleaseMetadata(file, { ...metadata, release: { ...identity, commit: 'invalid' } }), /provenance/);
  await writeFile(file, Buffer.alloc(4200)); await assert.rejects(readCliReleaseMetadata(file), /unique release metadata slot/);
  await writeFile(file, Buffer.concat([original, original])); await assert.rejects(readCliReleaseMetadata(file), /unique release metadata slot/);
  const corrupt = Buffer.from(original); corrupt.writeUInt32LE(4096, 128); await writeFile(file, corrupt);
  await assert.rejects(readCliReleaseMetadata(file), /size/);
});
