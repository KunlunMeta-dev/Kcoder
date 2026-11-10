import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, chmod, lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeOwnedDependencies, ownedNativeBuildInputs, runOwnedNativePhase } from '../../harness/owned-dependencies.mjs';
import { captureMobileExportSourceSnapshot } from '../../harness/mobile-export-source-snapshot.mjs';
import { inspectMobileWebExportSourceIdentity } from '../../harness/mobile-web-export-archive.mjs';
import {
  assertMobileNativeSnapshotMatchesIdentity,
  assertMobileNativeSourceTreeMatches,
  parseMobileNativeBuildInputs,
  resolveAndroidAapt,
} from '../../harness/mobile-native-build-inputs.mjs';

const AUDIT_ANDROID_APPLICATION_ID = 'dev.kcoder.studio.audit';

await runE2E(import.meta.url, {
  testId: 'mobile-native-platform-bundles-and-android-apk',
  tier: 'manual-live',
  modelPolicy: 'No model calls. Android APK and iOS JavaScript bundle export only; no iOS app or device execution claim.',
  retainSuccessLogs: true,
}, async context => {
  const sdk = process.env.KCODER_E2E_ANDROID_SDK;
  if (!sdk) throw Error('UNMET_PREREQUISITE: KCODER_E2E_ANDROID_SDK is required');

  const inputs = parseMobileNativeBuildInputs(process.env);
  const selectedMobileRoot = inputs.sourcePin?.sourceRoot ?? resolve(appRoot, 'mobile');
  const selectedSourceRoots = mobileSourceRoots(selectedMobileRoot);
  const sourceIdentityOptions = inputs.sourcePin ? {
    snapshotManifestPath: inputs.sourcePin.snapshotManifestPath,
    expectedSnapshotManifestSha256: inputs.sourcePin.expectedSnapshotManifestSha256,
  } : {};
  const inspectSelectedSource = () => inspectMobileWebExportSourceIdentity({
    sourceRoots: selectedSourceRoots,
    ...sourceIdentityOptions,
  });
  const selectedSourceIdentity = await inspectSelectedSource();

  const snapshotRoot = context.pathInState('native-source-snapshot');
  context.registerTemporaryDirectory('mobile native source snapshot', snapshotRoot);
  const snapshotRoots = snapshotRootsAt(snapshotRoot);
  let snapshotCaptured = false;
  const inspectSnapshot = () => inspectMobileWebExportSourceIdentity({ sourceRoots: snapshotRoots });
  const verifySelectedInputs = async () => {
    const current = await inspectSelectedSource();
    assert.deepEqual(current, selectedSourceIdentity,
      'caller-selected Mobile source identity changed during the Android build');
    if (snapshotCaptured) {
      const snapshotIdentity = await inspectSnapshot();
      assertMobileNativeSourceTreeMatches(selectedSourceIdentity, snapshotIdentity);
    }
  };
  context.addCleanup('recheck selected Mobile native build source identity', verifySelectedInputs);

  const snapshotSourceRoots = selectedSourceIdentity.sourceRoots.map(root => ({
    name: root.name,
    path: root.sourceRoot,
    destination: root.destination,
  }));
  const sourceSnapshot = await captureMobileExportSourceSnapshot({
    sourceRoots: snapshotSourceRoots,
    snapshotRoot,
    layout: 'preflight-source-root',
    freezeFiles: true,
  });
  snapshotCaptured = true;
  assertMobileNativeSnapshotMatchesIdentity(sourceSnapshot, selectedSourceIdentity);
  await context.writeArtifactJson('native-source-identity.json', {
    sourceRoot: selectedMobileRoot,
    callerPinned: Boolean(inputs.sourcePin),
    sourceIdentity: selectedSourceIdentity,
    snapshot: {
      sourceTreeSha256: sourceSnapshot.sourceTreeSha256,
      fileCount: sourceSnapshot.fileCount,
      byteCount: sourceSnapshot.byteCount,
      layout: sourceSnapshot.layout,
      filesReadOnly: true,
      fileContentsHashVerified: true,
    },
  });

  await verifySelectedInputs();

  const ownedBuildRoot = context.pathInState('native-build-source');
  context.registerTemporaryDirectory('owned Mobile native build source', ownedBuildRoot);
  const mobile = resolve(ownedBuildRoot, 'apps/kcoder-studio/mobile');
  const shared = resolve(ownedBuildRoot, 'apps/kcoder-studio/shared');
  await mkdir(resolve(ownedBuildRoot, 'apps/kcoder-studio'), { recursive: true, mode: 0o700 });
  await cp(resolve(snapshotRoot, 'apps/kcoder-studio/mobile'), mobile, { recursive: true });
  await cp(resolve(snapshotRoot, 'apps/kcoder-studio/shared'), shared, { recursive: true });
  await makeOwnedBuildTreeWritable(mobile);
  await makeOwnedBuildTreeWritable(shared);
  const copiedSourceIdentity = await inspectMobileWebExportSourceIdentity({
    sourceRoots: mobileSourceRoots(mobile),
  });
  assertMobileNativeSourceTreeMatches(selectedSourceIdentity, copiedSourceIdentity);

  // Dependencies are a separately owned input; all Mobile/shared source bytes come from the verified snapshot above.
  const dependencies = await materializeOwnedDependencies(context, {
    sourceRoot: resolve(appRoot, 'mobile/node_modules'),
    destination: resolve(mobile, 'node_modules'),
  });
  await context.writeArtifactJson('native-owned-dependencies.json', {
    ...dependencies,
    sourceRoot: resolve(appRoot, 'mobile/node_modules'),
    sourceProvenance: 'owned local dependency copy; dependency tree is outside the Mobile/shared source snapshot identity',
  });

  const app = JSON.parse(await readFile(resolve(mobile, 'app.json'), 'utf8'));
  app.expo.android.package = AUDIT_ANDROID_APPLICATION_ID;
  await writeFile(resolve(mobile, 'app.json'), JSON.stringify(app, null, 2));
  const nativeInputs = ownedNativeBuildInputs(mobile);
  await writeFile(resolve(mobile,'metro.config.cjs'),nativeInputs.metroConfig);
  const gradleInitScript = context.pathInState('gradle-plugin-portal.init.gradle');
  await writeFile(gradleInitScript, nativeInputs.gradleInitScript);
  const expo=nativeInputs.expoCli;

  const javaProxy = process.env.KCODER_E2E_JAVA_PROXY ? new URL(process.env.KCODER_E2E_JAVA_PROXY) : null;
  if (javaProxy && (javaProxy.username || javaProxy.password || javaProxy.protocol !== 'http:')) {
    throw Error('UNMET_PREREQUISITE: build proxy must be an HTTP endpoint without credentials');
  }
  const javaOptions = javaProxy
    ? `-Dhttp.proxyHost=${javaProxy.hostname} -Dhttp.proxyPort=${javaProxy.port || 80} -Dhttps.proxyHost=${javaProxy.hostname} -Dhttps.proxyPort=${javaProxy.port || 80} -Dhttp.nonProxyHosts=localhost|127.*`
    : '';
  const env = context.isolatedEnvironment({
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    JAVA_HOME: process.env.KCODER_E2E_JAVA_HOME ?? '/usr/lib/jvm/java-21-openjdk-amd64',
    GRADLE_USER_HOME: resolve(sdk, 'gradle-cache'),
    JAVA_TOOL_OPTIONS: javaOptions,
    CI: '1',
    KCODER_STUDIO_ALLOW_HTTP: '1',
    EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP: '1',
  }, ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']);
  const run = (label, command, args, timeoutMs) => runOwnedNativePhase(context, {
    label, command, args, cwd: mobile, env, timeoutMs,
  });

  await run('native-js-export', process.execPath, [expo, 'export', '--platform', 'ios', '--platform', 'android', '--max-workers', '2',
    '--output-dir', context.pathInState('native-export')], 240000);
  const exportMetadata = JSON.parse(await readFile(context.pathInState('native-export/metadata.json'), 'utf8'));
  assert.ok(exportMetadata.fileMetadata.android && exportMetadata.fileMetadata.ios,
    'Android and iOS JavaScript bundle exports must both complete');
  await context.writeArtifactJson('native-export-metadata.json', exportMetadata);

  await run('android-prebuild', process.execPath, [expo, 'prebuild', '--platform', 'android', '--no-install'], 120000);
  await run('android-apk', 'bash', [resolve(mobile, 'android/gradlew'), '--init-script', gradleInitScript,
    '-p', resolve(mobile, 'android'), ':app:assembleRelease',
    '--no-daemon', '--console=plain', '--max-workers=4', `-PreactNativeArchitectures=${inputs.abi}`], 900000);

  const apk = resolve(mobile, 'android/app/build/outputs/apk/release/app-release.apk');
  const builtApkEvidence = await inspectRegularApk(apk, 'built release APK');
  const artifact = context.pathInArtifacts(`kcoder-mobile-audit-${inputs.abi}.apk`);
  await cp(apk, artifact);
  const artifactApkEvidence = await inspectRegularApk(artifact, 'copied release APK artifact');
  assert.deepEqual(artifactApkEvidence, builtApkEvidence, 'copied APK artifact must preserve the built APK bytes');
  const aapt = await resolveAndroidAapt(sdk);
  await run('android-apk-native-code', aapt, ['dump', 'badging', artifact], 30000);
  const badging = await readFile(resolve(context.logsDir, 'android-apk-native-code.log'), 'utf8');
  const applicationIds = [...badging.matchAll(/^package:\s+name='([^']+)'/gm)].map(match => match[1]);
  assert.equal(applicationIds.length, 1, 'APK badging must report exactly one application ID');
  const actualApplicationId = applicationIds[0];
  assert.equal(actualApplicationId, AUDIT_ANDROID_APPLICATION_ID,
    'APK application ID must match the native build audit package');
  const nativeCodeLines = [...badging.matchAll(/^native-code:\s*(.*)$/gm)].map(match => match[1]);
  assert.equal(nativeCodeLines.length, 1, 'APK badging must report exactly one native ABI set');
  const actualAbis = [...nativeCodeLines[0].matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(actualAbis, [inputs.abi], 'APK native ABI must match the selected build ABI');

  await run('android-apk-abi-inventory', aapt, ['list', artifact], 30000);
  const inventory = await readFile(resolve(context.logsDir, 'android-apk-abi-inventory.log'), 'utf8');
  const packagedAbis = [...new Set([...inventory.matchAll(/^lib\/([^/]+)\//gm)].map(match => match[1]))].sort();
  assert.deepEqual(packagedAbis, [inputs.abi], 'APK native library inventory must contain only the selected ABI');

  await context.writeArtifactJson('android-build.json', {
    applicationId: actualApplicationId,
    expectedApplicationId: AUDIT_ANDROID_APPLICATION_ID,
    apk: artifact,
    apkSizeBytes: artifactApkEvidence.sizeBytes,
    apkSha256: artifactApkEvidence.sha256,
    requestedAbi: inputs.abi,
    verifiedAbi: actualAbis[0],
    packagedAbis,
    sourceTreeSha256: selectedSourceIdentity.sourceTreeSha256,
    sourceRoot: selectedMobileRoot,
    sourceSnapshotManifestPath: selectedSourceIdentity.snapshotProof?.manifestPath ?? null,
    sourceSnapshotManifestSha256: selectedSourceIdentity.snapshotProof?.manifestSha256 ?? null,
    cleartextTestOnly: true,
    deviceExecution: false,
  });

  await verifySelectedInputs();
  return { androidApk: true, androidAbi: actualAbis[0], iosJsBundleExport: true, iosApp: false, deviceExecution: false };
});

function mobileSourceRoots(mobileRoot) {
  return [
    { name: 'mobile', path: mobileRoot, destination: 'apps/kcoder-studio/mobile' },
    { name: 'studio-shared', path: resolve(mobileRoot, '../shared'), destination: 'apps/kcoder-studio/shared' },
  ];
}

function snapshotRootsAt(snapshotRoot) {
  return [
    { name: 'mobile', path: resolve(snapshotRoot, 'apps/kcoder-studio/mobile'), destination: 'apps/kcoder-studio/mobile' },
    { name: 'studio-shared', path: resolve(snapshotRoot, 'apps/kcoder-studio/shared'), destination: 'apps/kcoder-studio/shared' },
  ];
}

async function makeOwnedBuildTreeWritable(root) {
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'owned native source copy must be a regular directory');
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const info = await lstat(current);
    assert.ok(!info.isSymbolicLink(), 'owned native source copy must not contain symlinks');
    if (info.isDirectory()) {
      await chmod(current, 0o700);
      for (const entry of await readdir(current)) pending.push(resolve(current, entry));
    } else {
      assert.ok(info.isFile(), 'owned native source copy must not contain special files');
      await chmod(current, 0o600);
    }
  }
}

async function inspectRegularApk(path, label) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  assert.ok(info.size > 1000000, `${label} must be present and non-empty`);
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    assert.ok(before.isFile(), `${label} must be a regular file`);
    assert.equal(before.dev, info.dev, `${label} changed before inspection`);
    assert.equal(before.ino, info.ino, `${label} changed before inspection`);
    const contents = await file.readFile();
    const after = await file.stat();
    assert.equal(after.dev, before.dev, `${label} changed while being read`);
    assert.equal(after.ino, before.ino, `${label} changed while being read`);
    assert.equal(after.size, before.size, `${label} changed while being read`);
    assert.equal(contents.byteLength, before.size, `${label} was not read in full`);
    const pathAfterRead = await lstat(path);
    assert.ok(pathAfterRead.isFile() && !pathAfterRead.isSymbolicLink(), `${label} must remain a regular non-symlink file`);
    assert.equal(pathAfterRead.dev, after.dev, `${label} path changed during inspection`);
    assert.equal(pathAfterRead.ino, after.ino, `${label} path changed during inspection`);
    return {
      sizeBytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  } finally {
    await file.close();
  }
}
