import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppServerStdioClient } from './app-server-stdio.mjs';

export const privatePrefix = 'migration/sourceTransfer/internal/';
export function privateNativeFailure(code, peer = false) {
  const error = new Error('private_windows_native_rpc_failed');
  error.code = peer ? 'WINDOWS_PRIVATE_PEER' : 'WINDOWS_PRIVATE_RPC';
  error.nativeRpcCode = [-32047, -32600, -32601, -32602, -32603].includes(code) ? code : null;
  return error;
}
export function privatePeerFrame(id, method, params, proof) {
  assert.equal(method, privatePrefix + 'peer/accept');
  assert.equal(proof?.version, 1); assert.equal(proof.requestId, params.requestId);
  return { jsonrpc: '2.0', id, method, params, kcoderPrivateMigrationSource: proof };
}
class PrivateStdio extends AppServerStdioClient {
  write(id, method, params, callback) {
    if (!this.peerProof) return super.write(id, method, params, callback);
    this.child.stdin.write(JSON.stringify(privatePeerFrame(id, method, params, this.peerProof)) + '\n', callback);
  }
  async accept(requestId, role, proof) {
    assert.equal(this.pending.size, 0); this.peerProof = proof;
    try { return await this.request(privatePrefix + 'peer/accept', { requestId, role }); }
    finally { this.peerProof = null; }
  }
}

export async function privateUntil(read, done, label) {
  const end = Date.now() + 30000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert.ok(Date.now() < end, `private_windows_deadline_${label}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

export function windowsPrivateNativeOwner({ binary, root, environment, values, spawnChild = spawn }) {
  const live = new Set(), processes = [];
  const inspect = text => { for (const value of values) assert.equal(text.includes(value), false, 'private_windows_output_value'); };
  return { processes,
    async start(name, profile, vendor, supplied = {}) {
      const workspace = join(root, 'workspace'), overlay = join(root, 'empty-overlay.json');
      await mkdir(workspace, { recursive: true });
      const env = { ...environment, HOME: root, USERPROFILE: root, KCODER_CONFIG_DIR: profile,
        APPDATA: root, LOCALAPPDATA: root, CODEX_HOME: vendor, CLAUDE_CONFIG_DIR: join(root, 'empty-claude'),
        XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'xdg-data'),
        XDG_STATE_HOME: join(root, 'xdg-state'), XDG_CACHE_HOME: join(root, 'xdg-cache'), ...supplied };
      // The suspended outer Node worker and all descendants stay in the original supervisor Job.
      const child = spawnChild(binary, ['--settings-file', overlay, '--cwd', workspace, 'app-server', '--migration-source-parent-local-v1'],
        { cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const row = { name, pid: child.pid, closed: false, exitCode: null }; processes.push(row);
      const closed = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
      let tail = '', outputBytes = 0, client;
      const fail = category => {
        const error = privateNativeFailure(); error.failureCategory = category;
        row.failureCategories ??= [];
        if (!row.failureCategories.includes(category)) row.failureCategories.push(category);
        if (client) { client.protocolFailure ??= error; client.failPending(client.protocolFailure); }
        return error;
      };
      child.on('error', () => fail('process-error'));
      child.stdin.on('error', () => fail('stdin-error'));
      child.stdout.on('error', () => fail('stdout-error'));
      child.stderr.on('error', () => fail('stderr-error'));
      child.stderr.on('data', data => {
        outputBytes += data.length;
        if (outputBytes > 65536) { row.outputBudgetExceeded = true; fail('stderr-budget'); return; }
        const text = tail + data.toString('utf8');
        for (const value of values) if (text.includes(value)) { row.outputLeak = true; fail('output-value'); }
        tail = text.slice(-Math.max(1, ...values.map(value => value.length)));
      });
      client = new PrivateStdio(name, child, { defaultTimeoutMs: 30000 });
      client.reader.on('error', () => fail('stdout-error'));
      const onLine = client.onLine.bind(client);
      client.onLine = line => {
        try { inspect(line); inspect(JSON.stringify(JSON.parse(line))); if (!client.protocolFailure) onLine(line); }
        catch { fail('output-or-protocol-value'); }
      };
      const write = client.write.bind(client);
      client.write = (id, method, params, callback) => {
        try { write(id, method, params, error => callback(error ? fail('stdin-error') : null)); }
        catch { callback(fail('stdin-error')); }
      };
      const owner = { client, child, row,
        async raw(method, params = {}) { return client.request(method, params); },
        async rpc(method, params = {}) {
          const frame = await client.request(method, params);
          if (frame.error) throw privateNativeFailure(frame.error.code);
          return frame.result;
        },
        async accept(requestId, role, proof) {
          const frame = await client.accept(requestId, role, proof);
          if (frame.error) throw privateNativeFailure(frame.error.code, true); return frame.result.peerRef;
        },
        async stop() {
          if (row.closed) return;
          try { child.stdin.end(); } catch { fail('stdin-error'); }
          let result, timer;
          try { result = await Promise.race([closed, new Promise((_, reject) => {
            timer = setTimeout(() => reject(privateNativeFailure()), 15000);
          })]); }
          catch { throw fail('close-unconfirmed'); }
          finally { clearTimeout(timer); }
          client.closeReader(); row.closed = true; row.exitCode = result.code; live.delete(owner);
          tail = '';
          row.requests = client.methodsSent.length;
          row.privatePrepareCalls = client.methodsSent.filter(method => method === privatePrefix + 'target/private/prepare').length;
          assert.equal(result.code, 0, 'private_windows_child_exit'); assert.equal(row.outputLeak, undefined);
          assert.equal(row.outputBudgetExceeded, undefined, 'private_windows_stderr_budget');
          if (row.failureCategories?.length) throw privateNativeFailure();
        },
      };
      live.add(owner);
      const initialized = await owner.rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-windows-private-credentials', version: '1' } });
      for (const name of ['migrationSourceTransferPrivateCredentialsV1', 'migrationSourceTransferPrivateCredentialBundlesV1', 'migrationSourceTransferPrivateCredentialPreparationsV1'])
        assert.equal(initialized.capabilities.experimental[name], true, 'private_windows_native_update_required');
      return owner;
    },
    async close() {
      const results = await Promise.allSettled([...live].map(owner => owner.stop()));
      assert.ok(results.every(result => result.status === 'fulfilled'), 'private_windows_children_not_closed');
    },
  };
}

export async function readPrivateFixture(path) {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 4096);
  return JSON.parse(await readFile(path, 'utf8'));
}
