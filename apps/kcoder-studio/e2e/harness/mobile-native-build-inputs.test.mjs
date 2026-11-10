import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertMobileNativeSnapshotMatchesIdentity,
  assertMobileNativeSourceTreeMatches,
  parseMobileNativeBuildInputs,
  resolveAndroidAapt,
} from "./mobile-native-build-inputs.mjs";

const manifestSha256 = "a".repeat(64);
const sourceRoots = [
  {
    name: "mobile",
    sourceRoot: "/frozen/apps/kcoder-studio/mobile",
    destination: "apps/kcoder-studio/mobile",
    sha256: "b".repeat(64),
    fileCount: 12,
  },
  {
    name: "studio-shared",
    sourceRoot: "/frozen/apps/kcoder-studio/shared",
    destination: "apps/kcoder-studio/shared",
    sha256: "c".repeat(64),
    fileCount: 4,
  },
];
const sourceIdentity = {
  sourceRoots,
  sourceTreeSha256: "d".repeat(64),
  snapshotProof: { manifestPath: "/frozen/manifest.json", manifestSha256 },
};

function pinnedEnvironment(overrides = {}) {
  return {
    KCODER_E2E_MOBILE_SOURCE_ROOT: "/frozen/apps/kcoder-studio/mobile",
    KCODER_E2E_MOBILE_SOURCE_MANIFEST: "/frozen/manifest.json",
    KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256: manifestSha256,
    ...overrides,
  };
}

test("native build inputs default to the compatible x86_64 lane without caller pinning", () => {
  assert.deepEqual(parseMobileNativeBuildInputs({}), { abi: "x86_64", sourcePin: null });
});

test("native build accepts only the exact Android ABI allowlist", () => {
  assert.equal(parseMobileNativeBuildInputs({ KCODER_E2E_ANDROID_ABI: "arm64-v8a" }).abi, "arm64-v8a");
  assert.equal(parseMobileNativeBuildInputs({ KCODER_E2E_ANDROID_ABI: "x86_64" }).abi, "x86_64");
  for (const value of ["", "ARM64-V8A", "arm64", " x86_64", "x86_64,arm64-v8a"]) {
    assert.throws(() => parseMobileNativeBuildInputs({ KCODER_E2E_ANDROID_ABI: value }), /exactly x86_64 or arm64-v8a/);
  }
});

test("caller-pinned source root, manifest, and lowercase SHA must be supplied together", () => {
  const valid = pinnedEnvironment();
  assert.deepEqual(parseMobileNativeBuildInputs(valid), {
    abi: "x86_64",
    sourcePin: {
      sourceRoot: "/frozen/apps/kcoder-studio/mobile",
      snapshotManifestPath: "/frozen/manifest.json",
      expectedSnapshotManifestSha256: manifestSha256,
    },
  });
  for (const key of [
    "KCODER_E2E_MOBILE_SOURCE_ROOT",
    "KCODER_E2E_MOBILE_SOURCE_MANIFEST",
    "KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256",
  ]) {
    const incomplete = pinnedEnvironment();
    delete incomplete[key];
    assert.throws(() => parseMobileNativeBuildInputs(incomplete), /requires .* together/);
  }
  assert.throws(() => parseMobileNativeBuildInputs(pinnedEnvironment({
    KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256: "A".repeat(64),
  })), /explicit lowercase SHA-256 pin/);
  assert.throws(() => parseMobileNativeBuildInputs(pinnedEnvironment({
    KCODER_E2E_MOBILE_SOURCE_ROOT: "relative/mobile",
  })), /must be an absolute path/);
});

test("captured and independently inspected source trees must match the selected identity", () => {
  const snapshot = {
    sourceTreeSha256: sourceIdentity.sourceTreeSha256,
    roots: structuredClone(sourceRoots),
  };
  assert.equal(assertMobileNativeSnapshotMatchesIdentity(snapshot, sourceIdentity), true);

  const copyIdentity = {
    sourceTreeSha256: sourceIdentity.sourceTreeSha256,
    sourceRoots: sourceRoots.map((root, index) => ({
      ...root,
      sourceRoot: `/owned/mobile-copy/${index}`,
    })),
  };
  assert.equal(assertMobileNativeSourceTreeMatches(sourceIdentity, copyIdentity), true);
  copyIdentity.sourceRoots[0].sha256 = "e".repeat(64);
  assert.throws(() => assertMobileNativeSourceTreeMatches(sourceIdentity, copyIdentity), /source roots differ/);
});

test("Android aapt resolution selects the newest regular build-tools binary", async t => {
  const sdk = await mkdtemp(join(tmpdir(), "mobile-native-aapt-resolution-"));
  t.after(() => rm(sdk, { recursive: true, force: true }));

  const buildTools = join(sdk, "build-tools");
  const olderAapt = join(buildTools, "35.2.0", "aapt");
  const newestAapt = join(buildTools, "35.10.0", "aapt");
  const newestWindowsAapt = join(buildTools, "35.10.0", "aapt.exe");
  const malformedNewestAapt = join(buildTools, "36.0.0", "aapt");
  await mkdir(join(buildTools, "35.2.0"), { recursive: true });
  await mkdir(join(buildTools, "35.10.0"), { recursive: true });
  await mkdir(malformedNewestAapt, { recursive: true });
  await writeFile(olderAapt, "older sdk tool");
  await writeFile(newestAapt, "newest sdk tool");
  await writeFile(newestWindowsAapt, "newest windows sdk tool");

  assert.equal(await resolveAndroidAapt(sdk), newestAapt);
  assert.equal(await resolveAndroidAapt(sdk, "win32"), newestWindowsAapt);
});

test("Android aapt resolution reports a missing SDK tool as an unmet prerequisite", async t => {
  const sdk = await mkdtemp(join(tmpdir(), "mobile-native-aapt-missing-"));
  t.after(() => rm(sdk, { recursive: true, force: true }));

  await assert.rejects(resolveAndroidAapt(sdk), /UNMET_PREREQUISITE: Android SDK aapt was not found/);
});
