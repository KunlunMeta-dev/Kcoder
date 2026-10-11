import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readlink, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { repoRoot, waitFor } from "./run-context.mjs";

const hashFileAsync = promisify((path, callback) => {
  const digest = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", chunk => digest.update(chunk));
  stream.once("error", callback);
  stream.once("end", () => callback(null, digest.digest("hex")));
});

export async function validatePinnedGatewayRuntime({
  snapshotRelativePath,
  expectedManifestSha256,
  expectedSourceTreeSha256,
  expectedDependencyTreeSha256,
  expectedDevServerSha256,
  expectedBinaryPath,
  expectedBinarySha256,
  expectedNodeVersion,
}) {
  const privateRoot = await realpath(resolve(repoRoot, "target/private-phone-ux-implementation"));
  const requestedSnapshot = resolve(repoRoot, snapshotRelativePath);
  const snapshotRoot = await realpath(requestedSnapshot);
  assert.equal(snapshotRoot, requestedSnapshot, "pinned Gateway snapshot path must not traverse a symlink");
  const snapshotRelative = relative(privateRoot, snapshotRoot);
  assert.ok(snapshotRelative && snapshotRelative !== ".." && !snapshotRelative.startsWith(`..${sep}`) && !isAbsolute(snapshotRelative), "pinned Gateway snapshot must remain below target/private-phone-ux-implementation");
  const manifestPath = resolve(snapshotRoot, "gateway-runtime-freeze.json");
  const manifestInfo = await lstat(manifestPath);
  assert.ok(manifestInfo.isFile() && !manifestInfo.isSymbolicLink(), "pinned Gateway manifest must be a regular file");
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifestSha256, expectedManifestSha256, "pinned Gateway runtime manifest changed");
  assert.equal(manifest.status, "complete", "pinned Gateway runtime manifest is incomplete");
  assert.equal(manifest.sourceTreeSha256, expectedSourceTreeSha256, "pinned Gateway source tree digest changed");
  assert.equal(manifest.dependencyTreeSha256, expectedDependencyTreeSha256, "pinned Gateway dependency tree digest changed");
  assert.equal(manifest.nodeVersion, expectedNodeVersion, "pinned Gateway Node version changed");
  assert.equal(process.version, expectedNodeVersion, "diagnostic Node version differs from the frozen Gateway runtime");
  assert.equal(await realpath(process.execPath), await realpath(manifest.runtimeInputs.nodeExecutable), "diagnostic Node executable differs from the frozen Gateway runtime");
  const sourceFiles = [];
  const dependencyFiles = [];
  await appendPinnedSnapshotFiles(snapshotRoot, "", sourceFiles, false);
  const dependencyRoot = await realpath(resolve(snapshotRoot, "node_modules"));
  await appendPinnedSnapshotFiles(dependencyRoot, "", dependencyFiles, true, dependencyRoot);
  sourceFiles.sort((left, right) => left.path.localeCompare(right.path));
  dependencyFiles.sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(sourceFiles, manifest.sourceFiles, "pinned Gateway source tree differs from its manifest");
  assert.deepEqual(dependencyFiles, manifest.dependencyFiles, "pinned Gateway dependency tree differs from its manifest");
  assert.equal(sha256(Buffer.from(JSON.stringify(sourceFiles))), expectedSourceTreeSha256, "pinned Gateway source tree digest no longer verifies");
  assert.equal(sha256(Buffer.from(JSON.stringify(dependencyFiles))), expectedDependencyTreeSha256, "pinned Gateway dependency tree digest no longer verifies");

  const binaryPath = resolve(repoRoot, expectedBinaryPath);
  assert.equal(await realpath(binaryPath), binaryPath, "pinned Gateway binary path must not traverse a symlink");
  assert.equal(resolve(manifest.runtimeInputs.kcoderBinaryPath), binaryPath, "Gateway binary path differs from its pin");
  const binaryInfo = await lstat(binaryPath);
  assert.ok(binaryInfo.isFile() && !binaryInfo.isSymbolicLink(), "pinned Gateway binary must be a regular file");
  const binarySha256 = await hashFileAsync(binaryPath);
  assert.equal(binarySha256, expectedBinarySha256, "pinned Gateway binary content changed");
  assert.equal(manifest.runtimeInputs.kcoderBinarySha256, expectedBinarySha256, "Gateway runtime manifest binary hash differs from its pin");

  const scriptPath = resolve(snapshotRoot, "dev-server.mjs");
  assert.equal(await realpath(scriptPath), scriptPath, "frozen Gateway script path must not traverse a symlink");
  const scriptInfo = await lstat(scriptPath);
  assert.ok(scriptInfo.isFile() && !scriptInfo.isSymbolicLink(), "frozen dev-server.mjs must be a regular file");
  const devServerSha256 = sha256(await readFile(scriptPath));
  assert.equal(devServerSha256, expectedDevServerSha256, "frozen Gateway dev-server.mjs changed");

  const nodeInfo = await stat(manifest.runtimeInputs.nodeExecutable);
  assert.ok(nodeInfo.isFile(), "frozen Gateway Node executable must be a regular file");
  assert.deepEqual(
    { size: nodeInfo.size, mtimeMs: nodeInfo.mtimeMs, dev: nodeInfo.dev, ino: nodeInfo.ino },
    manifest.runtimeInputs.nodeStat,
    "frozen Gateway Node executable identity changed",
  );

  return {
    root: snapshotRoot,
    manifestPath,
    manifestSha256,
    sourceTreeSha256: manifest.sourceTreeSha256,
    dependencyTreeSha256: manifest.dependencyTreeSha256,
    nodeExecutable: manifest.nodeExecutable,
    nodeVersion: manifest.nodeVersion,
    binaryPath,
    binarySha256,
    scriptPath,
    scriptSha256: devServerSha256,
  };
}

async function appendPinnedSnapshotFiles(root, relativeRoot, output, dependencies, dependencyRoot = null) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "gateway-runtime-freeze.json") continue;
    if (!dependencies && entry.name === "node_modules") continue;
    if (dependencies && dependencySnapshotExcluded(entry.name, entry.isDirectory())) continue;
    if (!dependencies && sourceSnapshotExcluded(entry.name, entry.isDirectory())) continue;
    const absolute = resolve(root, entry.name);
    const path = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    let info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      assert.ok(dependencies, `frozen Gateway source snapshot contains a symlink: ${path}`);
      const target = await realpath(absolute);
      assert.ok(target === dependencyRoot || target.startsWith(`${dependencyRoot}${sep}`), `Gateway dependency symlink escapes its owned root: ${path}`);
      output.push({ path, symlinkTarget: await readlink(absolute) });
      info = await stat(absolute);
    }
    if (info.isDirectory()) await appendPinnedSnapshotFiles(absolute, path, output, dependencies, dependencyRoot);
    else if (info.isFile()) {
      const contents = await readFile(absolute);
      output.push({ path, size: contents.length, sha256: sha256(contents) });
    }
  }
}

function dependencySnapshotExcluded(name, isDirectory) {
  if (isDirectory && [".vite", ".cache", "coverage", ".git"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  if ([".npmrc", "credentials.json", "account_credentials.json"].includes(name)) return true;
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name)) return true;
  return /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

function sourceSnapshotExcluded(name, isDirectory) {
  if (isDirectory && [".git", ".expo", "dist", "target"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

export async function startPinnedSnapshotGateway(context, runtime, {
  label,
  workspace,
  serversFile,
  serversStore,
  webRoot,
  mock = true,
}) {
  assert.ok(mock, "this diagnostic only permits the isolated mock Gateway");
  assert.match(label, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, "Gateway process label is invalid");
  const host = "127.0.0.1";
  const authToken = randomBytes(24).toString("base64url");
  context.registerSecret(authToken);
  const temporaryRoot = context.pathInState(`${label}-tmp`);
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  context.registerTemporaryDirectory(`${label} temporary files`, temporaryRoot);

  const env = context.isolatedEnvironment({
    KCODER_STUDIO_HOST: host,
    KCODER_STUDIO_PORT: "0",
    KCODER_STUDIO_KCODER_BIN: runtime.binaryPath,
    KCODER_STUDIO_WORKSPACE: workspace,
    KCODER_STUDIO_WEB_ROOT: webRoot,
    KCODER_STUDIO_SERVERS_FILE: serversFile,
    KCODER_STUDIO_SERVERS_STORE: serversStore,
    KCODER_STUDIO_AUTH_TOKEN: authToken,
    KCODER_STUDIO_ALLOWED_HOSTS: "127.0.0.1,localhost,::1",
    KCODER_STUDIO_MOCK: "1",
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
  });
  const child = context.spawnOwned(label, process.execPath, [runtime.scriptPath], {
    cwd: runtime.root,
    env,
  });
  const logPath = resolve(context.logsDir, `${label}.log`);
  const port = await waitFor(async () => {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const match = log.match(/KC(?:oder)? Studio: http:\/\/[^:]+:(\d+)/);
    if (child.exitCode !== null) throw new Error(`pinned mock Gateway exited with code ${child.exitCode}`);
    return match ? Number(match[1]) : null;
  }, 15_000, `${label} startup`, 50, context.abortSignal);
  context.registerPort(label, port);
  return {
    child,
    pid: child.pid,
    port,
    host,
    baseUrl: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}`,
    authToken,
    logPath,
    scriptPath: runtime.scriptPath,
    cwd: runtime.root,
    binaryPath: runtime.binaryPath,
    binarySha256: runtime.binarySha256,
    gatewayManifestSha256: runtime.manifestSha256,
    mock: true,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
