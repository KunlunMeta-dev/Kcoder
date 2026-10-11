import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, {
  testId: 'owned-loopback-ssh-workspace-upload-exact-bytes', tier: 'full-integration',
  modelPolicy: 'model-independent real SSH Gateway/app-server file transport; native UI is covered separately',
}, async context => {
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'ssh-upload' });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', { max_retries: 0 });
  const ssh = await startSshFixture(context);
  const wrapper = context.pathInState('ssh', 'owned-kcoder');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(profile)}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'ssh-upload', label: 'Owned SSH upload',
    transport: 'ssh', host: '127.0.0.1', port: ssh.port, user: ssh.user, command: wrapper, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary,
    env: { ...ssh.gatewayEnv, KCODER_CONFIG_DIR: profile } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'ssh-upload', token));
  context.addCleanup('close owned SSH upload RPC', () => rpc.close());
  const initialized = await initializeRpc(rpc, 'owned-ssh-file-upload');
  assert.equal(initialized.capabilities.experimental.workspaceFileImportV1, true);
  const bytes = Buffer.from(Array.from({ length: 256 * 1024 + 37 }, (_, index) => index % 251));
  const filename = 'SSH 上传 binary.bin';
  const started = await rpc.request('attachment/upload/start', { filename, size: bytes.length });
  for (let offset = 0, index = 0; offset < bytes.length; offset += 192 * 1024, index++)
    await rpc.request('attachment/upload/chunk', { upload_id: started.upload_id, index, content_base64: bytes.subarray(offset, offset + 192 * 1024).toString('base64') });
  const staged = await rpc.request('attachment/upload/finish', { upload_id: started.upload_id });
  const receipt = await rpc.request('workspace/file/importAttachment', { attachmentPath: staged.path, parentPath: workspace, filename, overwrite: false });
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(receipt.status, 'uploaded'); assert.equal(receipt.size, bytes.length); assert.equal(receipt.sha256, expectedHash);
  assert.equal((await readFile(resolve(workspace, filename))).equals(bytes), true, 'SSH publication preserves all binary bytes');
  return { realLoopbackSsh: true, linuxDestination: true, bytes: bytes.length, sha256: expectedHash, exactDiskBytes: true };
});
