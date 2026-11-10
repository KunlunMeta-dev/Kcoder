import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";

export const CHROMIUM_SHORT_TMP_PREFIX = "/tmp/kc-";
export const CHROMIUM_SINGLETON_SOCKET_SUFFIX = "/org.chromium.Chromium.XXXXXX/SingletonSocket";
export const UNIX_SOCKET_PATH_LIMIT_BYTES = 108;

export function assertChromiumSingletonSocketPathBudget(directory) {
  assert.equal(typeof directory, "string", "Chromium temporary directory must be a path string");
  const bytes = Buffer.byteLength(`${directory}${CHROMIUM_SINGLETON_SOCKET_SUFFIX}`);
  assert.ok(bytes < UNIX_SOCKET_PATH_LIMIT_BYTES,
    `Chromium singleton socket path must fit Unix sun_path (${bytes} bytes)`);
  return bytes;
}

export async function createShortChromiumTemp(context) {
  assert.equal(typeof context?.addCleanup, "function", "RunContext cleanup registration is required");
  assert.equal(typeof context?.writeArtifactJson, "function", "RunContext artifact writing is required");

  const directory = await mkdtemp(CHROMIUM_SHORT_TMP_PREFIX);
  let identity = null;
  context.addCleanup("remove this run's short Chromium temp directory", async () => {
    const current = await lstat(directory).catch(error => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!current) return;
    assert.ok(current.isDirectory() && !current.isSymbolicLink(),
      "short Chromium temp path must still be the owned real directory");
    assert.ok(identity, "short Chromium temp ownership identity must be recorded before cleanup");
    assert.deepEqual(
      { uid: current.uid, dev: current.dev, ino: current.ino, mode: current.mode & 0o777 },
      identity,
      "short Chromium temp directory identity must not change before cleanup",
    );
    await rm(directory, { recursive: true, force: false });
  });

  const created = await lstat(directory);
  assert.ok(created.isDirectory() && !created.isSymbolicLink(),
    "mkdtemp must create a real short Chromium temp directory");
  identity = {
    uid: created.uid,
    dev: created.dev,
    ino: created.ino,
    mode: created.mode & 0o777,
  };
  if (typeof process.getuid === "function") {
    assert.equal(created.uid, process.getuid(), "short Chromium temp directory must be owned by this run's user");
  }
  assert.equal(created.mode & 0o777, 0o700, "short Chromium temp directory must be private mode 0700");

  const singletonSocketPathBytes = assertChromiumSingletonSocketPathBudget(directory);
  const receipt = {
    path: directory,
    uid: identity.uid,
    dev: identity.dev,
    ino: identity.ino,
    mode: identity.mode,
    singletonSocketPathBytes,
    unixSocketPathLimitBytes: UNIX_SOCKET_PATH_LIMIT_BYTES,
    cleanupOwner: "RunContext exact-path cleanup registered before Chromium spawn",
  };
  await context.writeArtifactJson("chromium-temp-ownership.json", receipt);
  return { path: directory, receipt };
}
