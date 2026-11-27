import { posix } from 'node:path';
import { remoteTargetPlatform, validateRemoteExecutable, validateRemoteWorkspace } from './ssh-launch.mjs';

export const PIN_GATE_PREFIX = 'kcoder-native-acp-image-v1:';
const quoteSh = value => `'${value.replaceAll("'", "'\\''")}'`;
const quotePs = value => `'${value.replaceAll("'", "''")}'`;

/** Fixed transport launch from current target configuration, never tool arguments. */
export function pinnedNativeSshLaunch(target, reference) {
  return pinnedLaunch(target, reference, false);
}

export function pinnedNativeSshReadLaunch(target, reference) {
  return pinnedLaunch(target, reference, true);
}

function pinnedLaunch(target, reference, originalReadOnly) {
  const platform = remoteTargetPlatform(target.remotePlatform);
  if (target.transport !== 'ssh' || target.runtime !== 'kcoder' || target.security
      || platform !== reference.targetPlatform || !/^[a-f0-9]{64}$/.test(reference.expectedNativeSha256)
      || typeof target.host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]{0,252}$/.test(target.host)
      || (target.user && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(target.user))) {
    throw new Error('REMOTE_HOST_NATIVE_SSH_TARGET_UNAVAILABLE');
  }
  validateRemoteExecutable(target.command, platform);
  if (platform === 'linux' && !posix.isAbsolute(target.command)) throw new Error('REMOTE_HOST_ABSOLUTE_NATIVE_IMAGE_REQUIRED');
  validateRemoteWorkspace(target.remoteCwd, platform);
  const nativeArgs = originalReadOnly ? ['--internal-native-remote-read-v1'] : [];
  if (target.settingsFile) {
    validateRemoteWorkspace(target.settingsFile, platform);
    nativeArgs.push('--settings-file', target.settingsFile);
  }
  if (target.profile) {
    if (typeof target.profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(target.profile))
      throw new Error('REMOTE_HOST_INVALID_NATIVE_PROFILE');
    nativeArgs.push('--profile', target.profile);
  }
  nativeArgs.push('--cwd', target.remoteCwd);
  if (!originalReadOnly) nativeArgs.push('acp');
  const ready = PIN_GATE_PREFIX + reference.expectedNativeSha256 + ':' + platform;
  let remote;
  if (platform === 'linux') {
    // Keep the exact hashed image open through exec; path replacement cannot
    // select a different image after verification. The selected target owns the
    // actual cwd; ACP preparation does not apply the --cwd CLI selector itself.
    const script = 'set -eu; exec 3<' + quoteSh(target.command)
      + '; pin=$(/usr/bin/sha256sum /proc/self/fd/3); '
      + '[ "${pin%% *}" = ' + quoteSh(reference.expectedNativeSha256) + ' ] || exit 73; '
      + 'cd -- ' + quoteSh(target.remoteCwd) + '; '
      + 'printf \'%s\\n\' ' + quoteSh(ready) + '; exec /proc/self/fd/3 '
      + nativeArgs.map(quoteSh).join(' ');
    remote = ['sh', '-c', quoteSh(script)];
  } else {
    // FileShare.Read excludes replacement, writes and deletion while the image
    // is hashed and the owned ACP process runs. No profile scripts are loaded.
    const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
      + "if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){exit 73}; "
      + "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "
      + '$image=[IO.File]::Open(' + quotePs(target.command) + ',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); '
      + 'try { $sha=[Security.Cryptography.SHA256]::Create(); try{$pin=([BitConverter]::ToString($sha.ComputeHash($image))).Replace(\'-\',\'\').ToLowerInvariant()}finally{$sha.Dispose()}; '
      + 'if($pin -ne ' + quotePs(reference.expectedNativeSha256) + '){exit 73}; '
      + 'Set-Location -LiteralPath ' + quotePs(target.remoteCwd) + '; '
      + '[Environment]::CurrentDirectory=(Get-Location).ProviderPath; '
      + '[Console]::Out.WriteLine(' + quotePs(ready) + '); & ' + quotePs(target.command) + ' @('
      + nativeArgs.map(quotePs).join(',') + '); exit $LASTEXITCODE } finally { $image.Dispose() }';
    remote = ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  }
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10'];
  if (target.port !== undefined) {
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error('REMOTE_HOST_INVALID_SSH_PORT');
    args.push('-p', String(target.port));
  }
  args.push(target.user ? `${target.user}@${target.host}` : target.host, ...remote);
  return { command: 'ssh', args, ready, platform };
}
