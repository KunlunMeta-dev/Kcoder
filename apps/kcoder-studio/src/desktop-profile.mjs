import { posix, win32 } from 'node:path';
import { launchSpec } from './server-config.js';

/** A Desktop launch default never mutates the configured or persisted catalog. */
export function createDesktopProfileLaunchSpec({ env = {}, appServerBin, platform = process.platform } = {}) {
  const profile = env.KCODER_STUDIO_DESKTOP_PROFILE?.trim();
  if (env.KCODER_STUDIO_DESKTOP_HOST !== '1' || !profile) return launchSpec;
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile)) {
    throw new Error('DESKTOP_PROFILE_INVALID');
  }
  const paths = platform === 'win32' ? win32 : posix;
  if (typeof appServerBin !== 'string' || !paths.isAbsolute(appServerBin)) {
    throw new Error('DESKTOP_PROFILE_LOCAL_CLI_REQUIRED');
  }
  const identity = value => platform === 'win32'
    ? paths.toNamespacedPath(value).toLowerCase() : paths.normalize(value);
  const command = identity(appServerBin);
  return (target, options = {}) => {
    const ownedLocal = target.id === 'local' && target.runtime === 'kcoder' && target.transport === 'local' &&
      !target.security && !target.profile && !target.settingsFile && typeof target.command === 'string' &&
      paths.isAbsolute(target.command) && identity(target.command) === command;
    // This temporary view is passed only to argv construction, never to storage.
    return launchSpec(ownedLocal ? { ...target, profile } : target, { platform, ...options });
  };
}
