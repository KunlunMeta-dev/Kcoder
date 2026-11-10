import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { repoRoot, waitFor } from './run-context.mjs';
import { shellQuote } from './physical-widget-ssh.mjs';
import { reservePort } from './ssh-fixture.mjs';

/** Uses the checked source without touching the production Octop profile or process. */
export async function startOctopReference(context) {
  assert.equal(process.env.KCODER_E2E_OCTOP_REFERENCE_SSH, 'H20-8_user', 'Explicit reference host gate required');
  const source = await readFile(`${repoRoot}/apps/kcoder-studio/e2e/harness/fixtures/owned-octop-reference.py`, 'utf8');
  const inner = `/data/nvme2/cyx/Octop/.venv/bin/python -u -c ${shellQuote(source)}`;
  const remote = `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ServerAliveInterval=5 -o ServerAliveCountMax=2 root@localhost ${shellQuote(inner)}`;
  const options = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];
  const child = context.spawnOwned('octop-reference', '/usr/bin/ssh', [...options, 'H20-8_user', remote], { stdin: 'pipe', env: process.env });
  const frames = [];
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', line => { try { frames.push(JSON.parse(line)); } catch { /* Source startup logs are retained by RunContext. */ } });
  context.addCleanup('close isolated Octop reference and verify remote deletion', async () => {
    child.stdin.end();
    await waitFor(() => frames.some(frame => frame.cleaned === true), 25000, 'Octop reference cleanup acknowledgement');
    await waitFor(() => child.exitCode !== null, 5000, 'Octop reference SSH exit');
    assert.equal(child.exitCode, 0);
  });
  await waitFor(() => { assert.equal(child.exitCode, null, 'Reference exited before readiness'); return frames.some(frame => frame.ready === true); }, 60000, 'Octop reference readiness');
  const ready = frames.find(frame => frame.ready === true);
  assert.equal(ready.revision, 'dd9dce470844c25d59effb50615bb3c667ea25cd');
  assert.match(ready.root, /^\/tmp\/kcoder-octop-reference-[a-zA-Z0-9_-]+$/);
  assert.ok(Number.isSafeInteger(ready.port) && ready.port > 0 && ready.port < 65536);
  const reservation = await reservePort('127.0.0.1');
  context.registerPort('octop-reference-tunnel', reservation.port);
  await reservation.release();
  context.spawnOwned('octop-reference-tunnel', '/usr/bin/ssh', [...options, '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${reservation.port}:127.0.0.1:${ready.port}`, 'H20-8_user'], { env: process.env });
  const baseUrl = `http://127.0.0.1:${reservation.port}`;
  await waitFor(async () => { try { return (await fetch(`${baseUrl}/api/setup/status`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, 15000, 'Octop reference tunnel');
  const post = async (path, body, token) => {
    const response = await fetch(`${baseUrl}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok, `Reference ${path} failed ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const status = await (await fetch(`${baseUrl}/api/setup/status`)).json();
  if (!status.database_bound) await post('/setup/database', { driver: 'sqlite' });
  const wizard = await post('/setup/begin', {}); context.registerSecret(wizard.wizard_token);
  const password = randomBytes(24).toString('base64url'); context.registerSecret(password);
  const user = await post('/setup/initial-admin', { username: 'owned-reference', password, locale: 'zh' }, wizard.wizard_token); context.registerSecret(user.access_token);
  await post('/setup/finish', {}, wizard.wizard_token);
  return { baseUrl, token: user.access_token, revision: ready.revision, indexSha256: ready.indexSha256, post: (path, body) => post(path, body, user.access_token) };
}
