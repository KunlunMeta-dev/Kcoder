import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, link, truncate, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOfficePackageManifest, verifyOfficePackageManifest } from '../src/package-manifest.mjs';

const source = fileURLToPath(new URL('../src/package-manifest.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const observations = { rootsCreated: 0, rootsRemoved: 0, childrenStarted: 0, childrenExited: 0 };

async function fixture(t, { entry = true, module = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'office-manifest-fixes-'));
  observations.rootsCreated++;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: 'ENOENT' }); observations.rootsRemoved++;
  });
  await mkdir(join(root, 'src')); await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@kcoder/office-components', version: '1.0.0', engines: { node: '>=22' } }));
  await writeFile(join(root, 'package-lock.json'), '{"packages":{}}');
  await writeFile(join(root, 'README.md'), 'owned fixture readme');
  if (entry) await writeFile(join(root, 'src/cli.mjs'), 'fixture entry');
  if (module) await writeFile(join(root, 'src/package-manifest.mjs'), await readFile(source));
  return root;
}

function cli(root, target, patch = '') {
  const entry = join(root, 'src/package-manifest.mjs');
  const code = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    import {pathToFileURL} from 'node:url'; const [entry,target]=process.argv.slice(1);
    const originalOpen=fs.open, originalWrite=fs.writeFile, originalRename=fs.rename;
    ${patch}
    syncBuiltinESMExports(); process.argv=[process.execPath,entry,'--output',target];
    try{await import(pathToFileURL(entry));process.stdout.write(JSON.stringify({status:'ok'}));}
    catch(error){process.stdout.write(JSON.stringify({status:'error',code:error.code??error.message,externalOutcome:error.externalOutcome,cleanupUnconfirmed:error.cleanupUnconfirmed,publication:error.publication}));}`;
  observations.childrenStarted++;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, entry, target], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error); assert.equal(result.signal, null); observations.childrenExited++;
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}

test('CLI self-output conflicts reject without changing a hashed source file', async t => {
  const root = await fixture(t, { module: true }), target = join(root, 'README.md'), before = await readFile(target);
  assert.equal(cli(root, target).code, 'OFFICE_PACKAGE_OUTPUT_CONFLICT');
  assert.deepEqual(await readFile(target), before);
});

test('physical aliases and future traversed outputs conflict while ignored-root and outside outputs remain valid', async t => {
  const root = await fixture(t, { module: true }), outside = await fixture(t), alias = join(outside, 'source-alias');
  await symlink(root, alias);
  for (const path of ['src/future.json', 'node_modules/future.json', 'package.json', 'package-lock.json', 'README.md']) {
    assert.equal(cli(root, join(alias, path)).code, 'OFFICE_PACKAGE_OUTPUT_CONFLICT', path);
  }
  await writeFile(join(root, 'LICENSE'), 'owned retained legal text');
  assert.equal(cli(root, join(alias, 'LICENSE')).code, 'OFFICE_PACKAGE_OUTPUT_CONFLICT');
  assert.equal(await readFile(join(root, 'LICENSE'), 'utf8'), 'owned retained legal text');
  for (const output of [join(alias, 'manifest-output.json'), join(outside, 'manifest-output.json')]) {
    await writeFile(output, 'old normal output'); assert.equal(cli(root, output).status, 'ok');
    assert.equal((await verifyOfficePackageManifest(JSON.parse(await readFile(output)), root)).status, 'verified');
  }
});

test('CLI publication replaces an output symlink entry without modifying its target', async t => {
  const root = await fixture(t, { module: true }), peer = join(root, 'peer.json'), output = join(root, 'output.json');
  await writeFile(peer, 'owned peer sentinel'); await symlink(peer, output);
  const result = cli(root, output);
  assert.equal(await readFile(peer, 'utf8'), 'owned peer sentinel');
  if (result.status === 'ok') {
    assert.equal((await lstat(output)).isSymbolicLink(), false);
    assert.equal(JSON.parse(await readFile(output)).schemaVersion, 1);
  }
});

test('CLI publication replaces a hardlink entry without modifying its peer', async t => {
  const root = await fixture(t, { module: true }), peer = join(root, 'peer.json'), output = join(root, 'output.json');
  await writeFile(peer, 'owned peer sentinel'); await link(peer, output);
  assert.equal(cli(root, output).status, 'ok');
  assert.equal(await readFile(peer, 'utf8'), 'owned peer sentinel');
  assert.equal((await lstat(output)).nlink, 1);
});

test('CLI replaces normal existing outputs and accepts a new output', async t => {
  const root = await fixture(t, { module: true });
  const existing = join(root, 'existing.json'); await writeFile(existing, 'old complete bytes');
  assert.equal(cli(root, existing).status, 'ok');
  assert.equal(JSON.parse(await readFile(existing)).schemaVersion, 1);
  const output = join(root, 'new.json'); assert.equal(cli(root, output).status, 'ok');
  assert.equal(JSON.parse(await readFile(output)).schemaVersion, 1);
});

test('late output symlink and hardlink replacement cannot redirect the atomic write to a peer', async t => {
  for (const kind of ['symlink', 'link']) {
    const root = await fixture(t, { module: true }), peer = join(root, 'peer.json'), output = join(root, 'manifest.json');
    await writeFile(peer, 'peer remains intact'); await writeFile(output, 'previous');
    const result = cli(root, output, `fs.rename=async(from,to)=>{await fs.unlink(to);await fs.${kind}(${JSON.stringify(peer)},to);return originalRename(from,to);};`);
    assert.equal(result.status, 'ok'); assert.equal(await readFile(peer, 'utf8'), 'peer remains intact');
    assert.equal(JSON.parse(await readFile(output)).schemaVersion, 1);
  }
});

test('a partial output write EIO preserves the previous complete manifest and removes only its temp', async t => {
  const root = await fixture(t, { module: true }), output = join(root, 'manifest.json'), previous = '{"previous":"complete"}';
  await writeFile(output, previous);
  const result = cli(root, output, `
    fs.writeFile=async(path,bytes,options)=>{if(path!==target)return originalWrite(path,bytes,options);await originalWrite(path,bytes.slice(0,17),options);throw Object.assign(new Error('owned injected write failure'),{code:'EIO'});};
    fs.open=async(path,...options)=>{const h=await originalOpen(path,...options);if(String(path).includes('.office-manifest-')){const write=h.writeFile.bind(h);h.writeFile=async(bytes)=>{await write(bytes.slice(0,17));throw Object.assign(new Error('owned injected write failure'),{code:'EIO'});};}return h;};`);
  assert.equal(result.code, 'EIO'); assert.equal(await readFile(output, 'utf8'), previous);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.office-manifest-')), []);
});

test('rename success with a lost receipt reports unknown and leaves the published image intact', async t => {
  const root = await fixture(t, { module: true }), output = join(root, 'manifest.json'); await writeFile(output, 'previous');
  const result = cli(root, output, `fs.rename=async(from,to)=>{await originalRename(from,to);throw Object.assign(new Error('owned lost rename receipt'),{code:'EIO'});};`);
  assert.equal(result.code, 'OFFICE_PACKAGE_PUBLICATION_UNCONFIRMED'); assert.equal(result.externalOutcome, 'unknown');
  assert.equal(JSON.parse(await readFile(output)).schemaVersion, 1);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.office-manifest-')), []);
});

test('a rename error before publication preserves the old image and owned recovery candidate', async t => {
  const root = await fixture(t, { module: true }), output = join(root, 'manifest.json'); await writeFile(output, 'previous');
  const result = cli(root, output, `fs.rename=async()=>{throw Object.assign(new Error('owned uncertain rename'),{code:'EIO'});};`);
  assert.equal(result.code, 'OFFICE_PACKAGE_PUBLICATION_UNCONFIRMED'); assert.equal(result.externalOutcome, 'unknown');
  assert.equal(await readFile(output, 'utf8'), 'previous');
  const temps = (await readdir(root)).filter(name => name.startsWith('.office-manifest-')); assert.equal(temps.length, 1);
  assert.equal(JSON.parse(await readFile(join(root, temps[0]))).schemaVersion, 1);
});

test('a peer replacement of the owned temp is retained and never published or deleted', async t => {
  const root = await fixture(t, { module: true }), output = join(root, 'manifest.json'); await writeFile(output, 'previous');
  const result = cli(root, output, `fs.open=async(path,...options)=>{const h=await originalOpen(path,...options);if(String(path).includes('.office-manifest-')&&(options[0]&1)===1){const close=h.close.bind(h);h.close=async()=>{await close();await fs.unlink(path);await originalWrite(path,'peer temp image');};}return h;};`);
  assert.equal(result.code, 'OFFICE_PACKAGE_UNSAFE_ENTRY'); assert.equal(await readFile(output, 'utf8'), 'previous');
  const temps = (await readdir(root)).filter(name => name.startsWith('.office-manifest-')); assert.equal(temps.length, 1);
  assert.equal(await readFile(join(root, temps[0]), 'utf8'), 'peer temp image');
});

test('temp sync and close failures preserve old bytes while post-rename directory sync is unknown', async t => {
  for (const phase of ['sync', 'close', ...(process.platform === 'win32' ? [] : ['directory'])]) {
    const root = await fixture(t, { module: true }), output = join(root, 'manifest.json'); await writeFile(output, 'previous');
    const result = cli(root, output, `fs.open=async(path,...options)=>{const h=await originalOpen(path,...options);
      if(${JSON.stringify(phase)}==='directory'?String(path)===${JSON.stringify(root)}:String(path).includes('.office-manifest-')&&(options[0]&1)===1){
        const phase=${JSON.stringify(phase)};const method=phase==='close'?'close':'sync',original=h[method].bind(h);
        h[method]=async()=>{if(phase==='close')await original();throw Object.assign(new Error('owned phase failure'),{code:'EIO'});};
      }return h;};`);
    if (phase === 'directory') {
      assert.equal(result.code, 'OFFICE_PACKAGE_PUBLICATION_UNCONFIRMED'); assert.equal(result.externalOutcome, 'unknown');
      assert.equal(JSON.parse(await readFile(output)).schemaVersion, 1);
    } else { assert.equal(result.code, 'EIO'); assert.equal(await readFile(output, 'utf8'), 'previous'); }
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.office-manifest-')), []);
  }
});

test('a hardlink to the owned candidate prevents publication and ownership cleanup', async t => {
  const root = await fixture(t, { module: true }), output = join(root, 'manifest.json'), peer = join(root, 'peer-alias'); await writeFile(output, 'previous');
  const result = cli(root, output, `fs.open=async(path,...options)=>{const h=await originalOpen(path,...options);if(String(path).includes('.office-manifest-')&&(options[0]&1)===1){const sync=h.sync.bind(h);h.sync=async()=>{await sync();await fs.link(path,${JSON.stringify(peer)});};}return h;};`);
  assert.equal(result.code, 'OFFICE_PACKAGE_UNSAFE_ENTRY'); assert.equal(result.cleanupUnconfirmed, true);
  assert.equal(await readFile(output, 'utf8'), 'previous');
  const temps = (await readdir(root)).filter(name => name.startsWith('.office-manifest-')); assert.equal(temps.length, 1);
  assert.equal((await lstat(join(root, temps[0]))).ino, (await lstat(peer)).ino);
});

test('source metadata uses one verified snapshot and a later build observes the next generation', async t => {
  const root = await fixture(t), pkg = join(root, 'package.json'), lock = join(root, 'package-lock.json');
  const oldPackage = await readFile(pkg), oldLock = await readFile(lock), original = fs.readdir, originalOpen = fs.open;
  const opens = new Map(); let replaced = false;
  const reads = t.mock.method(fs, 'open', async (path, ...args) => { opens.set(path, (opens.get(path) ?? 0) + 1); return originalOpen(path, ...args); });
  const listing = t.mock.method(fs, 'readdir', async (path, options) => {
    if (path === join(root, 'src') && !replaced) { replaced = true; await writeFile(pkg, '{"name":"@kcoder/office-components","version":"2.0.0"}'); await writeFile(lock, '{"packages":{},"changed":true}'); }
    return original(path, options);
  }); syncBuiltinESMExports();
  try {
    const manifest = await createOfficePackageManifest(root); assert.equal(replaced, true);
    assert.equal(manifest.version, '1.0.0'); assert.equal(manifest.files.find(file => file.path === 'package.json').sha256, hash(oldPackage));
    assert.equal(manifest.lockSha256, hash(oldLock)); assert.equal(manifest.files.find(file => file.path === 'package-lock.json').sha256, hash(oldLock));
    assert.equal(opens.get(pkg), 1); assert.equal(opens.get(lock), 1);
    await assert.rejects(verifyOfficePackageManifest(manifest, root), { message: 'OFFICE_PACKAGE_IDENTITY_MISMATCH' });
    assert.equal((await createOfficePackageManifest(root)).version, '2.0.0');
  } finally { listing.mock.restore(); reads.mock.restore(); syncBuiltinESMExports(); }
});

test('portable paths reject colon, backslash and control characters before local verification', { skip: process.platform === 'win32' }, async t => {
  for (const path of ['src/a:stream', 'src/a\u0001b', 'src/a\\b']) {
    const root = await fixture(t); await writeFile(join(root, path), 'fixture');
    await assert.rejects(createOfficePackageManifest(root), { message: 'OFFICE_PACKAGE_MANIFEST_INVALID' });
  }
});

test('missing entry, empty package identity and nonobject manifest files fail with named schema errors', async t => {
  const missing = await fixture(t, { entry: false });
  await assert.rejects(createOfficePackageManifest(missing), { message: 'OFFICE_PACKAGE_MANIFEST_INVALID' });
  const root = await fixture(t); await writeFile(join(root, 'package.json'), '{}');
  await assert.rejects(createOfficePackageManifest(root), { message: 'OFFICE_PACKAGE_MANIFEST_INVALID' });
  await writeFile(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  const valid = await createOfficePackageManifest(root);
  for (const value of [null, '', 1, [], {}]) {
    const { contentSha256: ignored, ...body } = { ...valid, files: [value] };
    await assert.rejects(verifyOfficePackageManifest({ ...body, contentSha256: hash(JSON.stringify(body)) }, root), { message: 'OFFICE_PACKAGE_MANIFEST_INVALID' });
  }
});

test('a reordered self-hashed body remains distinct while JSON serialization roundtrips', async t => {
  const root = await fixture(t), original = await createOfficePackageManifest(root), { contentSha256: ignored, ...body } = original;
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  await assert.rejects(verifyOfficePackageManifest({ ...reordered, contentSha256: hash(JSON.stringify(reordered)) }, root), { message: 'OFFICE_PACKAGE_IDENTITY_MISMATCH' });
  assert.equal((await verifyOfficePackageManifest(JSON.parse(JSON.stringify(original)), root)).status, 'verified');
});

test('all metadata and runtime files share the exact 20000-file and 256MiB admission budgets', async t => {
  const root = await fixture(t);
  for (let first = 0; first < 19996; first += 64) await Promise.all(Array.from({ length: Math.min(64, 19996 - first) }, (_, index) => writeFile(join(root, 'src', `f${first + index}`), '')));
  const manifest = await createOfficePackageManifest(root); assert.equal(manifest.files.length, 20000);
  assert.equal(manifest.totalBytes, manifest.files.reduce((total, file) => total + file.bytes, 0));
  assert.equal((await verifyOfficePackageManifest(manifest, root)).status, 'verified');
  await writeFile(join(root, 'src', 'one-extra'), ''); await assert.rejects(createOfficePackageManifest(root), { message: 'OFFICE_PACKAGE_LIMIT' });
  const small = await fixture(t); await truncate(join(small, 'README.md'), 256 * 1024 * 1024);
  await assert.rejects(createOfficePackageManifest(small), { message: 'OFFICE_PACKAGE_LIMIT' });
});

test('readers reject a changed or vanished named image after the final held-fd stat', async t => {
  for (const change of ['replace', 'vanish']) {
    const root = await fixture(t), target = join(root, 'README.md'), original = fs.open; let changed = false;
    const mocked = t.mock.method(fs, 'open', async (path, ...args) => {
      const handle = await original(path, ...args); if (path !== target) return handle;
      const stat = handle.stat.bind(handle); let calls = 0;
      handle.stat = async (...options) => { const info = await stat(...options); if (++calls === 2) { await rename(target, target + '.previous'); if (change === 'replace') await writeFile(target, 'peer replacement'); changed = true; } return info; }; return handle;
    }); syncBuiltinESMExports();
    try { await assert.rejects(createOfficePackageManifest(root), { message: 'OFFICE_PACKAGE_UNSAFE_ENTRY' }); assert.equal(changed, true); }
    finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  }
});

test('a file that grows after admission is read at most its admitted size plus one byte', async t => {
  const root = await fixture(t), target = join(root, 'README.md'), admitted = (await lstat(target)).size, original = fs.open;
  let total = 0, calls = 0;
  const mocked = t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await original(path, ...args); if (path !== target) return handle;
    const read = handle.read.bind(handle);
    handle.read = async (...options) => { if (!calls++) await fs.appendFile(target, Buffer.alloc(128 * 1024)); const result = await read(...options); total += result.bytesRead; return result; }; return handle;
  }); syncBuiltinESMExports();
  try { await assert.rejects(createOfficePackageManifest(root), { message: 'OFFICE_PACKAGE_UNSAFE_ENTRY' }); assert.ok(calls > 0); assert.ok(total <= admitted + 1); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('initial FIFO and hardlinked source images still fail regular single-link admission', { skip: process.platform !== 'linux' }, async t => {
  const fifo = await fixture(t), target = join(fifo, 'README.md'); await fs.unlink(target);
  const made = spawnSync('mkfifo', [target]); assert.ifError(made.error); assert.equal(made.status, 0);
  await assert.rejects(createOfficePackageManifest(fifo), { message: 'OFFICE_PACKAGE_UNSAFE_ENTRY' });
  const hard = await fixture(t); await link(join(hard, 'README.md'), join(hard, 'peer'));
  await assert.rejects(createOfficePackageManifest(hard), { message: 'OFFICE_PACKAGE_UNSAFE_ENTRY' });
});

test('a regular file replaced by an owned FIFO before open rejects without a writer or kill', { skip: process.platform !== 'linux' }, async t => {
  const root = await fixture(t), target = join(root, 'README.md');
  const code = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; import {spawnSync} from 'node:child_process'; import {pathToFileURL} from 'node:url';
    const [source,root,target]=process.argv.slice(1); process.argv=[process.execPath,'owned-fifo-fixes-probe']; const original=fs.open;
    fs.open=async(path,flags)=>{if(path===target){await fs.unlink(path);if(spawnSync('mkfifo',[path]).status!==0)throw Error('mkfifo failed');process.send({stage:'fifo-before-open'});}return original(path,flags);};
    syncBuiltinESMExports(); const {createOfficePackageManifest}=await import(pathToFileURL(source));
    try{await createOfficePackageManifest(root);process.send({stage:'result',code:'unexpected-success'});}catch(e){process.send({stage:'result',code:e.code??e.message});}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, source, root, target], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: true });
  observations.childrenStarted++; const messages = []; child.on('message', message => messages.push(message));
  let exited = false; const done = once(child, 'exit').then(value => { exited = true; observations.childrenExited++; return value; });
  const timer = setTimeout(() => { if (!exited) process.kill(-child.pid, 'SIGKILL'); }, 1500);
  try { assert.deepEqual(await done, [0, null]); assert.equal(messages[0]?.stage, 'fifo-before-open'); assert.deepEqual(messages[1], { stage: 'result', code: 'OFFICE_PACKAGE_UNSAFE_ENTRY' }); assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' }); }
  finally { clearTimeout(timer); if (!exited) { process.kill(-child.pid, 'SIGKILL'); await done; } }
});

test.after(() => {
  assert.equal(observations.rootsCreated, observations.rootsRemoved); assert.equal(observations.childrenStarted, observations.childrenExited);
  console.log('OFFICE_MANIFEST_FIXES_CLEANUP ' + JSON.stringify(observations));
});
