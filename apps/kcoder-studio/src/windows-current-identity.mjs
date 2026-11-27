import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
const run = (file, args, options) => new Promise((resolve, reject) => {
  const { input = '', ...settings } = options;
  const child = execFile(file, args, settings, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  child.stdin.on('error', reject);
  child.stdin.end(input);
});
const sidPattern = /^S-1-(?:[0-9]+-){1,14}[0-9]+$/;
const source = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();
try {
 if($null -eq $identity.User){throw 'Current token has no user SID'};
 $result=@{sid=$identity.User.Value;userProfile=[Environment]::GetFolderPath('UserProfile');
  localAppData=[Environment]::GetFolderPath('LocalApplicationData');
  appData=[Environment]::GetFolderPath('ApplicationData');
  programData=[Environment]::GetFolderPath('CommonApplicationData')};
 [Console]::Out.WriteLine(($result|ConvertTo-Json -Compress));
} finally {$identity.Dispose()}`;

const unavailable = reason => Object.assign(new Error(`Windows account identity is unavailable (${reason})`), {
  code: 'WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE', reason,
});

function windowsPowerShellPath(env) {
  // Windows environment names are case-insensitive, but a spread copy of
  // process.env is an ordinary case-sensitive JavaScript object.
  const key = Object.keys(env || {}).find(name => name.toLowerCase() === 'systemroot');
  const root = env?.SystemRoot ?? (key && env[key]);
  if (typeof root !== 'string' || !win32.isAbsolute(root) || /[\0\r\n]/.test(root))
    throw unavailable('system_directory_unavailable');
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function validWindowsSid(value) {
  return typeof value === 'string' && value.length <= 256 && sidPattern.test(value);
}

/** Read the actual process token and Known Folders. Account/display names and
 * USERNAME/USERDOMAIN never establish this identity or a filesystem grant.
 */
export async function readWindowsCurrentIdentity({ env = process.env, platform = process.platform, execute = run } = {}) {
  if (platform !== 'win32') throw unavailable('unsupported_platform');
  const powershell = windowsPowerShellPath(env);
  const childEnv = { ...process.env };
  // Known Folder expansion needs SystemDrive even in a sanitized launch environment.
  // Repair only this probe's environment, using the selected Windows system path.
  if (!process.env.SystemDrive) {
    for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'systemdrive') delete childEnv[key];
    childEnv.SystemDrive = win32.parse(powershell).root.replace(/[\\/]$/, '');
  }
  let result;
  try {
    result = await execute(powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10_000, maxBuffer: 8192, encoding: 'utf8', env: childEnv });
  } catch (error) {
    throw unavailable(error?.code === 'ENOENT' ? 'powershell_unavailable' : error?.killed ? 'timeout' : 'execution_failed');
  }
  let identity;
  try { identity = JSON.parse(result.stdout); } catch { throw unavailable('invalid_identity'); }
  if (!identity || !validWindowsSid(identity.sid)) throw unavailable('invalid_identity');
  const allowed = ['sid', 'userProfile', 'localAppData', 'appData', 'programData'];
  if (Object.keys(identity).some(key => !allowed.includes(key))) throw unavailable('invalid_identity');
  for (const name of allowed.slice(1)) {
    if (typeof identity[name] !== 'string' || identity[name].length > 32767
      || !win32.isAbsolute(identity[name]) || /[\0\r\n]/.test(identity[name])) throw unavailable('invalid_identity');
  }
  return Object.freeze(Object.fromEntries(allowed.map(name => [name, identity[name]])));
}

const selectionKey = 'Software\\KunlunMeta\\KCoder Studio';
const selectionValue = 'SelectedPrivateProfileV1';
const selectionPath = value => typeof value === 'string' && value.length <= 32767
  && win32.isAbsolute(value) && !/[\0\r\n]/.test(value);

/** This per-user preference is a hint, never an ownership or ACL verdict. */
export async function readWindowsProfileSelection({ env = process.env, identity, execute = run } = {}) {
  const script = `$ErrorActionPreference='Stop';$me=[Security.Principal.WindowsIdentity]::GetCurrent();$key=$null;
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
try {$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${selectionKey}');$value=$null;
 if($null -ne $key){$value=$key.GetValue('${selectionValue}',$null)};
 [Console]::Out.WriteLine((@{sid=$me.User.Value;value=$value}|ConvertTo-Json -Compress))
}finally{if($null -ne $key){$key.Dispose()};$me.Dispose()}`;
  let result;
  try { result = await execute(windowsPowerShellPath(env),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10_000, maxBuffer: 512 * 1024, encoding: 'utf8' }); }
  catch { throw unavailable('execution_failed'); }
  let response, value;
  try { response = JSON.parse(result.stdout); value = response.value === null ? null : JSON.parse(response.value); }
  catch { throw unavailable('invalid_identity'); }
  if (response.sid !== identity.sid) throw unavailable('invalid_identity');
  if (value === null) return null;
  if (![1, 2].includes(value?.version) || value.sid !== identity.sid || !selectionPath(value.sourceDirectory)
    || !selectionPath(value.directory) || Object.keys(value).some(key => !['version', 'sid', 'sourceDirectory', 'directory', 'sourceDataKey', 'dataDirectory', 'serversStore', 'clearCatalogInputs', 'selectionSource'].includes(key))) return null;
  if (value.selectionSource !== undefined && !['interactive', 'installer'].includes(value.selectionSource)) return null;
  if (value.version === 2 && (typeof value.sourceDataKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceDataKey)
    || !selectionPath(value.dataDirectory) || !selectionPath(value.serversStore) || typeof value.clearCatalogInputs !== 'boolean')) return null;
  return Object.freeze(value);
}

export async function saveWindowsProfileSelection({ env = process.env, identity, sourceDirectory, directory,
  sourceDataKey, dataDirectory, serversStore, clearCatalogInputs, selectionSource, execute = run } = {}) {
  if (!validWindowsSid(identity?.sid) || !selectionPath(sourceDirectory) || !selectionPath(directory)) throw unavailable('invalid_identity');
  if (selectionSource !== undefined && !['interactive', 'installer'].includes(selectionSource)) throw unavailable('invalid_identity');
  const data = sourceDataKey === undefined ? {} : { sourceDataKey, dataDirectory, serversStore, clearCatalogInputs };
  if (sourceDataKey !== undefined && (!/^[a-f0-9]{64}$/.test(sourceDataKey) || !selectionPath(dataDirectory)
    || !selectionPath(serversStore) || typeof clearCatalogInputs !== 'boolean')) throw unavailable('invalid_identity');
  const value = JSON.stringify({ version: sourceDataKey === undefined ? 1 : 2, sid: identity.sid, sourceDirectory, directory,
    ...data, ...(selectionSource ? { selectionSource } : {}) });
  const script = `$ErrorActionPreference='Stop';$me=[Security.Principal.WindowsIdentity]::GetCurrent();$key=$null;
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
try {$value=[Console]::In.ReadToEnd();$parsed=$value|ConvertFrom-Json;
 if($parsed.sid -cne $me.User.Value){throw 'Current profile owner changed'};
 $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${selectionKey}');
 $key.SetValue('${selectionValue}',$value,[Microsoft.Win32.RegistryValueKind]::String);
 if([string]$key.GetValue('${selectionValue}','') -cne $value){throw 'Profile preference not confirmed'};
 [Console]::Out.WriteLine('saved')
}finally{if($null -ne $key){$key.Dispose()};$me.Dispose()}`;
  let result;
  try { result = await execute(windowsPowerShellPath(env),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10_000, maxBuffer: 8192, encoding: 'utf8', input: value }); }
  catch { throw unavailable('execution_failed'); }
  if (result.stdout.trim() !== 'saved') throw unavailable('invalid_identity');
  return true;
}
