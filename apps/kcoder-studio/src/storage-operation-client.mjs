import { execFile, spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

const ENTRY = '--internal-storage-operation-v1';
const RELAUNCH_ENV = 'KCODER_STORAGE_DESKTOP_RELAUNCH_V1';
const OWNER_RUNTIME_ENV = 'KCODER_STORAGE_OWNER_RUNTIME_V1';
const LIMIT = 1024 * 1024;
const CREDENTIAL_PREVIEW_FAILURES = new Set([
  'CREDENTIAL_RELOCATION_KEYRING_UNAVAILABLE',
  'CREDENTIAL_RELOCATION_KEYRING_ENTRY_MISSING',
  'CREDENTIAL_RELOCATION_KEYRING_POLICY_BLOCKED',
]);
const SAFE_PREVIEW_FAILURES = new Set([
  'STORAGE_BROWSER_PROFILE_PATH_TOO_LONG',
  'STORAGE_INSUFFICIENT_SPACE',
  'STORAGE_INITIAL_SELECTION_HAS_DATA',
  'STORAGE_INITIAL_SELECTION_HAS_OPERATION',
  'STORAGE_SELECTION_CHANGED',
  'STORAGE_CANCEL_RECONCILIATION_REQUIRED',
  'STORAGE_LEGACY_REGISTRATION_INPUT_CHANGED',
  'STORAGE_LEGACY_REGISTERED_CATALOG_UNSUPPORTED',
  'STORAGE_LEGACY_REGISTRATION_INVALID',
  'STORAGE_LEGACY_REGISTRATION_UNAVAILABLE',
  'STORAGE_LEGACY_SOURCE_CONFLICT',
  'SERVICE_LEASE_NATIVE_CODE_RELOCATION_UNSUPPORTED',
  'SERVICE_LEASE_LEGACY_HOST_RELOCATION_UNSUPPORTED',
  'STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT',
  'STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED',
  'STORAGE_SOURCE_CLEANUP_UNKNOWN',
  'STORAGE_SOURCE_CLEANUP_NOT_COMPLETE',
  'STORAGE_SOURCE_CLEANUP_WRITER_UNKNOWN',
  'STORAGE_WRITERS_ACTIVE',
  'STORAGE_MIGRATION_BUSY',
  'STORAGE_TREE_MANIFEST_UNKNOWN',
  'STORAGE_LEGACY_CLIENT_DATA_UNSUPPORTED',
  'STORAGE_LEGACY_ENTRY_OWNER_UNKNOWN',
  'STORAGE_LEGACY_ENTRY_OWNER_NOT_DECLARED',
  'STORAGE_LEGACY_ENTRY_KIND_MISMATCH',
  'STORAGE_LEGACY_CONTROL_PAYLOAD_UNCONFIRMED',
  'STORAGE_LEGACY_SOURCE_CHANGED',
  'STORAGE_TARGET_NOT_EMPTY',
  'STORAGE_SOURCE_TARGET_OVERLAP',
  'STORAGE_ROOTS_OVERLAP',
  'STORAGE_OWNER_RUNTIME_REQUIRED',
  'STORAGE_GATEWAY_INTERNAL_REFERENCE_UNSUPPORTED',
  'STORAGE_MANAGED_WORKTREE_INTERNAL_ALIAS_UNSUPPORTED',
  'STORAGE_GATEWAY_REFERENCE_METADATA_INVALID',
  'STORAGE_GATEWAY_REFERENCE_METADATA_TOO_LARGE',
  'STORAGE_RECORD_UNAVAILABLE',
]);
const failure = code => Object.assign(new Error(code), { code });

function helperFailure(stderr) {
  const safeCode = (typeof stderr === 'string' ? stderr : '').split(/\r?\n/)
    .map(line => line.trim().replace(/^\d+:\s*/, ''))
    .map(line => line.startsWith('Error: ') ? line.slice(7) : line)
    .map(line => {
      const code = line.split(':', 1)[0];
      return CREDENTIAL_PREVIEW_FAILURES.has(code) ? code : line;
    })
    .find(line => SAFE_PREVIEW_FAILURES.has(line) || CREDENTIAL_PREVIEW_FAILURES.has(line));
  return failure(safeCode ?? 'STORAGE_HELPER_FAILED');
}

function serializeOwnerRuntime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['program', 'applicationRoot', 'runAsNode'].includes(key)) ||
    Object.keys(value).length !== 3 || typeof value.program !== 'string' || !isAbsolute(value.program) ||
    typeof value.applicationRoot !== 'string' || !isAbsolute(value.applicationRoot) || value.runAsNode !== true ||
    /[\0\r\n]/.test(value.program) || /[\0\r\n]/.test(value.applicationRoot)) {
    throw failure('STORAGE_OWNER_RUNTIME_INVALID');
  }
  const serialized = JSON.stringify({
    program: value.program,
    applicationRoot: value.applicationRoot,
    runAsNode: true,
  });
  if (Buffer.byteLength(serialized) > 65536) throw failure('STORAGE_OWNER_RUNTIME_INVALID');
  return serialized;
}

/** Internal local-host CLI only; never routes through a remote target or an HTTP API. */
export function createStorageOperationClient({ program, env = process.env, cwd, relaunch, ownerRuntime }) {
  if (!isAbsolute(program) || !isAbsolute(cwd)) throw failure('STORAGE_HELPER_INVALID');
  if (relaunch && (typeof relaunch.program !== 'string' || typeof relaunch.cwd !== 'string' ||
    !isAbsolute(relaunch.program) || !isAbsolute(relaunch.cwd) ||
    Object.keys(relaunch).some(key => !['program', 'args', 'cwd'].includes(key)) ||
    !Array.isArray(relaunch.args) || relaunch.args.length > 16 ||
    relaunch.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
    Buffer.byteLength(JSON.stringify(relaunch)) > 65536)) throw failure('STORAGE_DESKTOP_RELAUNCH_INVALID');
  const launchContext = relaunch ? JSON.stringify(relaunch) : null;
  const ownerRuntimeContext = serializeOwnerRuntime(ownerRuntime);
  const helperEnv = { ...env };
  for (const name of Object.keys(helperEnv)) {
    if ([RELAUNCH_ENV, OWNER_RUNTIME_ENV].includes(name.toUpperCase())) delete helperEnv[name];
  }
  const operationEnv = () => ({ ...helperEnv, [OWNER_RUNTIME_ENV]: ownerRuntimeContext });
  const run = (args, input, withOwnerRuntime = false, timeout = 15_000) => new Promise((accept, reject) => {
    const child = execFile(program, args, { cwd, env: withOwnerRuntime ? operationEnv() : helperEnv, windowsHide: true, timeout,
      maxBuffer: LIMIT, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) { reject(helperFailure(stderr)); return; }
      try { accept(JSON.parse(stdout)); } catch { reject(failure('STORAGE_HELPER_REPLY_INVALID')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input == null ? undefined : JSON.stringify(input));
  });
  return Object.freeze({
    paths: () => run(['config', 'storage-paths']),
    status: operationId => run([ENTRY, 'status', ...(operationId == null ? [] : [operationId])]),
    cleanupPreview: ({ operationId }) => run([ENTRY, 'cleanup-preview', operationId], null, false, 300_000),
    cleanupConfirm: ({ operationId, confirmation }) => run([ENTRY, 'cleanup-confirm', operationId], { confirmation }, false, 300_000),
    startup: () => run([ENTRY, 'startup'], null, true, 300_000),
    initialize: roots => run([ENTRY, 'initialize'], roots),
    cancel: operationId => run([ENTRY, 'cancel', operationId]),
    execute: plan => run([ENTRY, 'execute'], plan, true, 300_000),
    preview: input => run([ENTRY, 'plan'], input, true),
    handoff(plan, { retry = false } = {}) {
      const input = JSON.stringify(plan);
      if (Buffer.byteLength(input) > LIMIT) throw failure('STORAGE_OPERATION_INPUT_TOO_LARGE');
      return new Promise((accept, reject) => {
        // This one-shot has an explicit operation owner. It must survive the old
        // Electron process, unlike the normal Gateway and its supervised children.
        // Only the local host supplies this relaunch context; the renderer plan
        // cannot choose an executable. Preview/status never receive relaunch data.
        const handoffEnv = operationEnv();
        if (launchContext) handoffEnv[RELAUNCH_ENV] = launchContext;
        const child = spawn(program, [ENTRY, retry ? 'retry-handoff' : 'handoff'], { cwd, env: handoffEnv, shell: false,
          windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let ready = false, settled = false, output = '', diagnosticBytes = 0;
        const fail = error => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          child.kill();
          // Before transfer, this caller retains cleanup ownership until exit.
          if (child.exitCode !== null || child.signalCode !== null || !child.pid) reject(error);
          else child.once('exit', () => reject(error));
        };
        const timer = setTimeout(() => fail(failure('STORAGE_HANDOFF_TIMEOUT')), 15_000);
        child.once('error', () => fail(failure('STORAGE_HANDOFF_START_FAILED')));
        child.once('exit', () => {
          if (!ready) fail(failure('STORAGE_HANDOFF_UNCONFIRMED'));
        });
        child.stdin.once('error', () => { if (!ready) fail(failure('STORAGE_HANDOFF_UNCONFIRMED')); });
        child.stderr.on('data', bytes => {
          diagnosticBytes += bytes.length;
          if (diagnosticBytes > LIMIT) fail(failure('STORAGE_HELPER_REPLY_TOO_LARGE'));
        });
        child.stdout.on('data', bytes => {
          if (settled) return;
          output += bytes.toString('utf8');
          if (Buffer.byteLength(output) > LIMIT) { fail(failure('STORAGE_HELPER_REPLY_TOO_LARGE')); return; }
          const end = output.indexOf('\n');
          if (end < 0) return;
          let reply;
          try { reply = JSON.parse(output.slice(0, end)); } catch { fail(failure('STORAGE_HELPER_REPLY_INVALID')); return; }
          if (reply?.state !== 'ready' || reply.operationId !== plan.operationId ||
            Object.keys(reply).some(key => !['state', 'operationId'].includes(key))) {
            fail(failure('STORAGE_HANDOFF_UNCONFIRMED')); return;
          }
          ready = true; settled = true; clearTimeout(timer);
          // The original native journal now owns completion/recovery. No parent
          // pipe or JS callback may be required after its announced readiness.
          child.stdout.destroy(); child.stderr.destroy(); child.unref();
          accept(Object.freeze({ operationId: plan.operationId, state: 'ready' }));
        });
        child.stdin.end(input);
      });
    },
  });
}
