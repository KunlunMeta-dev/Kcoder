import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, posix, win32 } from 'node:path';

export function createGatewayToken(env = process.env) {
  if (typeof env.KCODER_STUDIO_AUTH_TOKEN === 'string' && env.KCODER_STUDIO_AUTH_TOKEN) {
    return env.KCODER_STUDIO_AUTH_TOKEN;
  }
  if (env.NODE_ENV === 'test' && env.KCODER_STUDIO_TEST_DISABLE_AUTH === '1') return '';
  return randomBytes(32).toString('base64url');
}

export function studioDataDirectory({ platform = process.platform, home, serversStore, dataDirectory } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  if (dataDirectory !== undefined && dataDirectory !== '') {
    if (typeof dataDirectory !== 'string' || !paths.isAbsolute(dataDirectory)) {
      throw new TypeError('KCODER_STUDIO_DATA_DIR must be an absolute path');
    }
    return paths.resolve(dataDirectory);
  }
  // Existing installations retain their original private state until explicitly relocated.
  if (serversStore) return paths.dirname(serversStore);
  const root = home ?? (platform === 'win32' ? (process.env.USERPROFILE || homedir()) : homedir());
  return paths.resolve(root, '.config', 'kcoder-studio');
}

export function studioLoginUrlPath({ platform = process.platform, home, serversStore, dataDirectory } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const directory = studioDataDirectory({ platform, home, serversStore, dataDirectory });
  return paths.join(directory, 'studio-login-url.txt');
}

export async function writeStudioLoginUrl(url, {
  platform = process.platform,
  home,
  serversStore,
  dataDirectory,
} = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || /[\r\n]/.test(url)) {
    throw new TypeError('Studio login URL must be one HTTP(S) URL');
  }
  const path = studioLoginUrlPath({ platform, home, serversStore, dataDirectory });
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const existing = await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && !existing.isFile()) throw new Error('Studio login URL path must be a regular file');
  const contents = `${url}\n`;
  if (existing) {
    const current = await readFile(path, 'utf8');
    if (current === contents) {
      return { path, updated: false };
    }
  }

  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (platform === 'win32' && existing) await rm(path);
    await rename(temporary, path);
    // The same-directory rename publishes a complete URL without exposing a partial file.
    return { path, updated: true };
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function loginUrl(base, token) {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}/login`;
  url.search = "";
  url.hash = new URLSearchParams({ code: token }).toString();
  return url.toString();
}
