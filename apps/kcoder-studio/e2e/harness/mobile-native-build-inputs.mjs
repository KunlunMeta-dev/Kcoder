import assert from "node:assert/strict";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const DEFAULT_ANDROID_ABI = "x86_64";
const ANDROID_ABIS = new Set(["x86_64", "arm64-v8a"]);
const SOURCE_PIN_KEYS = [
  "KCODER_E2E_MOBILE_SOURCE_ROOT",
  "KCODER_E2E_MOBILE_SOURCE_MANIFEST",
  "KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256",
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Locate a regular aapt executable from the newest installed Android build-tools directory. */
export async function resolveAndroidAapt(sdk, platform = process.platform) {
  const toolsRoot = resolve(sdk, "build-tools");
  const entries = await readdir(toolsRoot, { withFileTypes: true }).catch(() => []);
  const versions = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }));
  const executableName = platform === "win32" ? "aapt.exe" : "aapt";
  for (const version of versions) {
    const candidate = resolve(toolsRoot, version, executableName);
    const info = await lstat(candidate).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink()) return candidate;
  }
  throw Error(`UNMET_PREREQUISITE: Android SDK aapt was not found under ${toolsRoot}`);
}

/** Parse the native gate's small caller input contract without reading the filesystem. */
export function parseMobileNativeBuildInputs(environment = process.env) {
  const requestedAbi = environment.KCODER_E2E_ANDROID_ABI ?? DEFAULT_ANDROID_ABI;
  assert.ok(ANDROID_ABIS.has(requestedAbi),
    "KCODER_E2E_ANDROID_ABI must be exactly x86_64 or arm64-v8a");

  const suppliedPins = SOURCE_PIN_KEYS.map(name => environment[name] !== undefined);
  const pinCount = suppliedPins.filter(Boolean).length;
  assert.ok(pinCount === 0 || pinCount === SOURCE_PIN_KEYS.length,
    "caller-pinned Mobile source requires SOURCE_ROOT, SOURCE_MANIFEST, and SOURCE_MANIFEST_SHA256 together");

  if (pinCount === 0) return { abi: requestedAbi, sourcePin: null };

  const [sourceRootValue, manifestPathValue, manifestSha256] = SOURCE_PIN_KEYS.map(name => environment[name]);
  assert.ok(typeof sourceRootValue === "string" && isAbsolute(sourceRootValue),
    "KCODER_E2E_MOBILE_SOURCE_ROOT must be an absolute path");
  assert.ok(typeof manifestPathValue === "string" && isAbsolute(manifestPathValue),
    "KCODER_E2E_MOBILE_SOURCE_MANIFEST must be an absolute path");
  assert.match(manifestSha256, SHA256_PATTERN,
    "KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256 must be an explicit lowercase SHA-256 pin");

  return {
    abi: requestedAbi,
    sourcePin: {
      sourceRoot: resolve(sourceRootValue),
      snapshotManifestPath: resolve(manifestPathValue),
      expectedSnapshotManifestSha256: manifestSha256,
    },
  };
}

/** Require the captured snapshot and an independently inspected tree to match a source identity. */
export function assertMobileNativeSourceTreeMatches(expected, observed) {
  assert.ok(expected && observed, "expected and observed Mobile source identities are required");
  assert.equal(observed.sourceTreeSha256, expected.sourceTreeSha256,
    "Mobile native build source tree differs from the selected identity");
  const projectRoots = identity => {
    const roots = identity.sourceRoots ?? identity.roots;
    assert.ok(Array.isArray(roots), "Mobile source identity root table is required");
    return roots.map(({ name, destination, sha256, fileCount }) => ({ name, destination, sha256, fileCount }));
  };
  assert.deepEqual(projectRoots(observed), projectRoots(expected),
    "Mobile native build source roots differ from the selected identity");
  return true;
}

/** Also require snapshot roots to point at the exact caller-selected source directories. */
export function assertMobileNativeSnapshotMatchesIdentity(snapshot, identity) {
  assert.ok(snapshot && identity, "captured Mobile source snapshot and identity are required");
  assertMobileNativeSourceTreeMatches(identity, snapshot);
  assert.deepEqual(snapshot.roots, identity.sourceRoots,
    "captured Mobile source snapshot roots differ from the selected source paths");
  return true;
}
