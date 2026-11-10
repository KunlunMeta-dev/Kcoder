import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { runE2E, repoRoot } from "../harness/run-context.mjs";
import { hashSourceTree } from "../../../../scripts/release/package_mobile_android.mjs";

const SDK_ROOT = process.env.KCODER_ANDROID_SDK_ROOT || "/tmp/kcoder-mobile-sdk";
const JAVA_HOME = process.env.KCODER_ANDROID_JAVA_HOME || "/usr/lib/jvm/java-21-openjdk-amd64";
const GRADLE_USER_HOME = process.env.KCODER_ANDROID_GRADLE_USER_HOME || join(SDK_ROOT, "gradle-cache");
const EXPECTED_WEBRTC_VERSION = "124.0.6";
const EXPECTED_CONFIG_PLUGIN_VERSION = "13.0.0";
const HERMES_MAGIC = "c61fbc03c103191f";
const FORBIDDEN_PERMISSIONS = [
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.BLUETOOTH",
  "android.permission.BLUETOOTH_ADMIN",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.SYSTEM_ALERT_WINDOW",
];

function parseFreezeHashes(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const [option, inlineValue] = argv[index].split(/=(.*)/s, 2);
    if (!["--mobile-source-sha256", "--shared-source-sha256"].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value || values.has(option) || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`${option} requires one lowercase SHA-256 digest`);
    }
    values.set(option, value);
  }
  const mobile = values.get("--mobile-source-sha256");
  const shared = values.get("--shared-source-sha256");
  if (!mobile || !shared) {
    throw new Error("Usage: node mobile-peer-android-build.once.mjs --mobile-source-sha256 HEX --shared-source-sha256 HEX");
  }
  return { mobile, shared };
}

async function requireExecutable(path, label) {
  try {
    await access(path, fsConstants.X_OK);
  } catch {
    throw new Error(`${label} is not executable: ${path}`);
  }
  return path;
}

function compareVersions(left, right) {
  const a = left.split(".").map(part => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map(part => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return left.localeCompare(right);
}

async function resolveBuildTools() {
  const root = join(SDK_ROOT, "build-tools");
  const versions = (await readdir(root)).filter(name => /^\d+(?:\.\d+)+$/.test(name)).sort(compareVersions).reverse();
  for (const version of versions) {
    const directory = join(root, version);
    const aapt = join(directory, "aapt");
    const apksigner = join(directory, "apksigner");
    try {
      await Promise.all([access(aapt, fsConstants.X_OK), access(apksigner, fsConstants.X_OK)]);
      return { directory, version, aapt, apksigner };
    } catch {
      // Try the next installed build-tools version.
    }
  }
  throw new Error("Android SDK build-tools with aapt and apksigner were not found");
}

async function resolveCachedGradle() {
  const root = join(GRADLE_USER_HOME, "wrapper/dists/gradle-8.14.3-bin");
  const owners = (await readdir(root)).sort();
  for (const owner of owners) {
    const candidate = join(root, owner, "gradle-8.14.3/bin/gradle");
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try another cache instance for the same pinned Gradle distribution.
    }
  }
  throw new Error("Cached Gradle 8.14.3 executable was not found");
}

async function verifyDeclaredDependencies() {
  const mobile = join(repoRoot, "apps/kcoder-studio/mobile");
  const packageJson = JSON.parse(await readFile(join(mobile, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(mobile, "package-lock.json"), "utf8"));
  const webRtcInstalled = JSON.parse(await readFile(join(mobile, "node_modules/react-native-webrtc/package.json"), "utf8"));
  const pluginInstalled = JSON.parse(await readFile(join(mobile, "node_modules/@config-plugins/react-native-webrtc/package.json"), "utf8"));
  const dependencyIdentity = [
    ["react-native-webrtc", EXPECTED_WEBRTC_VERSION],
    ["@config-plugins/react-native-webrtc", EXPECTED_CONFIG_PLUGIN_VERSION],
  ];
  for (const [name, version] of dependencyIdentity) {
    assert.equal(packageJson.dependencies?.[name], version, `${name} package.json version changed`);
    assert.equal(lock.packages?.[`node_modules/${name}`]?.version, version, `${name} package-lock version changed`);
  }
  assert.equal(webRtcInstalled.version, EXPECTED_WEBRTC_VERSION, "installed react-native-webrtc version differs");
  assert.equal(pluginInstalled.version, EXPECTED_CONFIG_PLUGIN_VERSION, "installed WebRTC config plugin version differs");
  return { reactNativeWebrtc: webRtcInstalled.version, configPlugin: pluginInstalled.version };
}

function buildEnvironment(context, buildTools) {
  const pathEntries = [
    dirname(process.execPath),
    join(JAVA_HOME, "bin"),
    join(SDK_ROOT, "platform-tools"),
    buildTools.directory,
    process.env.PATH || "",
  ];
  const env = {
    PATH: pathEntries.filter(Boolean).join(delimiter),
    HOME: context.pathInState("home"),
    TMPDIR: context.pathInState("tmp"),
    LANG: process.env.LANG || "C.UTF-8",
    JAVA_HOME,
    ANDROID_HOME: SDK_ROOT,
    ANDROID_SDK_ROOT: SDK_ROOT,
    GRADLE_USER_HOME,
    CI: "1",
  };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
    const value = process.env[key];
    if (!value) continue;
    try {
      const proxy = new URL(value);
      if (proxy.username || proxy.password) continue;
    } catch {
      if (/@[^/\s]+(?::\d+)?(?:\/|$)/.test(value)) continue;
    }
    env[key] = value;
  }
  return env;
}

async function waitForOwnedProcess(context, label, child, timeoutMs) {
  let timer;
  try {
    const outcome = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    await context.stopOwned(label);
    if (outcome.code !== 0) throw new Error(`${label} exited with ${outcome.signal || outcome.code}`);
  } catch (error) {
    await context.stopOwned(label).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runOwned(context, label, command, args, env, cwd, timeoutMs) {
  const child = context.spawnOwned(label, command, args, { cwd, env });
  await waitForOwnedProcess(context, label, child, timeoutMs);
  return readFile(join(context.logsDir, `${label}.log`), "utf8");
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function runToolPreflight(context) {
  const buildTools = await resolveBuildTools();
  const gradle = await resolveCachedGradle();
  const env = buildEnvironment(context, buildTools);
  await Promise.all([
    mkdir(env.HOME, { recursive: true, mode: 0o700 }),
    mkdir(env.TMPDIR, { recursive: true, mode: 0o700 }),
  ]);
  const password = randomBytes(32).toString("base64url");
  context.registerSecret(password);
  env.KCODER_ANDROID_KEYSTORE_PASSWORD = password;
  env.KCODER_ANDROID_KEY_PASSWORD = password;
  const keystore = context.pathInState("android-validation", "temporary-signing.p12");
  await mkdir(dirname(keystore), { recursive: true, mode: 0o700 });
  const keytool = join(JAVA_HOME, "bin/keytool");
  const keytoolLog = await runOwned(context, "preflight-temporary-key", keytool, [
    "-genkeypair", "-noprompt", "-storetype", "PKCS12", "-keystore", keystore,
    "-alias", "kcoder-mobile-build-validation", "-keyalg", "RSA", "-keysize", "2048",
    "-validity", "2", "-dname", "CN=KCoder Android Build Validation",
    "-storepass:env", "KCODER_ANDROID_KEYSTORE_PASSWORD",
    "-keypass:env", "KCODER_ANDROID_KEY_PASSWORD",
  ], env, repoRoot, 30_000);
  assert.match(keytoolLog, /Generating/iu, "keytool did not report temporary key generation");
  assert.ok((await stat(keystore)).isFile(), "keytool did not create a temporary signing keystore");
  const gradleLog = await runOwned(context, "preflight-gradle-version", gradle, ["--version"], env, repoRoot, 30_000);
  assert.match(gradleLog, /Gradle 8\.14\.3/u, "cached Gradle version differs from the pinned build plan");
  const aaptLog = await runOwned(context, "preflight-aapt-version", buildTools.aapt, ["version"], env, repoRoot, 30_000);
  assert.match(aaptLog, /Android Asset Packaging Tool/u, "Android aapt preflight failed");
  const report = {
    schemaVersion: 1,
    status: "passed",
    buildStarted: false,
    sourceCopied: false,
    temporaryKeystoreGeneratedAndRunOwned: true,
    temporaryKeystoreRetained: false,
    toolchain: {
      node: process.version,
      java: JAVA_HOME,
      androidSdk: SDK_ROOT,
      androidBuildTools: buildTools.version,
      ndk: "27.1.12297006",
      gradle: "8.14.3",
      gradleCache: GRADLE_USER_HOME,
    },
    runnerSha256: await sha256File(context.sourcePath),
  };
  await context.writeArtifactJson("android-arm64-tool-preflight.json", report);
  return report;
}

function parsePermissions(aaptOutput) {
  return [...aaptOutput.matchAll(/uses-permission[^:]*:\s*name='([^']+)'/g)].map(match => match[1]).sort();
}

async function runBuild(context, frozenHashes) {
  const runnerSha256 = await sha256File(context.sourcePath);
  const mobileRoot = join(repoRoot, "apps/kcoder-studio/mobile");
  const sharedRoot = join(repoRoot, "apps/kcoder-studio/shared");
  const mobileHashBefore = await hashSourceTree(mobileRoot, "mobile");
  const sharedHashBefore = await hashSourceTree(sharedRoot, "shared");
  assert.equal(mobileHashBefore, frozenHashes.mobile, "Mobile source does not match the supplied freeze hash");
  assert.equal(sharedHashBefore, frozenHashes.shared, "Studio shared source does not match the supplied freeze hash");
  const dependencies = await verifyDeclaredDependencies();

  await requireExecutable(join(JAVA_HOME, "bin/java"), "JDK java");
  const jar = await requireExecutable(join(JAVA_HOME, "bin/jar"), "JDK jar");
  const keytool = await requireExecutable(join(JAVA_HOME, "bin/keytool"), "JDK keytool");
  const ndk = join(SDK_ROOT, "ndk/27.1.12297006/source.properties");
  await stat(ndk);
  const buildTools = await resolveBuildTools();
  const gradle = await resolveCachedGradle();
  const env = buildEnvironment(context, buildTools);
  await Promise.all([
    mkdir(env.HOME, { recursive: true, mode: 0o700 }),
    mkdir(env.TMPDIR, { recursive: true, mode: 0o700 }),
  ]);
  const password = randomBytes(32).toString("base64url");
  context.registerSecret(password);
  env.KCODER_ANDROID_KEYSTORE_PASSWORD = password;
  env.KCODER_ANDROID_KEY_PASSWORD = password;

  const keystore = context.pathInState("android-validation", "temporary-signing.p12");
  await mkdir(dirname(keystore), { recursive: true, mode: 0o700 });
  const keytoolLog = await runOwned(context, "generate-temporary-signing-key", keytool, [
    "-genkeypair", "-noprompt", "-storetype", "PKCS12", "-keystore", keystore,
    "-alias", "kcoder-mobile-build-validation", "-keyalg", "RSA", "-keysize", "2048",
    "-validity", "2", "-dname", "CN=KCoder Android Build Validation",
    "-storepass:env", "KCODER_ANDROID_KEYSTORE_PASSWORD",
    "-keypass:env", "KCODER_ANDROID_KEY_PASSWORD",
  ], env, repoRoot, 30_000);
  assert.match(keytoolLog, /Generating/iu, "keytool did not report temporary key generation");

  const packageScript = join(repoRoot, "scripts/release/package_mobile_android.mjs");
  const packageLog = await runOwned(context, "android-arm64-package", process.execPath, [
    packageScript,
    "--version-code", "1",
    "--keystore", keystore,
    "--key-alias", "kcoder-mobile-build-validation",
    "--sdk", SDK_ROOT,
    "--java-home", JAVA_HOME,
    "--gradle", gradle,
  ], env, repoRoot, 60 * 60 * 1000);
  const apkMatch = packageLog.match(/Release package verified:\s*(.+\.apk)\s*$/m);
  assert.ok(apkMatch, "Android package script did not report a verified APK path");
  const apkPath = resolve(apkMatch[1]);
  const packageRoot = resolve(repoRoot, "target/packages/kcoder-studio-mobile");
  const relativeApk = relative(packageRoot, apkPath);
  assert.ok(relativeApk && relativeApk !== ".." && !relativeApk.startsWith(`..${sep}`), "verified APK escaped the package output root");

  const packageDirectory = dirname(apkPath);
  const provenance = JSON.parse(await readFile(join(packageDirectory, "provenance.json"), "utf8"));
  assert.equal(provenance.architecture, "arm64-v8a");
  assert.equal(provenance.versionCode, 1);
  assert.equal(provenance.signature?.verified, true);
  assert.equal(provenance.source?.mobileTreeSha256, mobileHashBefore);
  assert.equal(provenance.source?.sharedTreeSha256, sharedHashBefore);
  const apkSha256 = await sha256File(apkPath);
  assert.equal(provenance.sha256, apkSha256, "APK bytes do not match package provenance");

  const archiveList = await runOwned(context, "inspect-apk-entries", jar, ["tf", apkPath], env, repoRoot, 60_000);
  const entries = archiveList.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.ok(entries.includes("assets/index.android.bundle"), "APK is missing its Hermes bundle");
  const arm64Libraries = entries.filter(entry => /^lib\/arm64-v8a\/[^/]+\.so$/.test(entry)).sort();
  assert.ok(arm64Libraries.some(entry => /jingle|webrtc/i.test(entry)), "APK is missing the WebRTC native shared library");

  const permissionLog = await runOwned(context, "inspect-apk-permissions", buildTools.aapt, ["dump", "permissions", apkPath], env, repoRoot, 60_000);
  const permissions = parsePermissions(permissionLog);
  const forbiddenPermissions = permissions.filter(permission => FORBIDDEN_PERMISSIONS.includes(permission));
  assert.deepEqual(forbiddenPermissions, [], "APK requests a blocked microphone, audio-routing, Bluetooth, or overlay permission");

  const extractRoot = context.pathInState("apk-native-inspection");
  await mkdir(extractRoot, { recursive: true, mode: 0o700 });
  const webrtcLibraries = arm64Libraries.filter(entry => /jingle|webrtc/i.test(entry));
  await runOwned(context, "extract-apk-validation-inputs", jar, [
    "xf", apkPath, "assets/index.android.bundle", ...webrtcLibraries,
  ], env, extractRoot, 60_000);
  const hermesHandle = await open(join(extractRoot, "assets/index.android.bundle"), "r");
  const hermesHeader = Buffer.alloc(8);
  try {
    const { bytesRead } = await hermesHandle.read(hermesHeader, 0, hermesHeader.length, 0);
    assert.equal(bytesRead, hermesHeader.length, "Hermes bundle header is truncated");
  } finally {
    await hermesHandle.close();
  }
  const hermesMagic = hermesHeader.toString("hex");
  assert.equal(hermesMagic, HERMES_MAGIC, "APK bundle does not contain Hermes bytecode");
  const readelfCandidates = [
    join(SDK_ROOT, "ndk/27.1.12297006/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf"),
    "/usr/bin/readelf",
  ];
  let readelf = null;
  for (const candidate of readelfCandidates) {
    try {
      readelf = await requireExecutable(candidate, "ELF reader");
      break;
    } catch {
      // Use another installed ELF reader.
    }
  }
  assert.ok(readelf, "No ELF reader is available for the APK's WebRTC library");
  const nativeLibraryElves = [];
  for (const [index, entry] of webrtcLibraries.entries()) {
    const nativeLibraryPath = join(extractRoot, entry);
    const elfLog = await runOwned(context, `inspect-webrtc-elf-${index + 1}`, readelf, ["-h", nativeLibraryPath], env, repoRoot, 60_000);
    assert.match(elfLog, /Machine:\s+AArch64/u, `${entry} is not an AArch64 ELF binary`);
    nativeLibraryElves.push({ path: entry, machine: "AArch64" });
  }

  const mobileHashAfter = await hashSourceTree(mobileRoot, "mobile");
  const sharedHashAfter = await hashSourceTree(sharedRoot, "shared");
  assert.equal(mobileHashAfter, mobileHashBefore, "Mobile source changed during Android build");
  assert.equal(sharedHashAfter, sharedHashBefore, "Studio shared source changed during Android build");
  const result = {
    schemaVersion: 1,
    status: "passed",
    verificationOnly: true,
    distributable: false,
    installedOnDevice: false,
    sourceFreeze: {
      commit: provenance.source?.commit ?? null,
      mobileAndSharedDirty: provenance.source?.mobileAndSharedDirty ?? null,
      mobileSha256: mobileHashBefore,
      sharedSha256: sharedHashBefore,
      mobileHashUnchanged: true,
      sharedHashUnchanged: true,
    },
    runnerSha256,
    dependencies,
    toolchain: {
      node: process.version,
      java: JAVA_HOME,
      androidSdk: SDK_ROOT,
      androidBuildTools: buildTools.version,
      ndk: "27.1.12297006",
      gradle: "8.14.3",
    },
    apk: {
      path: relative(repoRoot, apkPath),
      sha256: apkSha256,
      packageName: provenance.applicationId,
      version: provenance.version,
      versionCode: provenance.versionCode,
      targetSdk: provenance.targetSdk,
      architecture: provenance.architecture,
      hermesBundle: provenance.hermesBundle,
      hermesBytecodeMagic: hermesMagic,
      signatureVerified: provenance.signature.verified,
      temporarySignerSha256: provenance.signature.certificateSha256,
      requestedPermissions: permissions,
      permissionAudit: {
        blockingCategories: ["microphone recording", "audio routing changes", "Bluetooth", "system overlay"],
        existingPhotoPickerMediaPermissionsReportedOnly: true,
      },
      webRtcNativeLibraries: webrtcLibraries,
      webRtcNativeLibraryElves: nativeLibraryElves,
    },
    limitation: "Build and APK content only; no Android device installation or live peer-connection acceptance.",
  };
  await context.writeArtifactJson("android-arm64-build.json", result);
  return result;
}

const args = process.argv.slice(2);
const metadata = {
  suite: "mobile-peer-android-arm64-build",
  modelIndependent: true,
  processSignalTimeoutMs: 10_000,
  streamCloseTimeoutMs: 10_000,
};
if (args.length === 1 && args[0] === "--preflight-only") {
  await runE2E(new URL(import.meta.url), metadata, context => runToolPreflight(context));
} else {
  const frozenHashes = parseFreezeHashes(args);
  await runE2E(new URL(import.meta.url), metadata, context => runBuild(context, frozenHashes));
}
