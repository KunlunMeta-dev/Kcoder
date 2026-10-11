import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createGatewayToken(env = process.env) {
  if (typeof env.KCODER_STUDIO_AUTH_TOKEN === 'string' && env.KCODER_STUDIO_AUTH_TOKEN) {
    return env.KCODER_STUDIO_AUTH_TOKEN;
  }
  if (env.NODE_ENV === 'test' && env.KCODER_STUDIO_TEST_DISABLE_AUTH === '1') return '';
  return randomBytes(32).toString('base64url');
}

export function studioDataDirectory({ platform = process.platform, home, serversStore } = {}) {
  const paths = platform === 'win32' ? win32 : { dirname, resolve };
  if (serversStore) return paths.dirname(serversStore);
  const root = home ?? (platform === 'win32' ? (process.env.USERPROFILE || homedir()) : homedir());
  return paths.resolve(root, '.config', 'kcoder-studio');
}

export function studioLoginUrlPath({ platform = process.platform, home, serversStore, dataDirectory } = {}) {
  const paths = platform === 'win32' ? win32 : { join };
  const directory = dataDirectory ?? studioDataDirectory({ platform, home, serversStore });
  return paths.join(directory, 'studio-login-url.txt');
}

function windowsIdentity(env = process.env) {
  if (!env.USERNAME) throw new Error('Cannot determine the current Windows account for login-link permissions');
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
}

async function restrictWindowsFile(path, env) {
  const executable = env.SystemRoot ? join(env.SystemRoot, 'System32', 'icacls.exe') : 'icacls';
  const account = windowsIdentity(env);
  await execFileAsync(executable, [path, '/inheritance:r', '/grant:r', `${account}:(F)`], {
    windowsHide: true,
  });
}

export async function writeStudioLoginUrl(url, {
  platform = process.platform,
  home,
  serversStore,
  dataDirectory,
  env = process.env,
} = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || /[\r\n]/.test(url)) {
    throw new TypeError('Studio login URL must be one HTTP(S) URL');
  }
  const path = studioLoginUrlPath({ platform, home, serversStore, dataDirectory });
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && !existing.isFile()) throw new Error('Studio login URL path must be a regular file');
  const contents = `${url}\n`;
  if (existing) {
    const current = await readFile(path, 'utf8');
    if (current === contents) {
      if (platform === 'win32') await restrictWindowsFile(path, env);
      else await chmod(path, 0o600);
      return { path, updated: false };
    }
  }

  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    if (platform === 'win32') await restrictWindowsFile(temporary, env);
    else await chmod(temporary, 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (platform === 'win32' && existing) await rm(path);
    await rename(temporary, path);
    if (platform === 'win32') await restrictWindowsFile(path, env);
    else await chmod(path, 0o600);
    return { path, updated: true };
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
