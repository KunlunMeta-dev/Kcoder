import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { MigrationSourceSessionOwner } from './migration-source-session-owner.js';
import { createMigrationSourceSessionLauncher } from './migration-source-session-launch.js';
import { normalizeServer } from './server-config.js';

// Explicit manual gate: ordinary deterministic Node tests never use a developer's
// default app-server binary, settings, history, credentials or workspace.
const binary = process.env.KCODER_MIGRATION_OWNER_NATIVE_BINARY;
test('actual dedicated Native lifecycle preserves refs, owns cleanup, and target recovery never bootstraps identity',
  { skip: !binary }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'kcoder-migration-source-owner-'));
    let httpRequests = 0, posts = 0;
    const observer = createServer((request, response) => {
      httpRequests++; if (request.method === 'POST') posts++;
      response.writeHead(503); response.end();
    });
    await new Promise(resolveListen => observer.listen(0, '127.0.0.1', resolveListen));
    const children = [], owners = [];
    t.after(async () => {
      for (const owner of owners) await owner.close();
      assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null), 'owned Native roots exited');
      assert.ok(owners.every(owner => owner.size === 0), 'actual close, not only exit, released every slot');
      await new Promise(done => observer.close(done));
      await rm(root, { recursive: true, force: false });
      await assert.rejects(access(root));
    });
    const endpoint = `http://127.0.0.1:${observer.address().port}/v1`;
    const settings = JSON.stringify({ credential_store: 'file', active_provider: 'isolated-source-owner',
      providers: { 'isolated-source-owner': { api_format: 'openai_chat_completions', endpoint,
        default_model: 'never-call-this-model', no_proxy: true, context_window_tokens: 128000,
        output_headroom_tokens: 8192, max_output_tokens: 8192 } } });
    async function fixture(name, seedFamilies = false) {
      const base = join(root, name), profile = join(base, 'profile'), workspace = join(base, 'workspace'), source = join(base, 'originals');
      for (const path of [base, profile, workspace, source]) await mkdir(path, { mode: 0o700 });
      const settingsFile = join(profile, 'settings.json');
      await writeFile(settingsFile, settings, { mode: 0o600 });
      const program = join(source, 'never-run.sh');
      await writeFile(program, 'printf invoked > "$0.marker"\n', { mode: 0o600 });
      const original = JSON.stringify({ model: 'inert-source-model', mcpServers: { inert: { command: 'sh', args: [program] } } });
      await writeFile(join(source, 'settings.json'), original, { mode: 0o600 });
      const histories = join(source, 'projects/project');
      await mkdir(histories, { mode: 0o700, recursive: true });
      for (let index = 0; index < 12; index++) {
        const id = randomUUID();
        await writeFile(join(histories, id + '.jsonl'), JSON.stringify({ type: 'user', uuid: 'message-0', sessionId: id,
          message: { role: 'user', content: 'Owned read-only history catalog fixture' } }) + '\n', { mode: 0o600 });
      }
      const codex = join(base, 'codex');
      const familyIds = Array.from({ length: 13 }, () => randomUUID());
      if (seedFamilies) {
        const sessions = join(codex, 'sessions/2026/10/18');
        await mkdir(sessions, { recursive: true, mode: 0o700 });
        for (const [index, id] of familyIds.entries()) {
          const path = join(sessions, `rollout-2026-10-18T00-00-00-${id}.jsonl`);
          const header = { type: 'session_meta', payload: { id, parent_thread_id: index ? familyIds[index - 1] : null } };
          await writeFile(path, JSON.stringify(header) + '\n', { mode: 0o600 });
          await utimes(path, 1000 + index, 1000 + index);
        }
      }
      const target = normalizeServer({ id: name, label: name, transport: 'local', settingsFile }, {
        repoRoot: workspace, appServerBin: resolve(binary), workspace,
      });
      const env = { PATH: process.env.PATH ?? '', HOME: base, USERPROFILE: base, KCODER_CONFIG_DIR: profile,
        CLAUDE_CONFIG_DIR: source, CODEX_HOME: codex, XDG_CONFIG_HOME: join(base, 'xdg-config'),
        XDG_DATA_HOME: join(base, 'xdg-data'), XDG_STATE_HOME: join(base, 'xdg-state'), XDG_CACHE_HOME: join(base, 'xdg-cache') };
      const launch = createMigrationSourceSessionLauncher({ baseEnv: env, trackChild: child => { children.push(child); return child; } });
      const owner = new MigrationSourceSessionOwner({ launch, initializeTimeoutMs: 15_000 }); owners.push(owner);
      const fingerprint = createHash('sha256').update(name).digest('hex');
      const captureCurrent = () => ({ ownerId: 'actual-owned-login', generation: 1,
        targetFingerprint: fingerprint, principal: { kind: 'localOs' } });
      return { owner, target, captureCurrent, profile, original, source, settingsFile, program, familyIds, codex };
    }
    const source = await fixture('source', true);
    const options = { sessionId: randomUUID(), purpose: 'source', target: source.target, captureCurrent: source.captureCurrent };
    const lease = await source.owner.open(options);
    assert.equal(children.length, 2, 'one ordinary probe and one negotiated dedicated Native');
    assert.strictEqual(await source.owner.open(options), lease);
    const discovered = await source.owner.request(options, 'migration/discover', { sources: ['claude-code'] });
    assert.ok(discovered.sources.some(item => item.scope === 'user'));
    const catalog = await source.owner.request(options, 'migration/history/discover', { source: 'claude-code' });
    assert.equal(catalog.items.length, 10); assert.equal(catalog.totalItems, 12);
    const rest = await source.owner.request(options, 'migration/history/sources', { catalogId: catalog.catalogId, cursor: catalog.nextCursor });
    assert.equal(rest.catalogId, catalog.catalogId); assert.equal(rest.items.length, 2);
    assert.equal(children.length, 2, 'paging uses the existing Native catalog and never launches another child');
    const family = await lease.request('migration/history/families/discover', { source: 'codex' });
    assert.equal(family.discoveryComplete, true);
    assert.equal(family.totalItems, 13);
    assert.deepEqual(family.items.map(row => row.sourceSessionId), source.familyIds.slice(0, 10));
    const familyRest = await lease.request('migration/history/sources', { catalogId: family.catalogId, cursor: family.nextCursor });
    assert.deepEqual(familyRest.items.map(row => row.sourceSessionId), source.familyIds.slice(10));
    const basic = await lease.request('migration/history/discover', { source: 'codex' });
    assert.equal(basic.items[0].sourceSessionId, source.familyIds.at(-1), 'basic mode keeps its newest-first order');
    assert.equal(children.length, 2, 'both modes and all pages retain the original source owner');
    const firstFamily = join(source.codex, 'sessions/2026/10/18', `rollout-2026-10-18T00-00-00-${source.familyIds[0]}.jsonl`);
    await writeFile(firstFamily, JSON.stringify({ type: 'session_meta', payload: { id: source.familyIds[0], parent_thread_id: randomUUID() } }) + '\n', { mode: 0o600 });
    await assert.rejects(lease.request('migration/history/sources', { catalogId: family.catalogId, cursor: null }),
      { reason: 'source_transfer_history_catalog_unavailable' });
    const identity = await lease.endpoint.request('identity', {});
    assert.equal(identity.chunkBytes, 128 * 1024);
    assert.equal(identity.authority.accountId.length, 64);
    const target = await fixture('target');
    const recovery = await target.owner.open({ sessionId: randomUUID(), purpose: 'target-recovery',
      target: target.target, captureCurrent: target.captureCurrent });
    const nativeIdentity = join(target.profile, 'migrations/source-transfer/native.json');
    await assert.rejects(access(nativeIdentity));
    await assert.rejects(recovery.endpoint.request('identity', {}));
    await assert.rejects(recovery.endpoint.request('peer/recover-target', { requestId: randomUUID() }));
    await assert.rejects(access(nativeIdentity));
    assert.equal(children.length, 4);
    assert.equal((await lease.release()).status, 'released');
    assert.equal((await recovery.release()).status, 'released');
    assert.equal(await readFile(source.settingsFile, 'utf8'), settings);
    assert.equal(await readFile(join(source.source, 'settings.json'), 'utf8'), source.original);
    await assert.rejects(access(source.program + '.marker'));
    await assert.rejects(access(target.program + '.marker'));
    assert.equal(httpRequests, 0); assert.equal(posts, 0);
  });
