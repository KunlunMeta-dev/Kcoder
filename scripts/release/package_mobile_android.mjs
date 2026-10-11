#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  access, chmod, cp, lstat, mkdir, open, readFile, readdir, readlink,
  realpath, rm, stat, writeFile, copyFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../..');
const PACKAGES_ROOT = resolve(REPO_ROOT, 'target/packages/kcoder-studio-mobile');
const STORE_PASSWORD_ENV = 'KCODER_ANDROID_KEYSTORE_PASSWORD';
const KEY_PASSWORD_ENV = 'KCODER_ANDROID_KEY_PASSWORD';
const HERMES_MAGIC = Buffer.from('c61fbc03c103191f', 'hex');

export const HELP = `Usage:
  node scripts/release/package_mobile_android.mjs --version-code N --keystore FILE --key-alias ALIAS [options]

Required:
  --version-code N    Android versionCode (positive 32-bit integer)
  --keystore FILE     Private release keystore file
  --key-alias ALIAS   Release key alias

Options:
  --sdk DIR           Android SDK root (defaults to ANDROID_HOME, then ANDROID_SDK_ROOT)
  --java-home DIR     JDK root (defaults to JAVA_HOME or java/jar/keytool on PATH)
  --gradle FILE       Use a cached Gradle executable instead of the generated wrapper
  --offline           Set Expo offline mode and pass Gradle --offline
  --dry-run           Check prerequisites and print the build plan without copying or building
  --help              Show this help

Signing passwords are read only from ${STORE_PASSWORD_ENV} and optional ${KEY_PASSWORD_ENV}.
The build requires Node.js, a JDK (java, jar, keytool), and Android SDK build-tools (aapt and apksigner).
Dependencies must already exist in apps/kcoder-studio/mobile/node_modules; this script never runs npm install.
The release APK, SHA-256, and provenance are written under target/packages/kcoder-studio-mobile/<unique-run>/.
Build hosts supported by this entry point: Linux and macOS.
`;

const fail = message => { throw new Error(message); };
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

export function parseArgs(argv) {
  const result = { offline: false, dryRun: false, help: false };
  const values = new Map([
    ['--version-code', 'versionCode'], ['--keystore', 'keystore'], ['--key-alias', 'keyAlias'],
    ['--sdk', 'sdk'], ['--java-home', 'javaHome'], ['--gradle', 'gradle'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--help' || item === '-h') { result.help = true; continue; }
    if (item === '--offline') { result.offline = true; continue; }
    if (item === '--dry-run') { result.dryRun = true; continue; }
    const [option, inline] = item.split(/=(.*)/s, 2);
    const field = values.get(option);
    if (!field) fail(`Unknown option: ${option}`);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) fail(`${option} requires a value`);
    if (result[field] !== undefined) fail(`${option} may be specified only once`);
    result[field] = value;
  }
  if (result.help) return result;
  if (result.versionCode === undefined) fail('--version-code is required');
  if (!/^[1-9]\d*$/.test(result.versionCode) || Number(result.versionCode) > 2_147_483_647) {
    fail('--version-code must be a positive 32-bit integer');
  }
  result.versionCode = Number(result.versionCode);
  if (!result.keystore) fail('--keystore is required');
  if (result.keyAlias === undefined) fail('--key-alias is required');
  if (!result.keyAlias.trim() || result.keyAlias.startsWith('-') || /[\0\r\n]/.test(result.keyAlias)) fail('--key-alias must be a non-empty alias');
  return result;
}

export function assertSupportedHost(platform = process.platform) {
  if (platform === 'win32') fail('This Android release packaging entry point supports Linux and macOS hosts only');
}

function ignoredSourceEntry(relativePath, kind) {
  const pieces = relativePath.split(/[\\/]+/).filter(Boolean);
  if (pieces.some(part => part === '.git' || part === 'node_modules' || part === '.expo' || part.startsWith('.env'))) return true;
  if (kind === 'mobile' && pieces.length === 1 && ['android', 'ios', 'build', 'dist', 'web-build', 'coverage', 'metro-cache', '.gradle'].includes(pieces[0])) return true;
  if (kind === 'shared' && pieces.length === 1 && ['build', 'dist', 'coverage'].includes(pieces[0])) return true;
  return false;
}

export { ignoredSourceEntry };

function environmentAllowlist(source) {
  const allowed = [
    'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'CI', 'GRADLE_USER_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy',
  ];
  const env = {};
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
    const value = source[key];
    if (!value || key.toLowerCase().includes('no_proxy')) continue;
    try {
      const proxy = new URL(value);
      if (proxy.username || proxy.password) fail('Proxy environment URLs must not contain embedded credentials');
    } catch (error) {
      if (error instanceof Error && error.message.includes('embedded credentials')) throw error;
      if (/@[^/\s]+(?::\d+)?(?:\/|$)/.test(value)) fail('Proxy environment URLs must not contain embedded credentials');
    }
  }
  for (const key of allowed) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

export function createBuildEnvironment(config, source = process.env, { privateDir, offline = false } = {}) {
  const env = environmentAllowlist(source);
  const pathEntries = [dirname(process.execPath)];
  if (config.javaHome) pathEntries.push(join(config.javaHome, 'bin'));
  pathEntries.push(join(config.sdk, 'platform-tools'), config.buildToolsDir);
  if (env.PATH) pathEntries.push(env.PATH);
  env.PATH = pathEntries.join(delimiter);
  env.ANDROID_HOME = config.sdk;
  env.ANDROID_SDK_ROOT = config.sdk;
  if (config.javaHome) env.JAVA_HOME = config.javaHome;
  env.EXPO_NO_DOTENV = '1';
  env.NODE_ENV = 'production';
  env.CI = '1';
  if (offline) env.EXPO_OFFLINE = '1';
  if (privateDir) {
    env.NPM_CONFIG_USERCONFIG = join(privateDir, 'npmrc.user');
    env.NPM_CONFIG_GLOBALCONFIG = join(privateDir, 'npmrc.global');
  }
  return env;
}

export function createGradleEnvironment(base, config, source = process.env) {
  const env = {
    ...base,
    ORG_GRADLE_PROJECT_kcoderReleaseStoreFile: config.keystoreCopy,
    ORG_GRADLE_PROJECT_kcoderReleaseStorePassword: source[STORE_PASSWORD_ENV],
    ORG_GRADLE_PROJECT_kcoderReleaseKeyAlias: config.keyAlias,
    ORG_GRADLE_PROJECT_kcoderReleaseKeyPassword: source[KEY_PASSWORD_ENV] || source[STORE_PASSWORD_ENV],
  };
  return env;
}

export function createGradleArguments(android, { offline = false } = {}) {
  const args = ['-p', android, ':app:assembleRelease', '--no-daemon', '--console=plain', '--max-workers=4', '-PreactNativeArchitectures=arm64-v8a'];
  if (offline) args.push('--offline');
  return args;
}

async function isRegularFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function executableOnPath(command, pathValue = process.env.PATH ?? '') {
  if (command.includes('/') || command.includes('\\')) {
    try { await access(command, fsConstants.X_OK); return resolve(command); } catch { return null; }
  }
  for (const folder of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = resolve(folder, command);
    try { await access(candidate, fsConstants.X_OK); return candidate; } catch { /* try next PATH entry */ }
  }
  return null;
}

function versionParts(value) {
  return value.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return left.localeCompare(right);
}

async function findSdkTools(sdk) {
  const root = join(sdk, 'build-tools');
  let versions;
  try { versions = await readdir(root); } catch { fail('Android SDK has no build-tools directory'); }
  versions.sort(compareVersions);
  for (const version of versions.reverse()) {
    const directory = join(root, version);
    const aapt = join(directory, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
    const apksigner = join(directory, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
    if (await isRegularFile(aapt) && await isRegularFile(apksigner)) return { buildToolsDir: directory, aapt, apksigner };
  }
  fail('Android SDK build-tools must contain both aapt and apksigner');
}

async function resolveJava(javaHome) {
  if (javaHome) {
    const root = resolve(javaHome);
    const java = join(root, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    const jar = join(root, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
    const keytool = join(root, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
    if (!(await isRegularFile(java)) || !(await isRegularFile(jar)) || !(await isRegularFile(keytool))) fail('--java-home must point to a JDK containing bin/java, bin/jar, and bin/keytool');
    return { javaHome: root, java, jar, keytool };
  }
  const java = await executableOnPath(process.platform === 'win32' ? 'java.exe' : 'java');
  const jar = await executableOnPath(process.platform === 'win32' ? 'jar.exe' : 'jar');
  const keytool = await executableOnPath(process.platform === 'win32' ? 'keytool.exe' : 'keytool');
  if (!java || !jar || !keytool) fail('A JDK with java, jar, and keytool on PATH is required; pass --java-home');
  return { javaHome: null, java, jar, keytool };
}

export async function preflight(args, env = process.env, root = REPO_ROOT) {
  assertSupportedHost();
  const mobile = resolve(root, 'apps/kcoder-studio/mobile');
  const shared = resolve(root, 'apps/kcoder-studio/shared');
  const dependencies = join(mobile, 'node_modules');
  for (const sourceDir of [mobile, shared]) {
    const info = await lstat(sourceDir).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) fail(`Source directory is missing or is a symbolic link: ${relative(root, sourceDir)}`);
  }
  const dependencyRoot = await lstat(dependencies).catch(() => null);
  if (!dependencyRoot?.isDirectory() || dependencyRoot.isSymbolicLink()) fail('Mobile node_modules must be an installed real directory, not a symbolic link');
  if (!(await isRegularFile(join(mobile, 'package.json')))) fail('Mobile package.json is missing');
  try { if (!(await stat(shared)).isDirectory()) fail('Shared source directory is missing'); }
  catch { fail('Shared source directory is missing'); }
  if (!(await isRegularFile(join(dependencies, 'expo/bin/cli')))) fail('Mobile dependencies are missing; install them before packaging (the script never runs npm install)');
  if (!(await isRegularFile(join(dependencies, 'esbuild/bin/esbuild')))) fail('The installed mobile dependencies do not include esbuild');
  environmentAllowlist(env);

  const keystore = resolve(args.keystore);
  if (!(await isRegularFile(keystore))) fail('--keystore must name an existing regular file');
  if (!env[STORE_PASSWORD_ENV]) fail(`${STORE_PASSWORD_ENV} must be set in the process environment`);

  const suppliedSdk = args.sdk ?? env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  if (!suppliedSdk) fail('Android SDK is required; pass --sdk or set ANDROID_HOME');
  const sdk = resolve(suppliedSdk);
  try { if (!(await stat(sdk)).isDirectory()) fail('Android SDK path must be a directory'); }
  catch { fail('Android SDK path does not exist'); }
  const sdkTools = await findSdkTools(sdk);
  const java = await resolveJava(args.javaHome ?? env.JAVA_HOME);
  let gradle = null;
  if (args.gradle) {
    gradle = resolve(args.gradle);
    if (!(await isRegularFile(gradle))) fail('--gradle must name an existing Gradle executable');
  }
  const mobileConfig = JSON.parse(await readFile(join(mobile, 'app.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(join(mobile, 'package.json'), 'utf8'));
  const appId = mobileConfig.expo?.android?.package;
  if (!appId) fail('Mobile app.json is missing expo.android.package');
  return {
    root, mobile, shared, dependencies, keystore, sdk, ...sdkTools, ...java,
    gradle, keyAlias: args.keyAlias, versionCode: args.versionCode,
    appId, appVersion: packageJson.version, offline: args.offline,
    passwordsConfigured: true,
  };
}

async function assertNoSymlinks(root, kind) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const rel = relative(root, file).split(sep).join('/');
      if (ignoredSourceEntry(rel, kind)) continue;
      if (entry.isSymbolicLink()) fail(`Source tree contains a symbolic link and cannot be copied safely: ${rel}`);
      if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(root);
}

async function assertDependencyLinksAreInternal(root) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('Mobile node_modules must be a real directory, not a symbolic link');
  const canonicalRoot = await realpath(root);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const linkTarget = await readlink(file);
        if (isAbsolute(linkTarget)) fail(`Absolute dependency symlinks are unsupported: ${relative(root, file)}`);
        let target;
        try { target = await realpath(file); } catch { fail(`Broken dependency symlink: ${relative(root, file)}`); }
        if (!inside(canonicalRoot, target)) fail(`Dependency symlink escapes node_modules: ${relative(root, file)}`);
      } else if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(root);
}

export async function copyReleaseSources(config, workspace) {
  const mobile = join(workspace, 'apps/kcoder-studio/mobile');
  const shared = join(workspace, 'apps/kcoder-studio/shared');
  await assertNoSymlinks(config.mobile, 'mobile');
  await assertNoSymlinks(config.shared, 'shared');
  await assertDependencyLinksAreInternal(config.dependencies);
  await mkdir(dirname(mobile), { recursive: true, mode: 0o700 });
  await cp(config.mobile, mobile, {
    recursive: true, dereference: false, verbatimSymlinks: true,
    filter: source => {
      const rel = relative(config.mobile, source);
      return !rel || !ignoredSourceEntry(rel, 'mobile');
    },
  });
  await cp(config.shared, shared, {
    recursive: true, dereference: false, verbatimSymlinks: true,
    filter: source => {
      const rel = relative(config.shared, source);
      return !rel || !ignoredSourceEntry(rel, 'shared');
    },
  });
  const copiedDependencies = join(mobile, 'node_modules');
  await cp(config.dependencies, copiedDependencies, {
    recursive: true, dereference: false, verbatimSymlinks: true,
    filter: source => {
      const rel = relative(config.dependencies, source);
      return !rel || !rel.split(/[\\/]+/).some(part => part.startsWith('.env'));
    },
  });
  await assertDependencyLinksAreInternal(copiedDependencies);
  await chmod(workspace, 0o700);
  return { mobile, shared, dependencies: copiedDependencies };
}

function findMatchingBrace(source, open) {
  let depth = 0, state = 'code', quote = '', escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i], next = source[i + 1];
    if (state === 'line') { if (char === '\n') state = 'code'; continue; }
    if (state === 'block') { if (char === '*' && next === '/') { state = 'code'; i += 1; } continue; }
    if (state === 'string') {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) state = 'code';
      continue;
    }
    if (char === '/' && next === '/') { state = 'line'; i += 1; continue; }
    if (char === '/' && next === '*') { state = 'block'; i += 1; continue; }
    if (char === "'" || char === '"') { state = 'string'; quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return i;
  }
  return -1;
}

function findNamedBlock(source, name, start = 0, end = source.length) {
  const pattern = new RegExp(`\\b${name}\\s*\\{`, 'g');
  pattern.lastIndex = start;
  let match;
  while ((match = pattern.exec(source)) && match.index < end) {
    const open = source.indexOf('{', match.index);
    const close = findMatchingBrace(source, open);
    if (close >= 0 && close <= end) return { start: match.index, open, close };
  }
  return null;
}

export function replaceReleaseSigningConfig(source) {
  const android = findNamedBlock(source, 'android');
  if (!android) fail('Generated android/app/build.gradle has no android block');
  let signing = findNamedBlock(source, 'signingConfigs', android.open, android.close);
  const signingBody = `\n        kcoderRelease {\n            storeFile file(project.findProperty('kcoderReleaseStoreFile'))\n            storePassword project.findProperty('kcoderReleaseStorePassword')\n            keyAlias project.findProperty('kcoderReleaseKeyAlias')\n            keyPassword project.findProperty('kcoderReleaseKeyPassword')\n        }\n    `;
  if (signing) source = source.slice(0, signing.close) + signingBody + source.slice(signing.close);
  else source = source.slice(0, android.open + 1) + `\n    signingConfigs {${signingBody}}\n` + source.slice(android.open + 1);

  const updatedAndroid = findNamedBlock(source, 'android');
  const buildTypes = findNamedBlock(source, 'buildTypes', updatedAndroid.open, updatedAndroid.close);
  if (!buildTypes) fail('Generated build.gradle has no android.buildTypes block');
  const release = findNamedBlock(source, 'release', buildTypes.open, buildTypes.close);
  if (!release) fail('Generated build.gradle has no release build type');
  const block = source.slice(release.open + 1, release.close);
  const debugSigning = /\bsigningConfig\s+signingConfigs\.debug\b/g;
  const matches = [...block.matchAll(debugSigning)];
  if (matches.length !== 1) fail('Expected exactly one Expo release signingConfig pointing to debug');
  const updated = block.replace(debugSigning, 'signingConfig signingConfigs.kcoderRelease');
  return source.slice(0, release.open + 1) + updated + source.slice(release.close);
}

async function writePrivateLog(directory, name, text) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}.log`);
  await writeFile(path, text, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  return path;
}

export function redact(text, secrets) {
  let output = text;
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

let activeChild = null;
let interruptedSignal = null;
let activeKillTimer = null;

function signalChildGroup(child, signal) {
  try { process.kill(-child.pid, signal); }
  catch { child.kill(signal); }
}

function installSignalHandlers() {
  const handle = signal => {
    interruptedSignal ??= signal;
    if (!activeChild?.pid) return;
    const child = activeChild;
    signalChildGroup(child, 'SIGTERM');
    if (!activeKillTimer) {
      activeKillTimer = setTimeout(() => {
        if (activeChild === child) signalChildGroup(child, 'SIGKILL');
        activeKillTimer = null;
      }, 5000);
      activeKillTimer.unref();
    }
  };
  const onInterrupt = () => handle('SIGINT');
  const onTerminate = () => handle('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  return () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    if (activeKillTimer) clearTimeout(activeKillTimer);
    activeKillTimer = null;
  };
}

function assertNotInterrupted() {
  if (interruptedSignal) fail(`Interrupted by ${interruptedSignal}`);
}

export async function runCommand({ label, command, args, cwd, env, privateDir, secrets = [], capture = false }) {
  assertNotInterrupted();
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  activeChild = child;
  const parts = [];
  let bytes = 0, overflow = false, spawnError = null, tail = Buffer.alloc(0);
  const limit = capture ? 12 * 1024 * 1024 : 512 * 1024;
  const tailLimit = 512 * 1024;
  const remember = chunk => {
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > tailLimit) tail = tail.subarray(tail.length - tailLimit);
    if (!capture) return;
    const available = limit - bytes;
    if (chunk.length > available) overflow = true;
    if (available > 0) {
      const saved = chunk.subarray(0, available);
      bytes += saved.length;
      parts.push(Buffer.from(saved));
    }
  };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  child.on('error', error => { spawnError = error; });
  const code = await new Promise(resolveExit => child.on('close', (exitCode, signal) => resolveExit({ exitCode, signal })));
  if (activeChild === child) activeChild = null;
  if (activeKillTimer) clearTimeout(activeKillTimer);
  activeKillTimer = null;
  const output = capture ? Buffer.concat(parts).toString('utf8') : tail.toString('utf8');
  if (spawnError || code.exitCode !== 0 || (capture && overflow) || interruptedSignal) {
    const safe = redact(tail.toString('utf8').slice(-64 * 1024), secrets);
    let log = null;
    try { log = await writePrivateLog(join(privateDir, 'logs'), label.replace(/[^a-z0-9-]/gi, '-'), safe); } catch { /* preserve primary failure */ }
    if (safe) process.stderr.write(`${safe}\n`);
    fail(`${label} failed${interruptedSignal ? ` after ${interruptedSignal}` : spawnError ? ' to start' : ` (exit ${code.exitCode ?? code.signal})`}${overflow ? '; output exceeded the safe capture limit' : ''}${log ? `; redacted log: ${log}` : ''}`);
  }
  return output;
}

function runId() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-');
  return `${timestamp}-${randomBytes(4).toString('hex')}`;
}

function proxyLogSecrets(source) {
  return ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
    .map(key => source[key]).filter(Boolean);
}

async function gitProvenance(root, env, privateDir, secrets) {
  let commit = null, dirty = null;
  try {
    commit = (await runCommand({ label: 'source-commit', command: 'git', args: ['rev-parse', '--verify', 'HEAD'], cwd: root, env, privateDir, secrets, capture: true })).trim();
    const status = await runCommand({ label: 'source-status', command: 'git', args: ['status', '--porcelain', '--', 'apps/kcoder-studio/mobile', 'apps/kcoder-studio/shared'], cwd: root, env, privateDir, secrets, capture: true });
    dirty = status.trim().length > 0;
  } catch { /* provenance explicitly records unavailable Git identity */ }
  return { commit, mobileAndSharedDirty: dirty };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

export async function hashSourceTree(root, kind) {
  const hash = createHash('sha256');
  async function visit(directory, parent = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = parent ? `${parent}/${entry.name}` : entry.name;
      if (ignoredSourceEntry(rel, kind)) continue;
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`Source tree contains a symbolic link: ${rel}`);
      if (entry.isDirectory()) await visit(file, rel);
      else if (entry.isFile()) {
        hash.update(rel, 'utf8');
        hash.update('\0');
        hash.update(await readFile(file));
        hash.update('\0');
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

export function parseBadging(badging) {
  const packageLine = badging.split(/\r?\n/).find(line => line.startsWith('package:'));
  if (!packageLine) fail('aapt did not report APK package metadata');
  const get = key => packageLine.match(new RegExp(`(?:^|\\s)${key}='([^']*)'`))?.[1] ?? null;
  return {
    packageName: get('name'),
    versionCode: Number(get('versionCode')),
    versionName: get('versionName'),
    targetSdk: Number(badging.match(/targetSdkVersion:'(\d+)'/)?.[1] ?? 0),
    debuggable: /^application-debuggable\s*$/m.test(badging),
  };
}

export function validateApkMetadata({ badging, manifest, entries, hermesHeader, expectedVersionCode, expectedPackage }) {
  const metadata = parseBadging(badging);
  if (metadata.packageName !== expectedPackage) fail('APK application ID does not match the source app configuration');
  if (metadata.versionCode !== expectedVersionCode) fail('APK versionCode does not match --version-code');
  if (metadata.debuggable || /android:debuggable[^\n]*(?:true|0xffffffff|0x1)\b/i.test(manifest)) fail('APK manifest is debuggable');
  if (/android:usesCleartextTraffic[^\n]*(?:true|0xffffffff|0x1)\b/i.test(manifest)) fail('APK manifest permits cleartext traffic');
  if (metadata.targetSdk < 28) fail('APK targetSdk is too old to guarantee cleartext traffic is disabled by default');
  const libraries = entries.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('lib/'));
  if (!libraries.some(path => path.startsWith('lib/arm64-v8a/'))) fail('APK contains no arm64-v8a native libraries');
  if (libraries.some(path => /^lib\/(?!arm64-v8a\/)[^/]+\//.test(path))) fail('APK contains a non-arm64 native ABI');
  if (!entries.split(/\r?\n/).some(line => line.trim() === 'assets/index.android.bundle')) fail('APK has no Android JS bundle');
  if (!Buffer.from(hermesHeader).subarray(0, HERMES_MAGIC.length).equals(HERMES_MAGIC)) fail('Android JS bundle is not Hermes bytecode');
  return metadata;
}

export async function inspectApk({ apk, config, env, privateDir, secrets, jar, aapt, apksigner, verifyDir }) {
  await mkdir(verifyDir, { recursive: true, mode: 0o700 });
  const entries = await runCommand({ label: 'apk-entry-list', command: jar, args: ['tf', apk], cwd: verifyDir, env, privateDir, secrets, capture: true });
  const badging = await runCommand({ label: 'apk-badging', command: aapt, args: ['dump', 'badging', apk], cwd: verifyDir, env, privateDir, secrets, capture: true });
  const manifest = await runCommand({ label: 'apk-manifest', command: aapt, args: ['dump', 'xmltree', apk, 'AndroidManifest.xml'], cwd: verifyDir, env, privateDir, secrets, capture: true });
  const signature = await runCommand({ label: 'apk-signature', command: apksigner, args: ['verify', '--verbose', '--print-certs', apk], cwd: verifyDir, env, privateDir, secrets, capture: true });
  if (!(await isRegularFile(join(verifyDir, 'assets/index.android.bundle')))) {
    await runCommand({ label: 'hermes-bundle-extract', command: jar, args: ['xf', apk, 'assets/index.android.bundle'], cwd: verifyDir, env, privateDir, secrets });
  }
  const hermes = await open(join(verifyDir, 'assets/index.android.bundle'), 'r');
  const header = Buffer.alloc(8);
  try { await hermes.read(header, 0, header.length, 0); } finally { await hermes.close(); }
  const metadata = validateApkMetadata({ badging, manifest, entries, hermesHeader: header, expectedVersionCode: config.versionCode, expectedPackage: config.appId });
  const certDigest = /Signer #1 certificate SHA-256 digest:\s*([a-f0-9:]+)/i.exec(signature)?.[1]?.replaceAll(':', '').toLowerCase();
  if (!certDigest || !/^[a-f0-9]{64}$/.test(certDigest)) fail('apksigner did not report a valid signer SHA-256 fingerprint');
  return { metadata, certificateSha256: certDigest, hermesBundle: 'assets/index.android.bundle' };
}

async function build(args) {
  const config = await preflight(args);
  const password = process.env[STORE_PASSWORD_ENV];
  const keyPassword = process.env[KEY_PASSWORD_ENV] || password;
  const secrets = [password, keyPassword, ...proxyLogSecrets(process.env)];
  if (args.dryRun) {
    process.stdout.write(`Preflight passed. No files copied and no build tools started.\n`);
    process.stdout.write(`Plan: copy Mobile/shared and installed dependencies into a private workspace; build terminal WebView; Expo prebuild; assemble Release for arm64-v8a${args.offline ? ' offline' : ''}; verify APK signature, manifest, versionCode, ABI, and Hermes bundle.\n`);
    process.stdout.write(`Output root: ${PACKAGES_ROOT}\n`);
    process.stdout.write(`Signing: keystore path and alias are configured; password values are not displayed.\n`);
    return;
  }

  const id = runId();
  const outputDir = join(PACKAGES_ROOT, `${id}-arm64-release`);
  const privateDir = join(PACKAGES_ROOT, `.${id}.private`);
  let ownsOutput = false, ownsPrivate = false, success = false;
  try {
    await mkdir(PACKAGES_ROOT, { recursive: true });
    await mkdir(outputDir, { recursive: false, mode: 0o755 }); ownsOutput = true;
    await mkdir(privateDir, { recursive: false, mode: 0o700 }); ownsPrivate = true;
    await chmod(privateDir, 0o700);
    const workspace = join(privateDir, 'workspace');
    await mkdir(workspace, { mode: 0o700 });
    const baseEnv = createBuildEnvironment(config, process.env, { privateDir, offline: args.offline });
    await writeFile(baseEnv.NPM_CONFIG_USERCONFIG, '', { mode: 0o600, flag: 'wx' });
    await writeFile(baseEnv.NPM_CONFIG_GLOBALCONFIG, '', { mode: 0o600, flag: 'wx' });
    const source = {
      ...await gitProvenance(config.root, baseEnv, privateDir, secrets),
      mobileTreeSha256: await hashSourceTree(config.mobile, 'mobile'),
      sharedTreeSha256: await hashSourceTree(config.shared, 'shared'),
    };
    assertNotInterrupted();
    const staged = await copyReleaseSources(config, workspace);
    if (await hashSourceTree(staged.mobile, 'mobile') !== source.mobileTreeSha256 || await hashSourceTree(staged.shared, 'shared') !== source.sharedTreeSha256) {
      fail('Mobile/shared source changed while the private build copy was being created');
    }
    assertNotInterrupted();
    const stagedConfig = JSON.parse(await readFile(join(staged.mobile, 'app.json'), 'utf8'));
    stagedConfig.expo.android.versionCode = config.versionCode;
    await writeFile(join(staged.mobile, 'app.json'), `${JSON.stringify(stagedConfig, null, 2)}\n`, { mode: 0o600 });

    const privateKeystore = join(privateDir, 'release.keystore');
    await copyFile(config.keystore, privateKeystore, fsConstants.COPYFILE_EXCL);
    await chmod(privateKeystore, 0o600);
    const certificateFile = join(privateDir, 'release-certificate.der');
    const keytoolEnv = { ...baseEnv, [STORE_PASSWORD_ENV]: password };
    await runCommand({
      label: 'keystore-alias', command: config.keytool,
      args: ['-exportcert', '-keystore', privateKeystore, '-alias', args.keyAlias, '-storepass:env', STORE_PASSWORD_ENV, '-file', certificateFile],
      cwd: privateDir, env: keytoolEnv, privateDir, secrets,
    });
    const expectedCertificateSha256 = await hashFile(certificateFile);
    await rm(certificateFile, { force: true });
    config.keystoreCopy = privateKeystore;
    config.keyAlias = args.keyAlias;
    const env = baseEnv;
    const script = join(staged.mobile, 'scripts/build-terminal-webview.mjs');
    process.stdout.write('Building terminal WebView in the isolated copy…\n');
    await runCommand({ label: 'terminal-webview', command: process.execPath, args: [script], cwd: staged.mobile, env, privateDir, secrets });
    process.stdout.write('Generating Android project with Expo…\n');
    await runCommand({
      label: 'expo-prebuild', command: process.execPath,
      args: [join(staged.dependencies, 'expo/bin/cli'), 'prebuild', '--platform', 'android', '--no-install'],
      cwd: staged.mobile, env, privateDir, secrets,
    });

    const android = join(staged.mobile, 'android');
    const gradleFile = join(android, 'app/build.gradle');
    const originalGradle = await readFile(gradleFile, 'utf8');
    await writeFile(gradleFile, replaceReleaseSigningConfig(originalGradle), { mode: 0o600 });
    const directGradle = config.gradle;
    const wrapper = join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    const gradle = directGradle ?? wrapper;
    if (!(await isRegularFile(gradle))) fail(directGradle ? 'Configured Gradle executable disappeared' : 'Expo prebuild did not generate the Gradle wrapper');
    const gradleEnv = createGradleEnvironment(env, config);
    const gradleArgs = createGradleArguments(android, { offline: args.offline });
    process.stdout.write(`Assembling signed Android Release for arm64-v8a${args.offline ? ' offline' : ''}…\n`);
    await runCommand({ label: 'gradle-assemble-release', command: gradle, args: gradleArgs, cwd: staged.mobile, env: gradleEnv, privateDir, secrets });

    const apk = join(android, 'app/build/outputs/apk/release/app-release.apk');
    if (!(await isRegularFile(apk))) fail('Gradle succeeded but did not produce app-release.apk');
    const inspected = await inspectApk({
      apk, config, env, privateDir, secrets, jar: config.jar, aapt: config.aapt,
      apksigner: config.apksigner, verifyDir: join(privateDir, 'apk-inspection'),
    });
    if (inspected.certificateSha256 !== expectedCertificateSha256) fail('APK signer certificate does not match the selected keystore alias');
    const apkName = `kcoder-studio-mobile-${config.appVersion}-android-arm64-v8a-v${config.versionCode}.apk`;
    const outputApk = join(outputDir, apkName);
    await copyFile(apk, outputApk, fsConstants.COPYFILE_EXCL);
    const sha256 = await hashFile(outputApk);
    await writeFile(join(outputDir, `${apkName}.sha256`), `${sha256}  ${apkName}\n`, { mode: 0o644, flag: 'wx' });
    const provenance = {
      schemaVersion: 1,
      builtAt: new Date().toISOString(),
      artifact: apkName,
      sha256,
      applicationId: inspected.metadata.packageName,
      version: inspected.metadata.versionName,
      versionCode: inspected.metadata.versionCode,
      targetSdk: inspected.metadata.targetSdk,
      architecture: 'arm64-v8a',
      hermesBundle: inspected.hermesBundle,
      signature: { verified: true, certificateSha256: inspected.certificateSha256, alias: args.keyAlias },
      source: { ...source, androidVersionCodeOverride: config.versionCode },
      toolchain: { node: process.version, androidBuildTools: relative(config.sdk, config.buildToolsDir) },
    };
    await writeFile(join(outputDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
    await chmod(outputDir, 0o755);
    assertNotInterrupted();
    success = true;
    process.stdout.write(`Release package verified: ${outputApk}\nSHA-256: ${sha256}\nProvenance: ${join(outputDir, 'provenance.json')}\n`);
  } finally {
    if (ownsPrivate) {
      await rm(join(privateDir, 'release.keystore'), { force: true });
      await rm(join(privateDir, 'release-certificate.der'), { force: true });
      if (success) await rm(privateDir, { recursive: true, force: true });
      else {
        await rm(join(privateDir, 'workspace'), { recursive: true, force: true });
        await rm(join(privateDir, 'apk-inspection'), { recursive: true, force: true });
        await chmod(privateDir, 0o700).catch(() => {});
      }
    }
    if (ownsOutput && !success) await rm(outputDir, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const uninstallSignals = installSignalHandlers();
  try {
    const args = parseArgs(argv);
    if (args.help) { process.stdout.write(HELP); return 0; }
    await build(args);
    assertNotInterrupted();
    return 0;
  } catch (error) {
    const safe = redact(error instanceof Error ? error.message : String(error), [process.env[STORE_PASSWORD_ENV], process.env[KEY_PASSWORD_ENV]]);
    process.stderr.write(`Android release packaging failed: ${safe}\n`);
    return 1;
  } finally {
    uninstallSignals();
    interruptedSignal = null;
    activeChild = null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
