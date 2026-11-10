import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseEnv, promisify } from 'node:util';

const PASSWORD = 'KCODER_WINDOWS_CERTIFICATE_PASSWORD';
const PATH_KEYS = ['KCODER_WINDOWS_CERTIFICATE_PATH', 'KCODER_WINDOWS_SIGNING_ENV_FILE'];
const execute = promisify(execFile);

function parseConfiguration(text) {
  try { return parseEnv(text); }
  catch { throw new Error('Unable to parse Windows signing configuration (contents suppressed)'); }
}

async function privateFile(path, root, read = false) {
  const before = await lstat(path);
  if (before.isSymbolicLink()) throw new Error('Windows signing credentials cannot be symbolic links');
  const [canonicalPath, canonicalRoot] = await Promise.all([realpath(path), realpath(root)]);
  const rel = relative(canonicalRoot, canonicalPath);
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) {
    throw new Error('Windows signing credentials must be outside the repository');
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024
      || info.dev !== before.dev || info.ino !== before.ino
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      || (process.getuid && info.uid !== process.getuid())) {
      throw new Error('Windows signing credentials must be private, owner-owned regular files (mode 600)');
    }
    return read ? await handle.readFile('utf8') : undefined;
  } finally { await handle.close(); }
}

export async function loadWindowsSigningConfiguration(root, source = process.env) {
  let repository = {};
  try { repository = parseConfiguration(await readFile(resolve(root, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = Object.fromEntries(PATH_KEYS.map(key => [key, source[key] ?? repository[key]]));
  const path = settings.KCODER_WINDOWS_CERTIFICATE_PATH;
  const passwordFile = settings.KCODER_WINDOWS_SIGNING_ENV_FILE;
  if (!path) {
    if (passwordFile || source[PASSWORD] !== undefined) {
      throw new Error('Windows signing is partially configured: KCODER_WINDOWS_CERTIFICATE_PATH is required');
    }
    return { enabled: false, warning: 'Windows signing is not configured; building an UNSIGNED installer.' };
  }
  const certificateFile = resolve(root, path);
  if (!/\.(pfx|p12)$/i.test(certificateFile)) throw new Error('Windows signing requires a .pfx or .p12 certificate');
  await privateFile(certificateFile, root);
  // Passwords in repository .env and unrelated private-file values are ignored.
  const password = source[PASSWORD] ?? (passwordFile
    ? parseConfiguration(await privateFile(resolve(root, passwordFile), root, true))[PASSWORD] : undefined);
  if (password === undefined) {
    throw new Error('Windows signing requires KCODER_WINDOWS_CERTIFICATE_PASSWORD in the process environment or private signing file');
  }
  return { enabled: true, certificateFile, password };
}

export async function verifyWindowsSigningTool(signing, source = process.env, platform = process.platform) {
  if (!signing.enabled || platform !== 'linux'
    || source.SIGNTOOL_PATH || source.ELECTRON_BUILDER_OSSL_SIGNCODE_PATH) return;
  let version;
  try {
    const { stdout, stderr } = await execute('osslsigncode', ['--version'], {
      env: { PATH: source.PATH, LANG: 'C' }, timeout: 5000, maxBuffer: 16384,
    });
    version = `${stdout}\n${stderr}`;
  } catch {
    throw new Error('Linux Windows signing requires osslsigncode >= 2.8 with OpenSSL >= 3 on PATH; install it before packaging, or set an explicit SIGNTOOL_PATH');
  }
  const tool = version.match(/\bosslsigncode\s+(\d+)\.(\d+)/i);
  const crypto = version.match(/\bOpenSSL\s+(\d+)\./);
  if (!tool || !(Number(tool[1]) > 2 || (Number(tool[1]) === 2 && Number(tool[2]) >= 8))
    || !crypto || Number(crypto[1]) < 3) {
    throw new Error('Linux Windows signing requires osslsigncode >= 2.8 built with OpenSSL >= 3; the bundled OpenSSL 1.1 signer is not used');
  }
}

export async function runWithWindowsSigning(signing, build) {
  // Without a version, electron-builder selects its legacy toolset.
  const toolsets = { winCodeSign: '1.1.0' };
  if (!signing.enabled) {
    console.warn(signing.warning);
    return build({ toolsets, forceCodeSigning: false, win: { signExecutable: false } });
  }
  console.info('Windows signing enabled. A self-signed certificate does not establish public publisher trust.');
  const previous = process.env.WIN_CSC_KEY_PASSWORD;
  const previousSystemTool = process.env.USE_SYSTEM_OSSLSIGNCODE;
  // electron-builder reads this variable during signing. Keep it out of its
  // serialized configuration and out of the earlier renderer/Cargo builds.
  process.env.WIN_CSC_KEY_PASSWORD = signing.password;
  // The modern bundled Linux signer still requires libcrypto.so.1.1. Explicit
  // SIGNTOOL_PATH / ELECTRON_BUILDER_OSSL_SIGNCODE_PATH retain builder precedence.
  if (process.platform === 'linux') process.env.USE_SYSTEM_OSSLSIGNCODE = 'true';
  try {
    return await build({
      toolsets,
      forceCodeSigning: true,
      win: {
        signExecutable: true,
        signAndEditExecutable: true,
        // Extra-resource copies are signed before afterPack by electron-builder.
        // Leave sealed native resources and third-party signatures unchanged.
        signExts: ['!.exe', 'kcoder-studio.exe', '-win-x64.exe', '.__uninstaller.exe'],
        signtoolOptions: { certificateFile: signing.certificateFile, signingHashAlgorithms: ['sha256'] },
      },
    });
  } finally {
    if (previous === undefined) delete process.env.WIN_CSC_KEY_PASSWORD;
    else process.env.WIN_CSC_KEY_PASSWORD = previous;
    if (previousSystemTool === undefined) delete process.env.USE_SYSTEM_OSSLSIGNCODE;
    else process.env.USE_SYSTEM_OSSLSIGNCODE = previousSystemTool;
  }
}
