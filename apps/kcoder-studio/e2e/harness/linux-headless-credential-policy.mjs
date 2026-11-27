import assert from 'node:assert/strict';
import { join, relative, resolve, sep } from 'node:path';
import { isolatedEnvironment } from './run-context.mjs';

export const headlessKeyringError = 'migration_credential_import_keyring_unavailable';
export function headlessCredentialEnvironment(root, profile, runtime = join(root, 'runtime')) {
  assert.equal(resolve(root), root, 'headless_owned_root_required');
  const child = relative(root, profile);
  assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !child.startsWith(sep), 'headless_owned_profile_required');
  assert.equal(resolve(runtime), runtime, 'headless_owned_runtime_required');
  assert.ok(Buffer.byteLength(join(runtime, 'absent-session-bus.sock')) < 108, 'headless_valid_unix_socket_path_required');
  const env = isolatedEnvironment({ HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), KCODER_CONFIG_DIR: profile,
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'empty-codex'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'), XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_RUNTIME_DIR: runtime,
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(runtime, 'absent-session-bus.sock'),
    DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=' + join(runtime, 'absent-system-bus.sock'),
  });
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE', 'SSH_AUTH_SOCK', 'XDG_SESSION_ID']) delete env[name];
  return env;
}
export function assertHeadlessKeyringRejected(frame) {
  assert.equal(frame?.error?.code, -32047, 'headless_keyring_must_return_domain_failure');
  assert.equal(frame.error.message === headlessKeyringError, true, 'headless_keyring_failure_must_be_explicit');
  assert.equal(frame.result, undefined, 'headless_keyring_failure_is_not_success');
  return headlessKeyringError;
}
export function assertHeadlessPublic(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'headless_public_secret_leak');
}
export function assertHeadlessGroupSettled(state) {
  assert.equal(state.workerRunning, false, 'headless_worker_not_stopped');
  const saved = state.state;
  assert.equal(saved.job.hasUnconfirmedOutcomes, false, 'headless_group_has_unknown_outcomes');
  assert.ok(['completed', 'completed_with_issues'].includes(saved.job.status), 'headless_group_not_completed');
  assert.ok(saved.batch.totalActions > 0, 'headless_empty_group_not_accepted');
  assert.equal(saved.batch.committedActions, saved.batch.totalActions, 'headless_group_incomplete');
  assert.equal(saved.batch.unresolvedActions, 0, 'headless_group_unresolved');
  return saved;
}
