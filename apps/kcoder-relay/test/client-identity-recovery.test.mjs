import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const relayUrl = 'https://relay.example.test';
const gatewaySecret = 'owned-fixture-gateway-secret-0123456789';
const secret = 'owned-fixture-client-secret-0123456789';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-identity-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'apps/kcoder-relay/src/client-identity.mjs');
  await mkdir(dirname(source), { recursive: true, mode: 0o700 });
  await copyFile(new URL('../src/client-identity.mjs', import.meta.url), source);
  const previous={XDG_STATE_HOME:process.env.XDG_STATE_HOME,LOCALAPPDATA:process.env.LOCALAPPDATA};
  process.env.XDG_STATE_HOME=join(root,'durable-state');process.env.LOCALAPPDATA=join(root,'durable-state');
  let api;try{api=await import(pathToFileURL(source).href);}finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  async function create(identityFile, registered = true) {
    await mkdir(dirname(identityFile),{recursive:true,mode:0o700});
    const record={version:1,relayOrigin:relayUrl,gatewaySecretHash:createHash('sha256').update(gatewaySecret).digest('hex'),
      ...(registered?{id:'owned-fixture',secret}:{enrollmentToken:'owned-fixture-original-proof-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'})};
    await writeFile(identityFile,JSON.stringify(record)+'\n',{mode:0o600,flag:'wx'});
  }
  return { root, api, source, create };
}

for (const registered of [false, true]) {
  test(`self-adoption preserves the only ${registered ? 'registered identity' : 'pending proof'}`, async t => {
    const f = await fixture(t), identityFile = f.api.DEFAULT_IDENTITY_FILE;
    await f.create(identityFile, registered);
    const bytes = await readFile(identityFile), before = await stat(identityFile);
    assert.equal(await f.api.prepareInstanceIdentityFile({ legacyIdentityFile: identityFile, relayUrl, gatewaySecret }), identityFile);
    assert.deepEqual(await readFile(identityFile), bytes);
    assert.equal((await stat(identityFile)).ino, before.ino);
    assert.equal((await stat(identityFile)).nlink, 1);
    await assert.rejects(f.api.prepareInstanceIdentityFile({ legacyIdentityFile: identityFile, relayUrl,
      gatewaySecret: 'different-fixture-gateway-secret-0123456789' }), /different Gateway/);
    assert.deepEqual(await readFile(identityFile), bytes);
  });
}

test('a parent-directory alias cannot delete the current identity', async t => {
  const f = await fixture(t), stateDirectory = join(f.root, 'state');
  const identityFile = f.api.resolveIdentityFile({}, stateDirectory);
  await f.create(identityFile);
  const bytes = await readFile(identityFile);
  const alias = join(f.root, 'legacy-alias');
  await symlink(dirname(identityFile), alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await f.api.prepareInstanceIdentityFile({ stateDirectory,
    legacyIdentityFile: join(alias, 'client-identity.json'), relayUrl, gatewaySecret }), identityFile);
  assert.deepEqual(await readFile(identityFile), bytes);
  assert.equal((await stat(identityFile)).nlink, 1);
});

test('a genuine interrupted two-link relocation still removes only the legacy entry', async t => {
  const f = await fixture(t), stateDirectory = join(f.root, 'state');
  const legacyIdentityFile = join(f.root, 'legacy/client-identity.json');
  await f.create(legacyIdentityFile);
  const identityFile = f.api.resolveIdentityFile({}, stateDirectory), bytes = await readFile(legacyIdentityFile);
  await mkdir(dirname(identityFile), { recursive: true, mode: 0o700 });
  await link(legacyIdentityFile, identityFile);
  await f.api.prepareInstanceIdentityFile({ stateDirectory, legacyIdentityFile, relayUrl, gatewaySecret });
  assert.deepEqual(await readFile(identityFile), bytes);
  assert.equal((await stat(identityFile)).nlink, 1);
  await assert.rejects(stat(legacyIdentityFile), { code: 'ENOENT' });
});

test('omitting a legacy path never adopts the unrelated default identity', async t => {
  const f = await fixture(t);
  await f.create(f.api.DEFAULT_IDENTITY_FILE);
  const bytes = await readFile(f.api.DEFAULT_IDENTITY_FILE), stateDirectory = join(f.root, 'state');
  const destination = f.api.resolveIdentityFile({}, stateDirectory);
  assert.equal(await f.api.prepareInstanceIdentityFile({ stateDirectory, relayUrl, gatewaySecret }), destination);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.api.DEFAULT_IDENTITY_FILE), bytes);
  assert.equal((await stat(f.api.DEFAULT_IDENTITY_FILE)).nlink, 1);
});

test('invalid explicit legacy paths fail before touching the default identity', async t => {
  const f = await fixture(t);
  await f.create(f.api.DEFAULT_IDENTITY_FILE);
  const bytes = await readFile(f.api.DEFAULT_IDENTITY_FILE), stateDirectory = join(f.root, 'state');
  for (const legacyIdentityFile of ['', false, null, 0, {}, []]) {
    await assert.rejects(f.api.prepareInstanceIdentityFile({ stateDirectory, legacyIdentityFile, relayUrl, gatewaySecret }), /Invalid legacy client identity path/);
    await assert.rejects(stat(f.api.resolveIdentityFile({}, stateDirectory)), { code: 'ENOENT' });
    assert.deepEqual(await readFile(f.api.DEFAULT_IDENTITY_FILE), bytes);
  }
});

test('identity reads reject a FIFO without waiting for a writer', { skip: process.platform === 'win32' ? 'FIFO requires a POSIX host' : false }, async t => {
  const f = await fixture(t), identityFile = join(f.root, 'identity.fifo');
  await run('mkfifo', [identityFile]);
  const script = `import { readRegisteredClientIdentity } from ${JSON.stringify(pathToFileURL(f.source).href)};
    try { await readRegisteredClientIdentity({ identityFile: ${JSON.stringify(identityFile)}, relayUrl: ${JSON.stringify(relayUrl)}, gatewaySecret: ${JSON.stringify(gatewaySecret)} });
      process.exitCode = 1; } catch (error) { console.log(error.message); }`;
  const result = await run(process.execPath, ['--input-type=module', '-e', script], { timeout: 2000 });
  assert.match(result.stdout, /Client identity must be a regular file/);
});

test('a symbolic identity file is rejected without consuming its target', async t => {
  const f = await fixture(t), target = join(f.root, 'target.json'), identityFile = join(f.root, 'linked.json');
  await f.create(target);
  const bytes = await readFile(target);
  await symlink(target, identityFile, 'file');
  await assert.rejects(f.api.readRegisteredClientIdentity({ identityFile, relayUrl, gatewaySecret }), /Client identity must be a regular file/);
  assert.deepEqual(await readFile(target), bytes);
});

test('a damaged persisted origin reports identity corruption without configuration advice', async t => {
  const f = await fixture(t), identityFile = join(f.root, 'identity.json');
  await f.create(identityFile);
  const record = JSON.parse(await readFile(identityFile, 'utf8'));
  for (const relayOrigin of ['', 'not-a-url', 'https://example.test/path']) {
    const bytes = JSON.stringify({ ...record, relayOrigin });
    await writeFile(identityFile, bytes, { mode: 0o600 });
    await assert.rejects(f.api.readRegisteredClientIdentity({ identityFile, relayUrl, gatewaySecret }), /^Error: Invalid client identity relay origin$/);
    assert.equal(await readFile(identityFile, 'utf8'), bytes);
  }
});
