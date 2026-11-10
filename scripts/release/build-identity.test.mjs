import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

test('Cargo refreshes embedded identity for a same-branch commit and a linked worktree', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'kcoder-build-identity-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const source = resolve(root,'source'); await mkdir(resolve(source,'crates/kcoder_cli/src'),{recursive:true});
  const run = (file,args,cwd=source,env=process.env) => execFileSync(file,args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  await writeFile(resolve(source,'Cargo.toml'),'[workspace]\nmembers=["crates/kcoder_cli"]\nresolver="2"\n');
  await writeFile(resolve(source,'crates/kcoder_cli/Cargo.toml'),'[package]\nname="identity-fixture"\nversion="0.0.0"\nedition="2024"\n');
  await writeFile(resolve(source,'crates/kcoder_cli/src/main.rs'),'fn main(){println!("{}",env!("KCODER_BUILD_COMMIT"));}');
  await writeFile(resolve(source,'crates/kcoder_cli/build.rs'),await readFile(new URL('../../crates/kcoder_cli/build.rs',import.meta.url)));
  await writeFile(resolve(source,'.gitignore'),'target/\n');
  run('git',['init','-b','main']);run('git',['config','user.email','fixture@example.invalid']);run('git',['config','user.name','Fixture']);
  run('git',['add','.']);run('git',['commit','-m','initial']);
  const env={...process.env,RUSTC_WRAPPER:'',CARGO_TARGET_DIR:resolve(root,'cargo-target')};
  for(const key of ['KCODER_BUILD_COMMIT','KCODER_BUILD_DIRTY','KCODER_BUILD_TIME_UNIX'])delete env[key];
  const build = cwd => run('cargo',['run','--quiet','--offline','-p','identity-fixture'],cwd,env);
  assert.equal(build(source),run('git',['rev-parse','HEAD']));
  await writeFile(resolve(source,'revision.txt'),'second');run('git',['add','.']);run('git',['commit','-m','same branch']);
  assert.equal(build(source),run('git',['rev-parse','HEAD']), 'HEAD contents did not change, but its branch ref did');
  const linked=resolve(root,'linked');run('git',['worktree','add','-b','linked',linked]);
  assert.equal(build(linked),run('git',['rev-parse','HEAD'],linked));
  await writeFile(resolve(linked,'revision.txt'),'third');run('git',['add','.'],linked);run('git',['commit','-m','linked branch'],linked);
  assert.equal(build(linked),run('git',['rev-parse','HEAD'],linked));
  run('git',['pack-refs','--all'],linked);
  assert.equal(build(linked),run('git',['rev-parse','HEAD'],linked));
  run('git',['commit','--allow-empty','-m','commit after packed refs'],linked);
  assert.equal(build(linked),run('git',['rev-parse','HEAD'],linked));

  run('git', ['branch', 'unrelated-ref'], linked);
  run('git', ['pack-refs', '--all', '--no-prune'], linked);
  const packedRefs = resolve(linked, run('git', ['rev-parse', '--git-path', 'packed-refs'], linked));
  const changedTime = new Date(Date.now() + 2_000);
  await utimes(packedRefs, changedTime, changedTime);
  const artifacts = run('cargo', [
    'build', '--offline', '-p', 'identity-fixture', '--message-format=json',
  ], linked, env).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const executable = artifacts.find(event => event.reason === 'compiler-artifact'
    && event.target.name === 'identity-fixture');
  assert.ok(executable, 'Cargo must report the fixture executable');
  assert.equal(executable.fresh, true, 'packing unrelated refs must preserve the build cache');

  const index = resolve(linked, run('git', ['rev-parse', '--git-path', 'index'], linked));
  await utimes(resolve(linked, 'revision.txt'), changedTime, changedTime);
  await utimes(resolve(linked, 'crates/kcoder_cli/build.rs'), changedTime, changedTime);
  const originalIndex = await readFile(index);
  assert.equal(build(linked), run('git', ['rev-parse', 'HEAD'], linked));
  assert.deepEqual(await readFile(index), originalIndex, 'identity reads must preserve index stat data');

  run('git', ['checkout', '--detach'], linked);
  assert.equal(build(linked), run('git', ['rev-parse', 'HEAD'], linked));
  run('git', ['commit', '--allow-empty', '-m', 'detached commit'], linked);
  assert.equal(build(linked), run('git', ['rev-parse', 'HEAD'], linked));
});

test('version and provenance updates rebuild the entry while business libraries stay fresh', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'kcoder-entry-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, 'source');
  await mkdir(resolve(source, 'crates/kcoder_cli/src'), { recursive: true });
  await mkdir(resolve(source, 'business/src'), { recursive: true });
  const run = (file, args, env) => execFileSync(file, args, {
    cwd: source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  await writeFile(resolve(source, 'Cargo.toml'), '[workspace]\nmembers=["crates/kcoder_cli","business"]\nresolver="2"\n');
  const manifest = version => `[package]\nname="entry-cache-fixture"\nversion="${version}"\nedition="2024"\n[dependencies]\nbusiness={path="../../business"}\n`;
  const cliManifest = resolve(source, 'crates/kcoder_cli/Cargo.toml');
  await writeFile(cliManifest, manifest('2.0.1'));
  await writeFile(resolve(source, 'business/Cargo.toml'), '[package]\nname="business"\nversion="0.1.0"\nedition="2024"\n');
  await writeFile(resolve(source, 'business/src/lib.rs'), await readFile(new URL('../../crates/kcoder_cli/src/internal/cli_commands/build_identity.rs', import.meta.url)));
  await writeFile(resolve(source, 'crates/kcoder_cli/build.rs'), await readFile(new URL('../../crates/kcoder_cli/build.rs', import.meta.url)));
  await writeFile(resolve(source, 'crates/kcoder_cli/src/main.rs'), `fn main(){business::initialize(business::BuildIdentity{version:env!("CARGO_PKG_VERSION"),commit:env!("KCODER_BUILD_COMMIT"),dirty:env!("KCODER_BUILD_DIRTY"),time_unix:env!("KCODER_BUILD_TIME_UNIX")}).unwrap();println!("{} {}",business::version(),business::current().commit);}`);
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'fixture@example.invalid']);
  run('git', ['config', 'user.name', 'Fixture']);
  await writeFile(resolve(source, '.gitignore'), 'target/\n');
  run('git', ['add', '.']); run('git', ['commit', '-m', 'initial']);
  const env = { ...process.env, RUSTC_WRAPPER: '', CARGO_TARGET_DIR: resolve(root, 'cargo-target'),
    KCODER_BUILD_COMMIT: 'first-source', KCODER_BUILD_DIRTY: 'false', KCODER_BUILD_TIME_UNIX: '42' };
  const build = () => run('cargo', ['build', '--offline', '--message-format=json', '-p', 'entry-cache-fixture'], env)
    .split('\n').map(line => JSON.parse(line)).filter(row => row.reason === 'compiler-artifact');
  const fresh = (rows, name) => rows.find(row => row.target.name === name)?.fresh;
  build();
  await writeFile(cliManifest, manifest('2.0.2'));
  env.KCODER_BUILD_COMMIT = 'second-source';
  let rows = build();
  assert.equal(fresh(rows, 'business'), true);
  assert.equal(fresh(rows, 'entry-cache-fixture'), false);
  const binary = rows.find(row => row.target.name === 'entry-cache-fixture').executable;
  assert.equal(run(binary, [], env), '2.0.2 second-source');
  await writeFile(resolve(source, 'settings.json'), '{"model":"changed-at-runtime"}');
  run('git', ['add', 'settings.json']); run('git', ['commit', '-m', 'unrelated runtime configuration']);
  rows = build();
  assert.equal(fresh(rows, 'business'), true);
  assert.equal(fresh(rows, 'entry-cache-fixture'), true, 'explicit frozen provenance ignores unrelated Git/index changes');
  await writeFile(resolve(source, 'business/src/lib.rs'), `${await readFile(resolve(source, 'business/src/lib.rs'), 'utf8')}\npub fn changed_business() -> bool { true }\n`);
  assert.equal(fresh(build(), 'business'), false, 'real business source changes must invalidate the library');
});
