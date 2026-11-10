//! Dedicated migration children never enter the shared workspace broker pool.
import { spawn } from 'node:child_process';
import { launchSpec, appServerEnvironment, workspaceReceiptParentAttempt } from './server-config.js';
import { createRuntimeTargetAdapter } from './runtime-target-adapter.js';
import { WorkspaceAppServerBroker } from './workspace-app-server-broker.js';
import { MigrationSourceBridgeError } from './migration-source-private.js';

const fail = reason => { throw new MigrationSourceBridgeError(reason); };

/** Trusted composition-root dependencies only. authenticate must retain the
 * existing managed-account entry and actual UID/principal verification. */
export function createMigrationSourceSessionLauncher({ spawnProcess = spawn, authenticate,
  trackChild = child => child, baseEnv = process.env, platform = process.platform, maxMessageBytes = 2 * 1024 * 1024 } = {}) {
  return async ({ target, workspacePath, phase, parentLaunchSupported = false, adopt, assertCurrent = () => {}, capturedScope }) => {
    if (!['probe', 'migration'].includes(phase) || typeof adopt !== 'function' || target?.runtime !== 'kcoder' ||
        !['local', 'ssh'].includes(target.transport)) fail('source_transfer_transport_unsupported');
    const managed = target.security !== undefined;
    if (managed && (typeof authenticate !== 'function' || !workspaceReceiptParentAttempt(target, platform))) {
      fail('source_transfer_authority_unavailable');
    }
    const migrationSourceParentV1 = !managed && phase === 'migration';
    assertCurrent();
    const spec = launchSpec(target, { workspacePath, platform, migrationSourceParentV1,
      migrationSourceTransferParentLaunchV1: parentLaunchSupported });
    const raw = spawnProcess(spec.command, spec.args, { cwd: spec.cwd,
      env: appServerEnvironment(baseEnv, spec.env), stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // Adoption precedes authentication/tracking callbacks and every later await.
    // If either callback fails, the owner still has the exact raw process handle.
    const resource = { child: raw, broker: null };
    raw.once('close', () => { resource.closed = true; });
    adopt(resource);
    raw.once('error', () => {});
    trackChild(raw, target, capturedScope);
    assertCurrent();
    const child = managed ? await authenticate(raw, { target, workspacePath, capturedScope }) : raw;
    assertCurrent();
    resource.broker = new WorkspaceAppServerBroker({ child, adapter: createRuntimeTargetAdapter('kcoder'),
      maxMessageBytes, serverId: target.id, targetTransport: target.transport, retentionParentV1: managed, migrationSourceParentV1 });
    return resource;
  };
}

function exited(resource) {
  return resource.closed === true;
}
async function waitClosed(resource, timeoutMs) {
  if (exited(resource)) return true;
  return new Promise(resolve => {
    const finish = value => { clearTimeout(timer); resource.child.off('close', close); resolve(value); };
    const close = () => { resource.closed = true; finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    resource.child.once('close', close);
    if (exited(resource)) finish(true);
  });
}

/** Cleanup outcome only: an observed process exit says nothing about the
 * transfer's receipt/cancellation result, which remains authoritative in Native. */
export async function terminateMigrationSourceSessionChild(resource, { eofMs = 500, graceMs = 500, killMs = 500 } = {}) {
  if (exited(resource)) return { status: 'stopped' };
  const child = resource.child;
  try { if (child.stdin?.writable && !child.stdin.destroyed) child.stdin.end(); } catch { /* Keep the owned handle. */ }
  // Let Native observe EOF and close its own helpers before terminating the root.
  // Windows descendants may still hold its pipes after an immediate TerminateProcess.
  if (await waitClosed(resource, eofMs)) return { status: 'stopped' };
  try { child.kill('SIGTERM'); } catch { /* Actual close remains required. */ }
  if (await waitClosed(resource, graceMs)) return { status: 'stopped' };
  try { child.kill('SIGKILL'); } catch { /* Never substitute process-name cleanup. */ }
  return { status: await waitClosed(resource, killMs) ? 'stopped' : 'unknown' };
}
