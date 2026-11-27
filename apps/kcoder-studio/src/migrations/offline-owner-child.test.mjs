import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { acquireStorageInstance, loadStorageNative } from '../storage-lease.mjs';
import { loadStorageContext } from '../storage-paths.mjs';
import { createOfflineOwnerProtocol, runOfflineOwnerChild } from './offline-owner-child.mjs';

const ownFile = fileURLToPath(import.meta.url);
const PRIMARY = 'kcoder-storage-writers.lock';
const SECONDARY = 'kcoder-storage-instances.lock';

if (process.argv[2] === '--owned-child') {
  const protocol = createOfflineOwnerProtocol();
  try {
    await runOfflineOwnerChild({ protocol, run: async (payload, { operationId, validateOffline }) => {
      assert.equal(validateOffline({ domain: 'owned-fixture', operationId, source: payload.source, finalTarget: payload.finalTarget }), true);
      writeFileSync(payload.business, 'written after fresh parent validation');
      protocol.write({ type: 'fixtureAlive', version: 1, operationId, nodePid: process.pid });
      if (payload.pauseMs) await new Promise(resolve => setTimeout(resolve, payload.pauseMs));
      return { verified: true };
    } });
  } catch (error) {
    protocol.write({ type: 'failed', code: error.code ?? 'STORAGE_OFFLINE_CHILD_FAILED' });
    process.exitCode = 1;
  }
} else {
  async function owned(t) {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'offline-child-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const root = join(home, 'Data'), finalTarget = join(home, 'Target');
    await mkdir(root); await mkdir(finalTarget);
    const native = await loadStorageNative();
    const primary = native.tryExclusive(root, PRIMARY, false);
    assert.ok(primary);
    t.after(() => native.close(primary));
    const secondary = native.tryShared(root, SECONDARY, false);
    assert.ok(secondary); native.close(secondary);
    const identity = async path => {
      const info = await stat(path, { bigint: true });
      return JSON.stringify({ device: String(info.dev), inode: String(info.ino) });
    };
    const fact = { root, directoryIdentity: await identity(root), primaryIdentity: await identity(join(root, PRIMARY)),
      secondaryIdentity: await identity(join(root, SECONDARY)) };
    const business = join(root, 'business.txt'); await writeFile(business, 'original');
    return { home, root, finalTarget, business, fact, native, primary };
  }

  async function child(t, fixture, { pauseMs = 0, roots = [fixture.fact] } = {}) {
    const processChild = spawn(process.execPath, [ownFile, '--owned-child'], { stdio: ['pipe', 'pipe', 'pipe'] });
    processChild.stdin.on('error', () => {});
    let stderr = '';
    processChild.stderr.setEncoding('utf8'); processChild.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    const exit = once(processChild, 'exit');
    t.after(async () => {
      processChild.stdin.destroy();
      if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGKILL');
      await exit;
    });
    const reader = createInterface({ input: processChild.stdout })[Symbol.asyncIterator]();
    const next = async () => {
      let timer;
      try {
        const frame = await Promise.race([reader.next(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('offline fixture deadline: ' + stderr)), 10000);
        })]);
        assert.equal(frame.done, false, stderr);
        return JSON.parse(frame.value);
      } finally { clearTimeout(timer); }
    };
    const send = frame => processChild.stdin.write(JSON.stringify(frame) + '\n');
    const approve = frame => send({ type: 'validated', version: 1, operationId: frame.operationId, sequence: frame.sequence });
    send({ type: 'initialize', version: 1, operationId: 'owned-operation', roots,
      payload: { source: fixture.root, finalTarget: fixture.finalTarget, business: fixture.business, pauseMs } });
    return { process: processChild, exit, next, send, approve };
  }

  test('secondary remains exclusive after parent pipe EOF until the actual child exits', async t => {
    const f = await owned(t), c = await child(t, f, { pauseMs: 30000 });
    let calls = 0;
    while (true) {
      const frame = await c.next();
      if (frame.type === 'validateFences' || frame.type === 'validateOffline') { calls++; c.approve(frame); }
      else if (frame.type === 'fixtureAlive') break;
      else assert.equal(frame.type, 'ready');
    }
    assert.equal(calls, 4);
    f.native.close(f.primary);
    c.process.stdin.end();
    const selected = await loadStorageContext({ home: f.home, consumer: 'cli', env: {
      KCODER_HOME: f.root, KCODER_CACHE_DIR: join(f.home, 'Cache'),
    } });
    await assert.rejects(acquireStorageInstance(selected, { native: f.native }), { code: 'STORAGE_MIGRATION_BUSY' });
    const primary = f.native.tryExclusive(f.root, PRIMARY, false);
    assert.ok(primary, 'the original primary is released; the child fence still independently blocks startup');
    f.native.close(primary);
    assert.equal(f.native.trySharedExisting(f.root, SECONDARY), null);
    assert.equal(await readFile(f.business, 'utf8'), 'written after fresh parent validation');
    c.process.kill('SIGKILL'); await c.exit;
    const instance = await acquireStorageInstance(selected, { native: f.native });
    try { instance.verify(); } finally { instance.close(); }
  });

  test('rejection after ready prevents every business read and write', async t => {
    const f = await owned(t), c = await child(t, f);
    for (let index = 0; index < 2; index++) {
      const frame = await c.next(); assert.equal(frame.type, 'validateFences'); c.approve(frame);
    }
    assert.equal((await c.next()).type, 'ready');
    const final = await c.next(); assert.equal(final.type, 'validateFences');
    c.send({ type: 'rejected', version: 1, operationId: final.operationId, sequence: final.sequence });
    assert.equal((await c.next()).type, 'failed');
    assert.equal((await c.exit)[0], 1);
    assert.equal(await readFile(f.business, 'utf8'), 'original');
  });

  test('parent loss before guard acquisition leaves business untouched', async t => {
    const f = await owned(t), c = await child(t, f);
    assert.equal((await c.next()).type, 'validateFences');
    c.process.stdin.end();
    assert.equal((await c.next()).code, 'STORAGE_OFFLINE_PARENT_UNAVAILABLE');
    assert.equal((await c.exit)[0], 1);
    assert.equal(await readFile(f.business, 'utf8'), 'original');
    const secondary = f.native.tryExclusive(f.root, SECONDARY, false);
    assert.ok(secondary); f.native.close(secondary);
  });

  for (const [stage, acceptedValidations, expectedBusiness] of [
    ['after guard acquisition before ready', 1, 'original'],
    ['after ready before final fences', 2, 'original'],
    ['before domain authorization', 3, 'original'],
    ['after owner output before completion', 4, 'written after fresh parent validation'],
  ]) {
    test(`parent EOF ${stage} cannot announce completion or replay owner writes`, async t => {
      const f = await owned(t), c = await child(t, f);
      const frames = [];
      let approved = 0;
      while (approved < acceptedValidations) {
        const frame = await c.next(); frames.push(frame);
        assert.equal(frame.operationId, 'owned-operation');
        if (frame.type === 'ready') continue;
        assert.ok(['validateFences', 'validateOffline'].includes(frame.type));
        assert.equal(frame.sequence, ++approved);
        c.approve(frame);
      }
      c.process.stdin.end();
      let failed;
      while (!failed) {
        const frame = await c.next(); frames.push(frame);
        if (frame.type === 'failed') failed = frame;
        else assert.equal(frame.operationId, 'owned-operation');
      }
      assert.equal(failed.code, 'STORAGE_OFFLINE_PARENT_UNAVAILABLE');
      assert.equal((await c.exit)[0], 1);
      assert.equal(frames.some(frame => frame.type === 'completed'), false);
      assert.equal(await readFile(f.business, 'utf8'), expectedBusiness);
      const secondary = f.native.tryExclusive(f.root, SECONDARY, false);
      assert.ok(secondary, 'the original child exits and releases its independent fence');
      f.native.close(secondary);
    });
  }

  test('missing source roots are never created by the child', async t => {
    const f = await owned(t), missing = join(f.home, 'Missing');
    const c = await child(t, f, { roots: [{ ...f.fact, root: missing }] });
    const first = await c.next(); assert.equal(first.type, 'validateFences'); c.approve(first);
    assert.equal((await c.next()).type, 'failed');
    assert.equal((await c.exit)[0], 1);
    await assert.rejects(stat(missing), { code: 'ENOENT' });
    assert.equal(await readFile(f.business, 'utf8'), 'original');
  });

  test('ancestor secondary checks apply only where an actual primary is registered', async t => {
    const f = await owned(t);
    f.native.close(f.primary);
    const secondary = f.native.tryExclusive(f.root, SECONDARY, false);
    assert.ok(secondary);
    const selected = await loadStorageContext({ home: f.home, consumer: 'cli', env: {
      KCODER_HOME: join(f.root, 'Nested'), KCODER_CACHE_DIR: join(f.home, 'NestedCache'),
    } });
    try {
      await assert.rejects(acquireStorageInstance(selected, { native: f.native }), { code: 'STORAGE_MIGRATION_BUSY' });
    } finally { f.native.close(secondary); }
    const instance = await acquireStorageInstance(selected, { native: f.native }); instance.close();
    const unrelated = f.native.tryExclusive(f.home, SECONDARY, false);
    assert.ok(unrelated);
    try {
      const allowed = await acquireStorageInstance(selected, { native: f.native }); allowed.close();
    } finally { f.native.close(unrelated); }
  });

  test('fixed storage lock names reject nonempty private user payloads without changing them', async t => {
    const f = await owned(t);
    f.native.close(f.primary);
    for (const name of ['kcoder-storage.lock', PRIMARY, SECONDARY]) {
      const root = join(f.home, name + '-root'); await mkdir(root);
      const path = join(root, name);
      const initial = f.native.tryShared(root, name, false);
      assert.ok(initial); f.native.close(initial);
      await writeFile(path, 'unknown persistent payload');
      assert.throws(() => f.native.tryShared(root, name, false));
      assert.throws(() => f.native.tryExclusive(root, name, false));
      assert.equal(await readFile(path, 'utf8'), 'unknown persistent payload');
    }
  });
}
