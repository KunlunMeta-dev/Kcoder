import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { remoteTargetPlatform, validateRemoteWorkspace } from './ssh-launch.mjs';

function pathsFor(target, platform) {
  if (target.transport === 'ssh') return remoteTargetPlatform(target.remotePlatform) === 'windows' ? win32 : posix;
  return platform === 'win32' ? win32 : posix;
}

/** Interpret an owned target's path on that target, never on the Gateway host. */
export function isTargetWorkspaceAbsolute(target, value, { platform = process.platform } = {}) {
  if (typeof value !== 'string' || !value.length) return false;
  if (target.transport === 'ssh' && remoteTargetPlatform(target.remotePlatform) === 'windows') {
    try {
      // A remote Windows drive is explicit. Keep UNC/device/root-relative paths
      // out of this transport, matching the native SSH launch contract.
      validateRemoteWorkspace(value, 'windows');
      return true;
    } catch { return false; }
  }
  return pathsFor(target, platform).isAbsolute(value);
}

/** A key is not a filesystem grant. Remote paths never access the host disk. */
export function targetWorkspaceBrokerKey(target, workspacePath, signature, {
  platform = process.platform, realpath = realpathSync.native,
} = {}) {
  const paths = pathsFor(target, platform);
  const requested = workspacePath || (target.transport === 'local' ? target.cwd : target.remoteCwd);
  if (target.transport === 'ssh' && (typeof requested !== 'string' || requested.length === 0)) {
    // Preserve the remote login directory without treating it as a known root.
    return JSON.stringify([signature, '<remote-default-cwd>']);
  }
  if (!isTargetWorkspaceAbsolute(target, requested, { platform })) {
    throw new Error(`runtime target ${target.id} has no absolute workspace path`);
  }
  const normalized = target.transport === 'local' ? realpath(requested) : paths.normalize(requested);
  return JSON.stringify([signature, normalized]);
}
