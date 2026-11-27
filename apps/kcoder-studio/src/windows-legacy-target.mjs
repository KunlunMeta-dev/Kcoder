import { lstat, open } from 'node:fs/promises';
import { win32 } from 'node:path';

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();

async function isMissing(path) {
  try { await lstat(path); return false; }
  catch (error) { return error.code === 'ENOENT'; }
}

async function isLegacyToml(path) {
  let file;
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) return false;
    file = await open(path, 'r');
    const held = await file.stat({ bigint: true });
    if (!held.isFile() || held.dev !== info.dev || held.ino !== info.ino || held.nlink !== 1n) return false;
    const chunk = Buffer.alloc(4096);
    const { bytesRead } = await file.read(chunk, 0, chunk.length, 0);
    const prefix = chunk.subarray(0, bytesRead);
    const text = prefix.toString(prefix[0] === 0xff && prefix[1] === 0xfe ? 'utf16le' : 'utf8');
    return /^(?:\s*#[^\n]*(?:\n|$))*\s*(?:(?:model|model_provider|model_reasoning_effort)\s*=|\[model_providers\.)/.test(text);
  } catch { return false; }
  finally { await file?.close(); }
}

/** Adapt only the legacy Windows setup's local command/settings pair, after
 * observing a missing launcher or its incompatible TOML. Keep the task ID and workspace.
 */
export async function resolveLegacyWindowsTarget(target, env, binary, platform = process.platform,
  probe = { isMissing, isLegacyToml }) {
  if (platform !== 'win32' || env.KCODER_STUDIO_DESKTOP_HOST !== '1' ||
      !samePath(binary, env.KCODER_STUDIO_PACKAGED_WINDOWS_BIN) || target.transport !== 'local' ||
      target.security || target.profile !== 'kc' || !env.ProgramData || !env.ProgramFiles) return target;
  const oldCommand = win32.join(env.ProgramFiles, 'KCoder Studio', 'resources', 'bin', 'kcoder.exe');
  const oldSettings = win32.join(env.ProgramData, 'KCoder', 'settings.toml');
  if (!samePath(target.command, oldCommand) || !samePath(target.settingsFile, oldSettings)) return target;
  if (!(await probe.isMissing(oldCommand)) && !(await probe.isLegacyToml(oldSettings))) return target;
  return { ...target, command: binary, settingsFile: undefined, profile: undefined };
}
