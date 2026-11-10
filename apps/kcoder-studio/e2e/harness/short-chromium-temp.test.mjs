import assert from "node:assert/strict";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  assertChromiumSingletonSocketPathBudget,
  CHROMIUM_SINGLETON_SOCKET_SUFFIX,
  createShortChromiumTemp,
  UNIX_SOCKET_PATH_LIMIT_BYTES,
} from "./short-chromium-temp.mjs";

const supportsUnixTempOwnership = process.platform !== "win32" && typeof process.getuid === "function";

function makeContext() {
  const cleanups = [];
  const artifacts = [];
  return {
    cleanups,
    artifacts,
    context: {
      addCleanup(label, callback) { cleanups.push({ label, callback }); },
      async writeArtifactJson(name, value) { artifacts.push({ name, value }); },
    },
  };
}

test("creates a real private short temp directory and cleanup removes its recorded identity", { skip: !supportsUnixTempOwnership }, async () => {
  const harness = makeContext();
  let owned;
  try {
    owned = await createShortChromiumTemp(harness.context);
    const created = await lstat(owned.path);
    assert.ok(created.isDirectory() && !created.isSymbolicLink());
    assert.equal(created.uid, process.getuid());
    assert.equal(created.mode & 0o777, 0o700);
    assert.ok(owned.receipt.singletonSocketPathBytes < UNIX_SOCKET_PATH_LIMIT_BYTES);
    assert.deepEqual(harness.cleanups.map(item => item.label), ["remove this run's short Chromium temp directory"]);
    assert.deepEqual(harness.artifacts, [{ name: "chromium-temp-ownership.json", value: owned.receipt }]);

    await harness.cleanups[0].callback();
    await assert.rejects(lstat(owned.path), { code: "ENOENT" });
  } finally {
    if (owned) await rm(owned.path, { recursive: true, force: true });
  }
});

test("cleanup refuses and preserves a replacement inode at the same path", { skip: !supportsUnixTempOwnership }, async () => {
  const harness = makeContext();
  let owned;
  let movedPath;
  try {
    owned = await createShortChromiumTemp(harness.context);
    const original = await lstat(owned.path);
    movedPath = join("/tmp", `kc-short-temp-test-${randomUUID()}`);
    await rename(owned.path, movedPath);
    await mkdir(owned.path, { mode: 0o700 });
    const replacement = await lstat(owned.path);
    assert.notEqual(`${replacement.dev}:${replacement.ino}`, `${original.dev}:${original.ino}`);

    await assert.rejects(harness.cleanups[0].callback(), /identity must not change/);
    const preserved = await lstat(owned.path);
    assert.equal(`${preserved.dev}:${preserved.ino}`, `${replacement.dev}:${replacement.ino}`);
    assert.ok(preserved.isDirectory() && !preserved.isSymbolicLink());
  } finally {
    if (owned) await rm(owned.path, { recursive: true, force: true });
    if (movedPath) await rm(movedPath, { recursive: true, force: true });
  }
});

test("socket path budget accepts 107 bytes and rejects the 108-byte Unix limit", () => {
  const suffixBytes = Buffer.byteLength(CHROMIUM_SINGLETON_SOCKET_SUFFIX);
  const at107 = `/${"x".repeat(107 - suffixBytes - 1)}`;
  const at108 = `/${"x".repeat(UNIX_SOCKET_PATH_LIMIT_BYTES - suffixBytes - 1)}`;
  assert.equal(assertChromiumSingletonSocketPathBudget(at107), 107);
  assert.throws(() => assertChromiumSingletonSocketPathBudget(at108), /must fit Unix sun_path \(108 bytes\)/);
});
