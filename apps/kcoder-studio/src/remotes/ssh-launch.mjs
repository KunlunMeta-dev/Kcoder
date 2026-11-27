import { posix, win32 } from 'node:path';

const LEGACY_POSIX_COMMAND = /^[a-zA-Z0-9_./-]+$/;

// Platform and paths are selectors, never authentication or process ownership.
export function remoteTargetPlatform(value) {
  if (value === undefined) return 'linux';
  if (value !== 'linux' && value !== 'windows') throw new Error('Invalid remote target platform');
  return value;
}

export function validateRemoteWorkspace(value, declaredPlatform) {
  const platform = remoteTargetPlatform(declaredPlatform);
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('Invalid remote workspace');
  if (platform === 'linux') {
    if (!posix.isAbsolute(value) || !LEGACY_POSIX_COMMAND.test(value)) throw new Error('Invalid POSIX remote workspace');
    return value;
  }
  // A local drive is explicit. UNC, device and drive-relative paths need a
  // distinct owned filesystem provider and cannot masquerade as this target.
  if (!/^[a-zA-Z]:[\\/]/.test(value) || !win32.isAbsolute(value)
    || /["<>|*?]/.test(value.slice(2))) throw new Error('Invalid Windows remote workspace');
  return value;
}

export function validateRemoteExecutable(value, declaredPlatform) {
  const platform = remoteTargetPlatform(declaredPlatform);
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('Invalid remote executable');
  if (platform === 'linux') {
    if (!LEGACY_POSIX_COMMAND.test(value) || value.startsWith('-')) throw new Error('Invalid POSIX remote executable');
    return value;
  }
  validateRemoteWorkspace(value, platform);
  if (!value.toLowerCase().endsWith('.exe')) throw new Error('Windows remote executable must be an explicit native image');
  return value;
}

function powershellLiteral(value) { return `'${value.replace(/['\u2018-\u201b]/gu, quote => quote + quote)}'`; }

/** Build only the fixed command from an owned target, never model/tool JSON. */
export function remoteSshCommand(executable, args, declaredPlatform) {
  const platform = remoteTargetPlatform(declaredPlatform);
  validateRemoteExecutable(executable, platform);
  if (!Array.isArray(args) || args.length > 64 || args.some(value => typeof value !== 'string'
    || !value || value.length > 32768 || /[\x00-\x1f\x7f]/.test(value))) throw new Error('Invalid remote arguments');
  if (platform === 'linux') return [executable, ...args];
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; `
    + `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); `
    + `& ${powershellLiteral(executable)} @(${args.map(powershellLiteral).join(',')}); exit $LASTEXITCODE`;
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
