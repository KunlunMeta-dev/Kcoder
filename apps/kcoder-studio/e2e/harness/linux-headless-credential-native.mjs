import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';
import { headlessCredentialEnvironment, assertHeadlessPublic } from './linux-headless-credential-policy.mjs';

export async function verifyHeadlessNative(binary, expected) {
  assert.equal(process.platform, 'linux', 'headless_linux_required');
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'headless_frozen_binary_required');
  const stat = await lstat(binary);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 1024 ** 3, 'headless_native_file_required');
  const hash = createHash('sha256'); for await (const data of createReadStream(binary)) hash.update(data);
  assert.equal(hash.digest('hex'), expected, 'headless_native_hash_mismatch');
  const file = await open(binary, 'r'); const magic = Buffer.alloc(4);
  try { await file.read(magic, 0, 4, 0); } finally { await file.close(); }
  assert.equal(magic.equals(Buffer.from([127, 69, 76, 70])), true, 'headless_native_elf_required');
  return { sha256: expected, bytes: stat.size, platform: 'linux', newBuild: false };
}
export function headlessNativeOwner(context, { root, binary, values, runtime }) {
  const rows = [], live = new Set();
  return { rows,
    async start(label, profile) {
      context.pathInScratch(runtime, 'absent-session-bus.sock');
      const child = context.spawnOwned(label, binary, ['--settings-file', join(root, 'overlay.json'), '--cwd', join(root, 'workspace'), 'app-server'],
        { cwd: join(root, 'workspace'), env: headlessCredentialEnvironment(root, profile, runtime.path), stdin: 'pipe' });
      const row = { label, pid: child.pid, closed: false, exitCode: null }; rows.push(row);
      const client = new AppServerStdioClient(label, child, { defaultTimeoutMs: 15000 });
      const original = client.onLine.bind(client); let outputBytes = 0;
      client.onLine = line => {
        outputBytes += Buffer.byteLength(line);
        try { assert.ok(outputBytes <= 2 * 1024 * 1024, 'headless_native_output_budget'); assertHeadlessPublic(line, values); }
        catch { row.outputRejected = true; client.failPending(Error('headless_native_output_rejected')); return; }
        original(line);
      };
      let stderrBytes = 0, tail = '';
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length; const text = tail + chunk.toString('utf8');
        if (stderrBytes > 65536 || values.some(value => text.includes(value))) row.outputRejected = true;
        tail = text.slice(-128);
      });
      const owner = { row, client,
        raw: (method, params = {}) => client.request(method, params),
        async rpc(method, params = {}) {
          const frame = await client.request(method, params);
          if (frame.error) throw Error('headless_native_rpc_failed'); return frame.result;
        },
        async close() {
          if (row.closed) return;
          child.stdin.end(); const result = await waitForStdioChildClose(child, 15000, label);
          client.closeReader(); row.closed = true; row.exitCode = result.code; row.rpcRequests = client.methodsSent.length; live.delete(owner);
          assert.equal(result.code, 0, 'headless_native_exit_failed'); assert.equal(row.outputRejected, undefined, 'headless_native_output_rejected');
        },
      };
      live.add(owner);
      context.addCleanup('close owned Native stdio ' + label, () => owner.close());
      const initialized = await owner.rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-linux-headless-credentials', version: '1' } });
      for (const name of ['migrationBatchV1', 'migrationBatchMcpCredentialsV1'])
        assert.equal(initialized.capabilities.experimental[name], true, 'headless_native_update_required');
      return owner;
    },
    async close() { for (const owner of [...live]) await owner.close(); },
  };
}
