import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import { createShortStorageTarget, modelConfigurationSnapshot, prepareWindowsStorageHistory, seedWindowsStorageClientState, validateWindowsStorageVolume } from './windows-storage-relocation.mjs';

test('only the explicit old-client policy accepts a volatile draft and retains history/image/Cookie obligations', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'storage-old-client-draft-policy', tier: 'harness-unit', variantId: 'old-client-draft-policy',
    modelPolicy: 'controlled RPC and editor contract fixture only; no product, Windows account, native authority or model' });
  let failure;
  try {
    const source = { dataRoot: context.pathInState('native') }, request = { owner: randomUUID() };
    await mkdir(source.dataRoot); await writeFile(join(source.dataRoot, 'settings.json'), '{"providers":{}}');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
    const imageSha = createHash('sha256').update(image).digest('hex');
    const methods = [], cookies = []; let typed = '', persistentReads = 0;
    const flow = { request, renderer: { request: async (method, params) => {
      if (method === 'Network.setCookie') { cookies.push(params); return { success: true }; }
      assert.equal(method, 'Input.insertText'); typed = params.text;
    } }, evaluate: async (_client, expression) => {
      if (expression.includes('new WebSocket')) return true;
      const call = expression.match(/^window\.__kcoderOwnedStorageRpc\.request\((.*)\)$/s);
      if (call) {
        const [method, params] = JSON.parse('[' + call[1] + ']'); methods.push({ method, params });
        const values = {
          'runtime.providers.list': { profiles: [] },
          'migration/history/discover': { catalogId: 'catalog', items: [{ sourceHandle: 'source' }] },
          'migration/history/create': { job: { sequence: 7 } },
          'migration/history/run': {}, 'migration/history/read': { workerRunning: false, job: { stage: 'normalized' } },
          'migration/history/transcript': { items: [{}, {}, {}] }, 'migration/history/attachment/run': {},
          'migration/history/attachment/read': { workerRunning: false, job: { stage: 'ready' } },
          'migration/history/attachment/chunk': { nextOffset: null, dataBase64: image.toString('base64'), dataSha256: imageSha, receipt: { sha256: imageSha } },
        };
        assert.ok(Object.hasOwn(values, method)); return values[method];
      }
      if (expression === 'location.origin') return 'http://127.0.0.1:12345';
      if (expression.includes('Object.keys(localStorage)')) { persistentReads++; return null; }
      if (expression.includes('?.textContent===')) return expression.endsWith(JSON.stringify(typed));
      assert.ok(expression.includes('kcoderDesktopMenu.list') || expression.includes('chat-message-input')); return true;
    }, until: async predicate => { const value = await predicate(); if (!value) throw Error('Old renderer has no persisted composer draft'); return value; } };
    const state = await seedWindowsStorageClientState(flow, { source, target: source, profileIdentityFile: null, persistedDraft: false });
    assert.equal(state.draftState, null); assert.equal(state.persistedDraft, false); assert.equal(persistentReads, 0);
    assert.equal(typed, `STORAGE_UNSENT_DRAFT_${request.owner}`); assert.equal(state.transcriptCount, 3);
    assert.equal(state.attachment.sha256, imageSha); assert.equal(cookies.length, 1); assert.equal(cookies[0].httpOnly, true);
    assert.deepEqual(methods.find(row => row.method === 'migration/history/run').params, { jobId: request.owner, expectedSequence: 7 });
    await assert.rejects(seedWindowsStorageClientState(flow, { source, target: source, profileIdentityFile: null }), /Old renderer has no persisted composer draft/);
    assert.equal(persistentReads, 1, 'The current-client default must keep its strict persistence requirement');
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { explicitOldPolicyOnly: true, modelCalls: 0 }, failure); }
});

test('model configuration comparison retains actual selection while ignoring runtime receipts', () => {
  const profile = { id: 'Owned', model: 'saved-model', endpoint: 'http://127.0.0.1', apiFormat: 'openai',
    extraBody: { second: 2, first: { b: 1, a: 2 } }, apiKeyConfigured: false, isDefault: true };
  const before = modelConfigurationSnapshot({ profiles: [profile], revision: 'original', supportsModelDiscovery: false });
  assert.deepEqual(modelConfigurationSnapshot({ profiles: [{ ...profile, connectionCheck: { stage: 'unknown' }, fileSources: { model: ['user'] },
    extraBody: { first: { a: 2, b: 1 }, second: 2 } }], revision: 'later', supportsModelDiscovery: true }), before);
  for (const patch of [{ id: 'other' }, { model: 'other' }, { endpoint: 'http://127.0.0.2' }, { apiKeyConfigured: true }, { isDefault: false }])
    assert.notDeepEqual(modelConfigurationSnapshot({ profiles: [{ ...profile, ...patch }] }), before);
  assert.deepEqual(modelConfigurationSnapshot({ profiles: [] }), []);
  assert.throws(() => modelConfigurationSnapshot({}));
});

test('owned volume receipt cannot adopt another account, owner, disk or destination', () => {
  const owner = randomUUID(), qaSid = 'S-1-5-21-1-2-3-1008';
  const receipt = { version: 1, owner, qaSid, root: 'D:\\', dataRoot: `D:\\kcoder-storage-${owner}\\data`, cacheRoot: `D:\\kcoder-storage-${owner}\\cache`, volumeSerialNumber: '89abcdef' };
  const scope = { owner, qaSid, sourceRoot: 'C:\\owned\\data' };
  assert.deepEqual(validateWindowsStorageVolume(receipt, scope), { dataRoot: receipt.dataRoot, cacheRoot: receipt.cacheRoot });
  for (const patch of [{ owner: randomUUID() }, { qaSid: 'peer' }, { root: 'C:\\' }, { root: 'D:\\peer\\' }, { dataRoot: 'D:\\peer\\data' }, { cacheRoot: 'E:\\foreign' }, { volumeSerialNumber: 'not-a-serial' }])
    assert.throws(() => validateWindowsStorageVolume({ ...receipt, ...patch }, scope));
});

test('storage history seed writes vendor input once and never creates Native history or authority', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'storage-owned-vendor-history', tier: 'harness-unit', modelPolicy: 'vendor fixture generation only; no product, account or model' });
  let failure;
  try {
    const profile = { userProfile: context.pathInState('fixture-user') }, request = { owner: randomUUID() }, workspace = context.pathInState('fixture-workspace');
    await prepareWindowsStorageHistory({ request, profile, workspace });
    const file = join(profile.userProfile, '.claude/projects/storage-owned-acceptance', request.owner + '.jsonl');
    const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 3); assert.ok(rows.every(row => row.sessionId === request.owner && row.cwd === workspace));
    assert.match(rows[0].message.content, /^STORAGE_OWNED_HISTORY_/);
    assert.equal(rows[1].message.content[0].source.media_type, 'image/png');
    assert.ok(Buffer.from(rows[1].message.content[0].source.data, 'base64').length > 60);
    assert.deepEqual(await readdir(profile.userProfile), ['.claude']);
    await assert.rejects(prepareWindowsStorageHistory({ request, profile, workspace }), { code: 'EEXIST' });
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { vendorInputOnly: true, modelCalls: 0 }, failure); }
});

for (const accepted of [true, false]) test(`short storage targets ${accepted ? 'remove accepted owned data' : 'retain unknown effects'}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-target-')), cleanups = [];
  try {
    const context = { seed: randomUUID().replaceAll('-', '').slice(0, 16), addCleanup: (_name, cleanup) => cleanups.push(cleanup),
      pathInArtifacts: name => join(root, name) };
    const target = await createShortStorageTarget(context, root, 'owned-sid', () => accepted);
    await writeFile(join(target.data, 'new-data'), 'preserve unknown effects');
    await cleanups[0]();
    assert.equal(JSON.parse(await readFile(join(root, 'short-storage-target-cleanup.json'), 'utf8')).removed, accepted);
    if (accepted) await assert.rejects(lstat(target.root), { code: 'ENOENT' });
    else assert.equal(await readFile(join(target.data, 'new-data'), 'utf8'), 'preserve unknown effects');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('short storage target cleanup rejects a replaced owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-target-')), cleanups = [];
  try {
    const context = { seed: randomUUID().replaceAll('-', '').slice(0, 16), addCleanup: (_name, cleanup) => cleanups.push(cleanup), pathInArtifacts: name => join(root, name) };
    const target = await createShortStorageTarget(context, root, 'owned-sid', () => true);
    await writeFile(join(target.root, '.owner.json'), JSON.stringify({ owner: randomUUID(), sid: 'owned-sid' }));
    await assert.rejects(cleanups[0]());
    assert.ok((await lstat(target.root)).isDirectory());
  } finally { await rm(root, { recursive: true, force: true }); }
});
