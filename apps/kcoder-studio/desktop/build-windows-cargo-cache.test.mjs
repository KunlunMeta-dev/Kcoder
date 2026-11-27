import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { windowsCargoBuildArgs } from './build-windows.mjs';

test('the real addon package is outside the CLI and supervisor dependency graphs', () => {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--offline', '--locked', '--format-version=1'], {
    cwd: new URL('../../../', import.meta.url), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, RUSTC_WRAPPER: '', RUSTC_WORKSPACE_WRAPPER: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const packages = new Map(metadata.packages.map(pkg => [pkg.name, pkg]));
  const addon = packages.get('kcoder_native_image');
  assert.deepEqual(addon.targets.find(target => target.kind.includes('cdylib')).crate_types, ['cdylib']);
  // The only first-party dependency is the shared leaf identity rlib, which in
  // turn depends on no kcoder_* crate; the addon never reaches CLI/supervisor code.
  const shared = 'kcoder_native_image_identity';
  assert.deepEqual(addon.dependencies.filter(dep => /^kcoder_/.test(dep.name)).map(dep => dep.name), [shared]);
  assert.equal(packages.get(shared).dependencies.some(dep => /^kcoder_/.test(dep.name)), false);
  assert.equal(packages.get(shared).targets.some(target => target.crate_types.includes('cdylib')), false);
  const visited = new Set();
  const visit = name => {
    assert.notEqual(name, addon.name, 'CLI runtime dependencies must not include the addon');
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of packages.get(name)?.dependencies ?? []) {
      if (dep.kind !== 'dev' && packages.has(dep.name)) visit(dep.name);
    }
  };
  visit('kcoder_cli');
  visit('kcoder_process_supervisor');
  assert.equal(packages.get('kcoder_process_supervisor').targets.some(target => target.crate_types.includes('cdylib')), false);
});

test('Windows addon builds and edits leave CLI business libraries warm', {timeout: 90_000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-windows-cargo-cache-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const env = {...process.env, CARGO_TARGET_DIR: join(root, 'target'), CARGO_BUILD_JOBS: '1',
    RUSTC_WRAPPER: '', RUSTC_WORKSPACE_WRAPPER: '', RUSTFLAGS: '', CARGO_ENCODED_RUSTFLAGS: ''};
  const run = (program, args) => execFileSync(program, args, {
    cwd: root, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const host = /^host: (.+)$/m.exec(run('rustc', ['-vV']))?.[1];
  assert.ok(host, 'The fixture must build for the installed host toolchain');
  const files = {
    'Cargo.toml': '[workspace]\nmembers = ["cli", "business", "supervisor", "addon"]\nresolver = "2"\n',
    'supervisor/Cargo.toml': '[package]\nname = "kcoder_process_supervisor"\nversion = "0.1.0"\nedition = "2021"\n[features]\nasync-process = []\n[[bin]]\nname = "kcoder-process-supervisor"\npath = "src/main.rs"\n',
    'supervisor/src/lib.rs': '#[cfg(feature = "async-process")]\npub fn supervised() -> u8 { 7 }\n',
    'supervisor/src/main.rs': 'fn main() {}\n',
    'addon/Cargo.toml': '[package]\nname = "kcoder_native_image"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib"]\n',
    'addon/src/lib.rs': '#[no_mangle]\npub extern "C" fn native_image_addon() -> u8 { 9 }\n',
    'business/Cargo.toml': '[package]\nname = "business"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nkcoder_process_supervisor = { path = "../supervisor", features = ["async-process"] }\n',
    'business/src/lib.rs': 'pub fn work() -> u8 { kcoder_process_supervisor::supervised() }\n',
    'cli/Cargo.toml': '[package]\nname = "kcoder_cli"\nversion = "2.0.1"\nedition = "2021"\n[dependencies]\nbusiness = { path = "../business" }\n[[bin]]\nname = "kcoder"\npath = "src/main.rs"\n',
    'cli/src/main.rs': 'fn main() { println!("{}:{}", env!("CARGO_PKG_VERSION"), business::work()); }\n',
  };
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, '..'), {recursive: true});
    await writeFile(path, contents);
  }
  const manifest = join(root, 'Cargo.toml');
  run('cargo', ['generate-lockfile', '--offline', '--manifest-path', manifest]);
  const args = [...windowsCargoBuildArgs(host, manifest), '--offline', '--message-format=json'];
  const build = (command = args) => run('cargo', command).split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.reason === 'compiler-artifact');
  const supervisor = rows => rows.find(row => row.target.name === 'kcoder_process_supervisor');
  const addonRows = rows => rows.find(row => row.target.name === 'kcoder_native_image');
  const business = rows => rows.find(row => row.target.name === 'business');
  const cli = rows => rows.find(row => row.target.name === 'kcoder');
  const mainArgs = args.filter((arg, index) => arg !== 'kcoder_native_image' && !(arg === '-p' && args[index + 1] === 'kcoder_native_image'));
  const addonArgs = ['build', '--release', '--locked', '--manifest-path', manifest, '--target', host,
    '-p', 'kcoder_native_image', '--lib', '--offline', '--message-format=json'];
  build(mainArgs);
  build(addonArgs);
  const cold = build();
  assert.deepEqual(supervisor(cold).features, ['async-process']);
  for (const row of [supervisor(cold), business(cold), cli(cold)]) assert.equal(row.fresh, true);
  const addon = addonRows(cold).filenames.find(path => /\.(?:dll|so|dylib)$/.test(path));
  assert.ok(addon, 'The packaging plan must produce the independent addon cdylib');
  assert.ok((await readFile(addon)).length > 0);
  assert.ok(cold.some(row => row.target.name === 'kcoder-process-supervisor' && row.executable));
  assert.equal(run(cli(cold).executable, []), '2.0.1:7');
  const warm = build();
  assert.equal(supervisor(warm).fresh, true);
  assert.equal(business(warm).fresh, true);
  assert.equal(cli(warm).fresh, true);
  await writeFile(join(root, 'addon/src/lib.rs'), files['addon/src/lib.rs'].replace('9', '10'));
  const addonEdit = build(addonArgs);
  assert.equal(addonRows(addonEdit).fresh, false);
  const afterAddon = build();
  for (const row of [supervisor(afterAddon), business(afterAddon), cli(afterAddon)]) assert.equal(row.fresh, true);
  await writeFile(join(root, 'renderer.ts'), 'export const label = "TS-only edit";\n');
  const frontendEdit = build();
  for (const row of [supervisor(frontendEdit), business(frontendEdit), cli(frontendEdit), addonRows(frontendEdit)]) assert.equal(row.fresh, true);
  await writeFile(join(root, 'cli/Cargo.toml'), files['cli/Cargo.toml'].replace('2.0.1', '2.0.2'));
  run('cargo', ['generate-lockfile', '--offline', '--manifest-path', manifest]);
  const versionOnly = build();
  assert.equal(supervisor(versionOnly).fresh, true);
  assert.equal(business(versionOnly).fresh, true);
  assert.equal(cli(versionOnly).fresh, false);
  assert.equal(run(cli(versionOnly).executable, []), '2.0.2:7');
});
