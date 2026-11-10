import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';

const PASSWORD_KEYS = ['KCODER_ANDROID_KEYSTORE_PASSWORD', 'KCODER_ANDROID_KEY_PASSWORD'];
const CONFIG_KEYS = [
  'KCODER_ANDROID_KEYSTORE_PATH', 'KCODER_ANDROID_KEY_ALIAS', 'KCODER_ANDROID_SIGNING_ENV_FILE',
  'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME', 'GRADLE_USER_HOME',
];

function parseConfiguration(text) {
  try { return parseEnv(text); }
  catch { throw new Error('Unable to parse Android packaging environment configuration'); }
}

async function readSigningPasswords(path, root) {
  const [canonicalPath, canonicalRoot] = await Promise.all([realpath(path), realpath(root)]);
  const rel = relative(canonicalRoot, canonicalPath);
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) {
    throw new Error('KCODER_ANDROID_SIGNING_ENV_FILE must be outside the repository');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) {
      throw new Error('Android signing environment file must be a private, owner-owned regular file (mode 600)');
    }
    return parseConfiguration(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

export async function loadAndroidBuildEnvironment(root, source = process.env) {
  let repository = {};
  try { repository = parseConfiguration(await readFile(resolve(root, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Load only packaging settings; never export unrelated repository credentials.
  const environment = { ...source };
  const processHasSdk = source.ANDROID_HOME !== undefined || source.ANDROID_SDK_ROOT !== undefined;
  for (const key of CONFIG_KEYS) {
    // Both SDK names describe the same setting, so either explicit value wins.
    if (processHasSdk && (key === 'ANDROID_HOME' || key === 'ANDROID_SDK_ROOT')) continue;
    if (source[key] === undefined && repository[key] !== undefined) environment[key] = repository[key];
  }
  const privateFile = environment.KCODER_ANDROID_SIGNING_ENV_FILE;
  // Explicit process credentials also isolate test builds from the operator's key.
  if (privateFile && !source.KCODER_ANDROID_KEYSTORE_PASSWORD) {
    const passwords = await readSigningPasswords(resolve(root, privateFile), root);
    for (const key of PASSWORD_KEYS) {
      if (source[key] === undefined && passwords[key] !== undefined) environment[key] = passwords[key];
    }
  }
  return {
    environment,
    defaults: {
      keystore: environment.KCODER_ANDROID_KEYSTORE_PATH || undefined,
      keyAlias: environment.KCODER_ANDROID_KEY_ALIAS || undefined,
    },
  };
}
