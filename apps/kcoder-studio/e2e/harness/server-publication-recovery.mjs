import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { startGateway } from './gateway.mjs';
import { login } from './http.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';

/** Real Gateway/configuration requests; no task, SSH connection or model is started. */
export async function serverPublicationRecovery(context) {
  assert.notEqual(process.platform, 'win32', 'directory fsync fixture requires POSIX');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'publication-recovery' });
  const evidence = [];
  for (const mode of ['matched', 'changed']) {
    const local = { id: 'local', label: 'Owned local', transport: 'local', runtime: 'kcoder', workspace };
    const peer = { id: 'owned-peer', label: 'Owned peer', transport: 'ssh', runtime: 'kcoder', host: 'peer.invalid' };
    const store = await context.writeStateJson(`${mode}/servers.json`, [local]);
    const data = context.pathInState(`${mode}/gateway`);
    await mkdir(data, { recursive: true, mode: 0o700 });
    const gateway = await startGateway(context, { label: `publication-${mode}`, auth: true, workspace,
      serversFile: store, serversStore: store, startTimeoutMs: 60_000,
      env: {
        KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_DATA_DIR: data,
        NODE_OPTIONS: `--import=${new URL('./settings-publication-fault.mjs', import.meta.url).href}`,
        KCODER_E2E_SETTINGS_PUBLICATION_FAULT: '1',
        KCODER_E2E_SETTINGS_PUBLICATION_ROOT: dirname(store), KCODER_E2E_SETTINGS_PUBLICATION_PATH: store,
        KCODER_E2E_SETTINGS_PUBLICATION_MODE: mode,
        KCODER_E2E_SETTINGS_PUBLICATION_PEER: JSON.stringify([local, peer]),
      } });
    const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
    const call = async (path, method = 'GET', body) => {
      const response = await fetch(gateway.baseUrl + path, { method, signal: AbortSignal.timeout(5000),
        headers: { cookie, origin: gateway.baseUrl, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    const target = id => ({ id, label: id, runtime: 'kcoder', transport: 'ssh', host: `${id}.invalid` });
    const first = await call('/api/servers/owned-a', 'PUT', target('owned-a'));
    const diskBefore = JSON.parse(await readFile(store, 'utf8')).map(row => row.id);
    const observed = await call('/api/servers');
    const second = await call('/api/servers/owned-b', 'PUT', target('owned-b'));
    const diskAfter = JSON.parse(await readFile(store, 'utf8')).map(row => row.id);
    const row = { mode, first, observed, second, diskBefore, diskAfter };
    evidence.push(row); await context.writeArtifactJson(`publication-observations-${mode}.json`, evidence);
    assert.equal(first.status, 409); assert.equal(first.body.code, 'CONFIG_FILE_PUBLISH_UNCONFIRMED');
    assert.equal(first.body.externalOutcome, 'unknown');
    if (mode === 'matched') {
      assert.ok(diskBefore.includes('owned-a'));
      assert.equal(second.status, 200);
      assert.ok(diskAfter.includes('owned-a'), 'B must not erase the already published A after a stale catalog GET');
      assert.ok(diskAfter.includes('owned-b'));
      assert.equal(observed.status, 200);
      assert.ok(observed.body.servers.some(server => server.id === 'owned-a'));
    } else {
      assert.equal(observed.status, 409, 'an unresolved projection must not masquerade as current authority');
      assert.equal(second.status, 409, 'later mutations stay blocked without a confirmed current snapshot');
      assert.deepEqual(diskAfter, diskBefore);
      assert.ok(diskAfter.includes('owned-peer'));
    }
    assert.equal(JSON.stringify([first.body, second.body]).includes('OWNED_DIRECTORY_SYNC_RECEIPT_LOST'), false);
  }
  return { assertions: { ok: true, modes: evidence.map(row => row.mode) }, modelRequests: 0, sshConnections: 0 };
}
