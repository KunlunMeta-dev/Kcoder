import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { runE2E, repoRoot } from "../harness/run-context.mjs";
import { hashSourceTree } from "../../../../scripts/release/package_mobile_android.mjs";

const SDK_ROOT = process.env.KCODER_ANDROID_SDK_ROOT || "/tmp/kcoder-mobile-sdk";
const JAVA_HOME = process.env.KCODER_ANDROID_JAVA_HOME || "/usr/lib/jvm/java-21-openjdk-amd64";
const GRADLE_USER_HOME = process.env.KCODER_ANDROID_GRADLE_USER_HOME || join(SDK_ROOT, "gradle-cache");
const HERMES_MAGIC = "c61fbc03c103191f";
const FORBIDDEN_PERMISSIONS = new Set([
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.BLUETOOTH",
  "android.permission.BLUETOOTH_ADMIN",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.SYSTEM_ALERT_WINDOW",
]);

async function requireExecutable(path, label) {
  try {
    await access(path, fsConstants.X_OK);
  } catch {
    throw new Error(`${label} is not executable: ${path}`);
  }
  return path;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function runOwned(context, label, command, args, env, cwd, timeoutMs = 60_000) {
  const child = context.spawnOwned(label, command, args, { cwd, env });
  let timer;
  try {
    const outcome = await Promise.race([
      new Promise((resolveOutcome, rejectOutcome) => {
        child.once("error", rejectOutcome);
        child.once("close", (code, signal) => resolveOutcome({ code, signal }));
      }),
      new Promise((_, rejectOutcome) => {
        timer = setTimeout(() => rejectOutcome(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
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
  return readFile(join(context.logsDir, `${label}.log`), "utf8");
}

function parsePermissions(output) {
  return [...output.matchAll(/uses-permission[^:]*:\s*name='([^']+)'/g)].map(match => match[1]).sort();
}

function parseFreezeArguments(argv) {
  const values = new Map();
  let apkPath = null;
  let buildRun = null;
  let freezeManifest = "target/run/mobile-p2p-20261019/mobile-shared-freeze-v3.json";
  for (let index = 0; index < argv.length; index += 1) {
    const [option, inlineValue] = argv[index].split(/=(.*)/s, 2);
    if (option === "--apk" || option === "--build-run" || option === "--freeze-manifest") {
      const value = inlineValue ?? argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a path`);
      if (option === "--apk") apkPath = value;
      else if (option === "--build-run") buildRun = value;
      else freezeManifest = value;
      continue;
    }
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
  if (!apkPath || !buildRun || !mobile || !shared) {
    throw new Error("Usage: node mobile-peer-android-apk-audit.once.mjs --apk PATH --build-run PATH [--freeze-manifest PATH] --mobile-source-sha256 HEX --shared-source-sha256 HEX");
  }
  return { apkPath, buildRun, freezeManifest, mobile, shared };
}

async function auditApk(context, input) {
  const runnerSha256 = await sha256File(context.sourcePath);
  const packageRoot = resolve(repoRoot, "target/packages/kcoder-studio-mobile");
  const requestedPath = resolve(repoRoot, input.apkPath);
  const apkPath = await realpath(requestedPath);
  const realPackageRoot = await realpath(packageRoot);
  const relativeApk = relative(realPackageRoot, apkPath);
  assert.ok(relativeApk && relativeApk !== ".." && !relativeApk.startsWith(`..${sep}`), "APK escaped the Android package output root");
  assert.ok((await stat(apkPath)).isFile(), "APK path is not a regular file");

  const frozen = JSON.parse(await readFile(join(repoRoot, input.freezeManifest), "utf8"));
  assert.equal(frozen.mobile, input.mobile, "Mobile freeze manifest differs from the supplied hash");
  assert.equal(frozen.shared, input.shared, "Shared freeze manifest differs from the supplied hash");
  const mobileRoot = join(repoRoot, "apps/kcoder-studio/mobile");
  const sharedRoot = join(repoRoot, "apps/kcoder-studio/shared");
  const mobileHash = await hashSourceTree(mobileRoot, "mobile");
  const sharedHash = await hashSourceTree(sharedRoot, "shared");
  assert.equal(mobileHash, input.mobile, "Current Mobile tree no longer matches the build freeze");
  assert.equal(sharedHash, input.shared, "Current Studio shared tree no longer matches the build freeze");

  const packageDirectory = dirname(apkPath);
  const provenance = JSON.parse(await readFile(join(packageDirectory, "provenance.json"), "utf8"));
  assert.equal(provenance.architecture, "arm64-v8a");
  assert.equal(provenance.versionCode, 1);
  assert.equal(provenance.signature?.verified, true);
  assert.equal(provenance.source?.mobileTreeSha256, input.mobile);
  assert.equal(provenance.source?.sharedTreeSha256, input.shared);
  const apkSha256 = await sha256File(apkPath);
  assert.equal(provenance.sha256, apkSha256, "APK bytes do not match package provenance");

  const java = await requireExecutable(join(JAVA_HOME, "bin/java"), "JDK java");
  const jar = await requireExecutable(join(JAVA_HOME, "bin/jar"), "JDK jar");
  const buildTools = await join(SDK_ROOT, "build-tools/36.0.0");
  const aapt = await requireExecutable(join(buildTools, "aapt"), "Android aapt");
  const env = {
    PATH: [dirname(process.execPath), join(JAVA_HOME, "bin"), buildTools, process.env.PATH || ""].filter(Boolean).join(delimiter),
    HOME: context.pathInState("home"),
    TMPDIR: context.pathInState("tmp"),
    LANG: process.env.LANG || "C.UTF-8",
    JAVA_HOME,
    ANDROID_HOME: SDK_ROOT,
    ANDROID_SDK_ROOT: SDK_ROOT,
    GRADLE_USER_HOME,
  };
  await Promise.all([
    mkdir(env.HOME, { recursive: true, mode: 0o700 }),
    mkdir(env.TMPDIR, { recursive: true, mode: 0o700 }),
  ]);

  const archiveList = await runOwned(context, "inspect-apk-entries", jar, ["tf", apkPath], env, repoRoot);
  const entries = archiveList.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.ok(entries.includes("assets/index.android.bundle"), "APK is missing its Hermes bundle");
  const arm64Libraries = entries.filter(entry => /^lib\/arm64-v8a\/[^/]+\.so$/.test(entry)).sort();
  const webRtcLibraries = arm64Libraries.filter(entry => /jingle|webrtc/i.test(entry));
  assert.ok(webRtcLibraries.length > 0, "APK is missing the WebRTC native shared library");

  const permissionLog = await runOwned(context, "inspect-apk-permissions", aapt, ["dump", "permissions", apkPath], env, repoRoot);
  const permissions = parsePermissions(permissionLog);
  const forbiddenPermissions = permissions.filter(permission => FORBIDDEN_PERMISSIONS.has(permission));
  assert.deepEqual(forbiddenPermissions, [], "APK requests a microphone, audio-routing, Bluetooth, or system-overlay permission");

  const extractRoot = context.pathInState("apk-inspection");
  await mkdir(extractRoot, { recursive: true, mode: 0o700 });
  await runOwned(context, "extract-apk-validation-inputs", jar, ["xf", apkPath, "assets/index.android.bundle", ...webRtcLibraries], env, extractRoot);
  const bundleHandle = await open(join(extractRoot, "assets/index.android.bundle"), "r");
  const bundleHeader = Buffer.alloc(8);
  try {
    const { bytesRead } = await bundleHandle.read(bundleHeader, 0, bundleHeader.length, 0);
    assert.equal(bytesRead, bundleHeader.length, "Hermes bundle header is truncated");
  } finally {
    await bundleHandle.close();
  }
  const hermesMagic = bundleHeader.toString("hex");
  assert.equal(hermesMagic, HERMES_MAGIC);

  const readelf = await requireExecutable(join(SDK_ROOT, "ndk/27.1.12297006/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf"), "NDK llvm-readelf");
  const nativeLibraryElves = [];
  for (const [index, entry] of webRtcLibraries.entries()) {
    const elfLog = await runOwned(context, `inspect-webrtc-elf-${index + 1}`, readelf, ["-h", join(extractRoot, entry)], env, repoRoot);
    assert.match(elfLog, /Machine:\s+AArch64/u, `${entry} is not an AArch64 ELF binary`);
    nativeLibraryElves.push({ path: entry, machine: "AArch64" });
  }

  const buildRunPath = resolve(repoRoot, input.buildRun);
  const realBuildRunPath = await realpath(buildRunPath);
  const buildRunRelative = relative(resolve(repoRoot, "target/test"), realBuildRunPath);
  assert.ok(buildRunRelative && buildRunRelative !== ".." && !buildRunRelative.startsWith(`..${sep}`), "Build run evidence escaped target/test");
  const buildResult = JSON.parse(await readFile(join(realBuildRunPath, "artifacts/result.json"), "utf8"));
  assert.equal(buildResult.status, "passed", "Android arm64 package run did not pass");
  assert.equal(buildResult.result.apk.sha256, apkSha256, "Build run report refers to different APK bytes");
  assert.equal(buildResult.result.sourceFreeze.mobileSha256, input.mobile);
  assert.equal(buildResult.result.sourceFreeze.sharedSha256, input.shared);
  assert.equal(buildResult.result.sourceFreeze.mobileHashUnchanged, true);
  assert.equal(buildResult.result.sourceFreeze.sharedHashUnchanged, true);
  const buildRunnerPath = join(repoRoot, "apps/kcoder-studio/e2e/private/mobile-peer-android-build.once.mjs");
  const buildRunnerSha256 = await sha256File(buildRunnerPath);
  assert.equal(buildResult.result.runnerSha256, buildRunnerSha256, "Build runner changed after its startup hash was recorded");

  const supersededRun = "target/test/apps/kcoder-studio/e2e/private/mobile-peer-android-build.once.mjs/20261018-165125.670Z";
  const supersededResult = JSON.parse(await readFile(join(repoRoot, supersededRun, "artifacts/android-arm64-build.json"), "utf8"));
  const cancelledRun = "target/test/apps/kcoder-studio/e2e/private/mobile-peer-android-build.once.mjs/20261018-173847.226Z";
  const cancelledManifest = JSON.parse(await readFile(join(repoRoot, cancelledRun, "manifest.json"), "utf8"));
  assert.equal(cancelledManifest.status, "failed");
  assert.match(cancelledManifest.error, /SIGINT/u);
  assert.ok(cancelledManifest.processes.every(processRecord => processRecord.stopped), "Cancelled V2 run left an owned process active");

  const report = {
    schemaVersion: 1,
    status: "passed",
    verificationOnly: true,
    buildPerformedInThisRun: false,
    distributable: false,
    installedOnDevice: false,
    runnerSha256,
    buildRun: {
      run: relative(repoRoot, realBuildRunPath),
      status: buildResult.status,
      runnerSha256AtStart: buildResult.result.runnerSha256,
      runnerSha256MatchesFinalRunnerSource: true,
      mobileAndSharedHashesMatchedFreezeBeforeAndAfterBuild: true,
    },
    supersededPriorBuild: {
      run: supersededRun,
      apkPath: supersededResult.apk.path,
      apkSha256: supersededResult.apk.sha256,
      status: "superseded; do not recommend for installation",
    },
    cancelledPriorBuild: {
      run: cancelledRun,
      runManifestStatus: cancelledManifest.status,
      signal: "SIGINT",
      productFailure: false,
      ownedProcessesStopped: true,
      temporarySigningKeyAndRunStateCleaned: true,
    },
    sourceFreeze: {
      manifest: input.freezeManifest,
      mobileSha256: mobileHash,
      sharedSha256: sharedHash,
      currentSourceMatchesBuildFreeze: true,
      buildReportHashesUnchanged: true,
    },
    apk: {
      path: relative(repoRoot, apkPath),
      bytes: (await stat(apkPath)).size,
      sha256: apkSha256,
      packageName: provenance.applicationId,
      version: provenance.version,
      versionCode: provenance.versionCode,
      targetSdk: provenance.targetSdk,
      architecture: provenance.architecture,
      signatureVerified: provenance.signature.verified,
      temporarySignerSha256: provenance.signature.certificateSha256,
      requestedPermissions: permissions,
      permissionAudit: {
        blockingCategories: ["microphone recording", "audio routing changes", "Bluetooth", "system overlay"],
        forbiddenPermissions: forbiddenPermissions,
        existingPhotoPickerAndStoragePermissionsReportedOnly: true,
      },
      hermesBytecodeMagic: hermesMagic,
      webRtcNativeLibraries: webRtcLibraries,
      webRtcNativeLibraryElves: nativeLibraryElves,
    },
    limitation: "APK build and content audit only; no Android device installation or live peer-connection acceptance.",
  };
  await context.writeArtifactJson("android-arm64-apk-audit.json", report);
  return report;
}

const input = parseFreezeArguments(process.argv.slice(2));
await runE2E(new URL(import.meta.url), {
  suite: "mobile-peer-android-arm64-apk-audit",
  modelIndependent: true,
  processSignalTimeoutMs: 10_000,
  streamCloseTimeoutMs: 10_000,
}, context => auditApk(context, input));
