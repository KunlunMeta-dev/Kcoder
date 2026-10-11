// Private once-run copy of the owned remote Relay lifecycle, pinned to the
// committed static03 GET-pool source closure. Keep process and UID cleanup
// semantics aligned with harness/remote-relay-lifecycle.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "../harness/run-context.mjs";
import { buildMarkedPythonSource } from "../harness/owned-ssh-control-master.mjs";
import { uploadPinnedRelayRuntimeArchive } from "../harness/remote-relay-lifecycle.mjs";

const PINNED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const PINNED_NODE_SHA256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const RELAY_POOL_MANIFEST_SHA256 = "0a4378e704a2f9bd86d4cef268e91041aa68d6765547901581bcf01c25669bfe";
const RELAY_POOL_SERVER_BEFORE_SHA256 = "056ffb05f50bba9fe2fc2cada50c29b7d292a6c1ad21b58895f8fe63516661a4";
const RELAY_POOL_SERVER_AFTER_SHA256 = "9d0846a54a1062355c95723eab57e4a12942333a4c7fe17cbbb998f1b5a4067a";
const RELAY_POOL_HELPER_SHA256 = "1ac7a3e9806c0e57a86300497139d34be9c6143d68d1b18f57e49ba72742c923";
const REMOTE_ENTRY_BASE_SHA256 = "2184c60b986ea1de3823d6c8096d20b9fd2c49d37511ebc015dec5131bd61b23";
const REMOTE_ENTRY_SHA256 = "5ee38518c1e1f0e8432d51cea9f27eafd589aab6d336dc87bece549a6d2232bb";
const HOSTED_ENTRY_SOURCE_FILE = "remote-relay-ingress-hosted.once.mjs";
const REMOTE_ENTRY_FILE = "remote-relay-ingress.once.mjs";
const REMOTE_ENTRY_BASE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../harness/remote-relay-ingress.once.mjs");
const RELAY_SUPPORT_LIVE_PIN_COUNT = 14;
const WS_FILE_PINS = Object.freeze([
  ["LICENSE", 1183, "2b29dcfe0d6471f7e8c92c5fb38c9f93edee10330937055440192f1832b1ecef"],
  ["README.md", 15306, "bb979132f3cbff08ce47f36d041e18071f8f534d01f591c0b129ba7abf1e480e"],
  ["browser.js", 176, "010da44addea1d88b2b732540c3f1fd0cbcb28926b96623d4c64222e0ead2d0e"],
  ["index.js", 796, "924564d5be26d59b9682c4263f68320e48dde7240bd2d1ad17ec305537429dd2"],
  ["lib/buffer-util.js", 3056, "8b0a45739132f82e25ea13163780abf547ccfe989267f3eb7abb475beec92da3"],
  ["lib/constants.js", 503, "391e823142b8b370e55a2fd32b022deaf03b8415c56000009674ebc86a0b4f86"],
  ["lib/event-target.js", 7321, "c45d3c6e12d170c860c0c3f1a050aa0f864d9806632b609a1e607d675aba128c"],
  ["lib/extension.js", 6183, "852564f0f6b460287043803eae732666fb5610f676874354fc89f06aa4e986ed"],
  ["lib/limiter.js", 1034, "e0469d4b83f6ba764b15f80e1766b75c136fbff68f048f4c050f0b1c7f065f69"],
  ["lib/permessage-deflate.js", 14669, "16a91536988a53c23047ee5882392068728a839a244178c3b09b8c54982f58b0"],
  ["lib/receiver.js", 17439, "a6ada33c9a2d54eaf595824b821ea89ca2c6395f89aa06755c52142148274884"],
  ["lib/sender.js", 16886, "d0791d30c3defd44dcabbddb879a901c757993fea2c00a7ffea01d53b23b4b77"],
  ["lib/stream.js", 4204, "a56fcb6e2b152097ee820b6f5410b1f71e59819b45d08d9f8bda588fe39070ec"],
  ["lib/subprotocol.js", 1498, "be3f6323d6f549568577dcba9004c1479d95c65a7abb0fe0c582875b9fac0b7c"],
  ["lib/validation.js", 3903, "41ce8e83d0d434132e1704895fedb91f6703a701b42d91c80954ab29b2845593"],
  ["lib/websocket-server.js", 17022, "6d8dd89a841748c80445fd5fcdb5ba8005369b53cc3525135e11304c8b9c55e5"],
  ["lib/websocket.js", 37848, "7ccf305925f0cdb74e06b75b4c84de134b1bd771a220ef409b24520def08128f"],
  ["package.json", 1829, "c1ef91ca04eb4754c011c5f0e7638b5078ff71104fada400c44ac761cf93e0b1"],
  ["wrapper.mjs", 554, "fe154662301fd558f935f9c217fccbe7a7dac02ff39e648a000589403ff27c7f"],
]);
const REMOTE_PORT = 32552;

/** Derive the one-run hosted ingress copy from its exact shared source pin. */
export function buildHostedMobileIngressCandidate(base) {
  assert.equal(typeof base, "string");
  const anchor = "  const prefix = `/g/${gatewayId}`;\n";
  assert.equal(base.split(anchor).length - 1, 1, "the selected-Gateway path anchor must be unique");
  const route = "  if (!upgrade && ['GET', 'HEAD'].includes(method) && noQuery\n"
    + "    && (url.pathname === `${prefix}/mobile-entry` || url.pathname === `${prefix}/mobile`\n"
    + "      || url.pathname.startsWith(`${prefix}/mobile/`))) return proxyPort;\n";
  assert.equal(base.includes(route), false, "the hosted-only route must not already exist in the shared entry");
  return base.replace(anchor, `${anchor}${route}`);
}

/** Start the fixed, selected-Gateway Relay in a fresh private remote root. */
export async function startOwnedRemoteRelay({
  context, recoveryContext, remoteOutput, sshWrite, sshTransport,
  relayRoot, poolManifestPath, poolOverlayRoot, registrationStoreFile,
  gatewayId, serverId, workspacePath, sharedHost,
}) {
  assert.ok(sshTransport && typeof sshTransport.spawnManaged === "function");
  assert.equal(await realpath(PINNED_NODE), PINNED_NODE);
  const entryPath = resolve(dirname(fileURLToPath(import.meta.url)), HOSTED_ENTRY_SOURCE_FILE);
  const localRuntime = await verifyLocalRuntime({ relayRoot, entryPath, poolManifestPath, poolOverlayRoot });
  const runtimeFiles = localRuntime.files;
  const nodePin = await filePin(PINNED_NODE);
  assert.equal(nodePin.sha256, PINNED_NODE_SHA256);
  assert.equal(process.version, "v22.17.0");
  assert.equal(await shaFile(process.execPath), PINNED_NODE_SHA256, "suite Node and staged Node must be the same reviewed binary");
  assert.match(gatewayId, /^[a-f0-9]{32}$/);
  assert.match(serverId, /^[A-Za-z0-9_-]{1,64}$/);
  assert.ok(typeof workspacePath === "string" && workspacePath.length > 0 && workspacePath.length <= 4096 && !workspacePath.includes("\0"));
  assert.match(sharedHost, /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/);
  const storeBytes = await readFile(registrationStoreFile);
  assert.ok(storeBytes.length > 0 && storeBytes.length <= 256 * 1024);
  const storeSha256 = shaBytes(storeBytes);

  const runId = createHash("sha256").update(`public-relay-direct:${context.seed}`).digest("hex").slice(0, 24);
  const runRoot = `/tmp/kc-phone-ux-relay-${runId}`;
  const config = {
    runId,
    runRoot,
    relayRoot: runRoot,
    registrationStoreFile: `${runRoot}/registration-store.json`,
    readyFile: `${runRoot}/ready.json`,
    gatewayId,
    serverId,
    workspacePath,
    sharedHost,
    ingressPort: REMOTE_PORT,
  };
  const configBytes = Buffer.from(`${JSON.stringify(config)}\n`);
  const configSha256 = shaBytes(configBytes);
  const lifecycle = { receipt: null, cleanupReceipt: null, stop: null };
  let rootReceipt = null;
  let stopped = false;
  let launchAttempted = false;
  const stop = async cleanupContext => {
    if (stopped) return { alreadyStopped: true };
    const receipt = parseObject(await remoteOutput(cleanupContext, "stop-remote-relay-and-remove-owned-root",
      pythonCommand(ROOT_STOP, [JSON.stringify({ runRoot, runId, rootReceipt, launchAttempted, ports: [REMOTE_PORT],
        configSha256, storeSha256, runtimeFiles })]), 30_000));
    assert.equal(receipt.remoteRootRemoved, true);
    assert.ok(["root-absent-before-launch", "never-launched", "pidfd-signaled-exited", "recorded-process-already-exited"].includes(receipt.relayStopState));
    assert.equal(receipt.rootReceiptRecovered, rootReceipt === null && receipt.relayStopState !== "root-absent-before-launch");
    if (receipt.relayStopState === "root-absent-before-launch") assert.deepEqual(receipt.portsFree, []);
    else assert.deepEqual(receipt.portsFree, [REMOTE_PORT, ...receipt.dynamicPorts].sort((a, b) => a - b));
    stopped = true;
    lifecycle.cleanupReceipt = receipt;
    await cleanupContext.writeArtifactJsonInternal("remote-relay-cleanup.json", receipt);
    return receipt;
  };
  lifecycle.stop = stop;

  // Register cleanup before root creation so a lost create response can recover its owner marker.
  context.addCleanup("stop owned remote Relay", () => stop(recoveryContext));
  rootReceipt = parseObject(await remoteOutput(context, "create-remote-relay-owned-root",
    pythonCommand(ROOT_CREATE, [runRoot, runId])));
  assert.deepEqual(Object.keys(rootReceipt).sort(), ["dev", "ino", "mode", "uid"].sort());
  assert.equal(rootReceipt.mode, 0o700);
  assert.equal(rootReceipt.uid, 1000, "owned Relay root and its cleanup must use the reviewed remote SSH login UID");
  assert.ok(Number.isSafeInteger(rootReceipt.dev) && Number.isSafeInteger(rootReceipt.ino));
  assert.ok(Number.isSafeInteger(rootReceipt.uid) && rootReceipt.uid > 0);
  const archivePath = context.pathInState("remote-relay-runtime.tar.gz");
  const stagedEntryPath = context.pathInState(REMOTE_ENTRY_FILE);
  await writeFile(stagedEntryPath, await readFile(entryPath), { flag: "wx", mode: 0o600 });
  assert.equal(await shaFile(stagedEntryPath), REMOTE_ENTRY_SHA256, "private entry must stage under the reviewed remote argv basename");
  await createRuntimeArchive(context, archivePath, relayRoot, stagedEntryPath, runtimeFiles);
  await uploadPinnedRelayRuntimeArchive(context, { archivePath, runRoot, sshTransport });
  await sshWrite(context, "write-selected-relay-registration-store",
    privateWriteCommand(`${runRoot}/registration-store.json`), storeBytes);
  await sshWrite(context, "write-remote-relay-private-config",
    privateWriteCommand(`${runRoot}/relay-config.json`), configBytes);

  const verified = parseObject(await remoteOutput(context, "verify-remote-relay-runtime-pins",
    pythonCommand(RUNTIME_VERIFY, [JSON.stringify({ runRoot, rootReceipt, files: runtimeFiles,
      sourceContract: localRuntime.sourceContract })])));
  assert.equal(verified.nodeSha256, PINNED_NODE_SHA256);
  assert.equal(verified.relaySourceCount, 13);
  assert.equal(verified.supportLivePinCount, RELAY_SUPPORT_LIVE_PIN_COUNT);
  assert.equal(verified.getPoolHelperCount, 1);
  assert.equal(verified.wsFileCount, 19);
  assert.equal(verified.fileCount, runtimeFiles.length);
  assert.equal(verified.effectiveUid, rootReceipt.uid);

  launchAttempted = true;
  const started = parseObject(await remoteOutput(context, "start-remote-relay-and-wait-ready",
    pythonCommand(PROCESS_START, [JSON.stringify({ runRoot, runId, rootReceipt,
      nodePath: `${runRoot}/node`, entryPath: `${runRoot}/${REMOTE_ENTRY_FILE}`,
      configPath: `${runRoot}/relay-config.json`, readyPath: config.readyFile,
      nodeSha256: PINNED_NODE_SHA256, ingressPort: REMOTE_PORT })]), 30_000));
  assert.equal(started.ready, true);
  assert.equal(started.runId, runId);
  assert.equal(started.nodeSha256, PINNED_NODE_SHA256);
  assert.deepEqual(started.argv, [`${runRoot}/node`, `${runRoot}/${REMOTE_ENTRY_FILE}`, `${runRoot}/relay-config.json`]);
  assert.equal(started.cwd, runRoot);
  assert.equal(started.runRootIdentity.dev, rootReceipt.dev);
  assert.equal(started.runRootIdentity.ino, rootReceipt.ino);
  assert.equal(started.ports.ingress, REMOTE_PORT);
  assert.notEqual(started.ports.control, started.ports.proxy);
  const safeReceipt = {
    runId, runRoot, pid: started.pid, processGroup: started.processGroup, euid: started.euid,
    starttime: started.starttime, exe: started.exe, exeDev: started.exeDev, exeIno: started.exeIno,
    argv: started.argv, cwd: started.cwd, nodeVersion: started.nodeVersion,
    nodeSha256: started.nodeSha256, runtimeFileCount: verified.fileCount,
    relaySourceCount: verified.relaySourceCount, supportLivePinCount: verified.supportLivePinCount,
    getPoolHelperCount: verified.getPoolHelperCount, relayPoolManifestSha256: RELAY_POOL_MANIFEST_SHA256,
    relayPoolServerBeforeSha256: RELAY_POOL_SERVER_BEFORE_SHA256,
    relayPoolServerSha256: RELAY_POOL_SERVER_AFTER_SHA256,
    relayGetPoolHelperSha256: RELAY_POOL_HELPER_SHA256,
    remoteEntryFile: REMOTE_ENTRY_FILE,
    remoteEntryLocalSourceFile: HOSTED_ENTRY_SOURCE_FILE,
    remoteEntryBaseSha256: REMOTE_ENTRY_BASE_SHA256,
    remoteEntrySha256: REMOTE_ENTRY_SHA256,
    wsFileCount: verified.wsFileCount,
    ports: started.ports,
  };
  lifecycle.receipt = safeReceipt;
  await context.writeArtifactJson("remote-relay-ready.json", safeReceipt);
  return lifecycle;
}

/** Read-only local pin validation used before the private once-run changes remote routing. */
export async function validateOwnedRemoteRelayInputs({ relayRoot, poolManifestPath, poolOverlayRoot }) {
  const entryPath = resolve(dirname(fileURLToPath(import.meta.url)), HOSTED_ENTRY_SOURCE_FILE);
  const verified = await verifyLocalRuntime({ relayRoot, entryPath, poolManifestPath, poolOverlayRoot });
  return {
    fileCount: verified.files.length,
    relaySourceCount: verified.files.filter(row => row.path.startsWith("src/")).length,
    supportLivePinCount: verified.sourceContract.supportPaths.length,
    getPoolHelperCount: 1,
    wsFileCount: verified.files.filter(row => row.path.startsWith("node_modules/ws/")).length,
    manifestSha256: RELAY_POOL_MANIFEST_SHA256,
    serverBeforeSha256: RELAY_POOL_SERVER_BEFORE_SHA256,
    serverAfterSha256: RELAY_POOL_SERVER_AFTER_SHA256,
    getPoolHelperSha256: RELAY_POOL_HELPER_SHA256,
    remoteEntryFile: REMOTE_ENTRY_FILE,
    remoteEntryLocalSourceFile: HOSTED_ENTRY_SOURCE_FILE,
    remoteEntryBaseSha256: REMOTE_ENTRY_BASE_SHA256,
    remoteEntrySha256: REMOTE_ENTRY_SHA256,
  };
}

async function verifyLocalRuntime({ relayRoot, entryPath, poolManifestPath, poolOverlayRoot }) {
  const manifestBytes = await readFile(poolManifestPath);
  assert.equal(shaBytes(manifestBytes), RELAY_POOL_MANIFEST_SHA256, "static03 Relay pool manifest changed");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.revision, "static03");
  assert.equal(manifest.supportLivePins.length, RELAY_SUPPORT_LIVE_PIN_COUNT);
  assert.equal(manifest.files.length, 2);
  const supportByPath = new Map(manifest.supportLivePins.map(row => [row.path, row]));
  const serverOverlay = manifest.files.find(row => row.path === "apps/kcoder-relay/src/server.mjs");
  const poolHelper = manifest.files.find(row => row.path === "apps/kcoder-relay/src/http-get-pool.mjs");
  assert.equal(supportByPath.get("apps/kcoder-relay/src/server.mjs")?.sha256, RELAY_POOL_SERVER_BEFORE_SHA256);
  assert.equal(serverOverlay?.before, RELAY_POOL_SERVER_BEFORE_SHA256);
  assert.equal(serverOverlay?.after, RELAY_POOL_SERVER_AFTER_SHA256);
  assert.equal(poolHelper?.before, null);
  assert.equal(poolHelper?.after, RELAY_POOL_HELPER_SHA256);

  const files = [];
  const add = async (source, target, expectedSha256) => {
    const pin = await filePin(source);
    assert.equal(pin.sha256, expectedSha256, `pinned runtime input changed: ${target}`);
    files.push({ path: target, bytes: pin.bytes, sha256: pin.sha256 });
  };
  await add(PINNED_NODE, "node", PINNED_NODE_SHA256);
  const supportPaths = [];
  for (const row of manifest.supportLivePins) {
    const path = row.path.slice("apps/kcoder-relay/".length);
    const expected = row.path === "apps/kcoder-relay/src/server.mjs" ? RELAY_POOL_SERVER_AFTER_SHA256 : row.sha256;
    await add(resolve(relayRoot, path), path, expected);
    supportPaths.push(path);
  }
  await add(resolve(relayRoot, "src/http-get-pool.mjs"), "src/http-get-pool.mjs", RELAY_POOL_HELPER_SHA256);
  assert.equal(shaBytes(await readFile(resolve(poolOverlayRoot, "apps/kcoder-relay/src/server.mjs"))), RELAY_POOL_SERVER_AFTER_SHA256);
  assert.equal(shaBytes(await readFile(resolve(poolOverlayRoot, "apps/kcoder-relay/src/http-get-pool.mjs"))), RELAY_POOL_HELPER_SHA256);
  const packageLock = JSON.parse(await readFile(resolve(relayRoot, "package-lock.json"), "utf8"));
  assert.equal(packageLock.packages?.["node_modules/ws"]?.version, "8.22.0");
  for (const [path, bytes, expected] of WS_FILE_PINS) {
    const pin = await filePin(resolve(relayRoot, "node_modules/ws", path));
    assert.deepEqual(pin, { bytes, sha256: expected }, `locked ws file changed: ${path}`);
    files.push({ path: `node_modules/ws/${path}`, bytes, sha256: expected });
  }
  const baseEntry = await readFile(REMOTE_ENTRY_BASE_PATH, "utf8");
  assert.equal(shaBytes(baseEntry), REMOTE_ENTRY_BASE_SHA256, "shared Relay ingress baseline changed");
  const expectedHostedEntry = buildHostedMobileIngressCandidate(baseEntry);
  const hostedEntry = await readFile(entryPath, "utf8");
  assert.equal(hostedEntry, expectedHostedEntry, "private hosted Relay entry must contain only the reviewed Mobile route overlay");
  await add(entryPath, REMOTE_ENTRY_FILE, REMOTE_ENTRY_SHA256);
  assert.equal(files.filter(row => row.path.startsWith("src/")).length, 13);
  assert.equal(files.filter(row => row.path.startsWith("node_modules/ws/")).length, 19);
  assert.equal(files.length, 36);
  return { files, sourceContract: { supportPaths, getPoolHelperPath: "src/http-get-pool.mjs" } };
}

async function createRuntimeArchive(context, archivePath, relayRoot, entryPath, runtimeFiles) {
  const relayPaths = runtimeFiles.filter(row => row.path.startsWith("src/") || row.path === "package.json" ||
    row.path === "package-lock.json").map(row => row.path);
  const args = ["-czf", archivePath,
    "-C", dirname(PINNED_NODE), basename(PINNED_NODE),
    "-C", relayRoot,
    ...relayPaths,
    ...WS_FILE_PINS.map(([path]) => `node_modules/ws/${path}`),
    "-C", dirname(entryPath), basename(entryPath)];
  const child = context.spawnOwned("remote-relay-runtime-archive", "/usr/bin/tar", args, { cwd: relayRoot });
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 60_000,
    "create fixed remote Relay runtime archive", 25, context.abortSignal);
  assert.equal(child.exitCode, 0, "fixed remote runtime archive command must succeed");
  assert.ok((await stat(archivePath)).size > 0);
}

function privateWriteCommand(path) {
  return `python3 -c ${shellQuote(buildMarkedPythonSource(PRIVATE_WRITE))} ${shellQuote(path)}`;
}
function pythonCommand(source, args) {
  return `python3 -c ${shellQuote(buildMarkedPythonSource(source))} ${args.map(value => shellQuote(String(value))).join(" ")}`;
}
function parseObject(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("remote Relay receipt was not valid JSON"); }
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value;
}
async function filePin(path) { return { bytes: (await stat(path)).size, sha256: await shaFile(path) }; }
async function shaFile(path) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
function shaBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

const PRIVATE_WRITE = `import os,sys
path=sys.argv[1]; limit=262145
data=sys.stdin.buffer.read(limit)
if len(data)>=limit: raise SystemExit(71)
fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
try:
 os.fchmod(fd,0o600); view=memoryview(data)
 while view:
  n=os.write(fd,view); view=view[n:]
 os.fsync(fd)
finally: os.close(fd)
`;

const ROOT_CREATE = `import json,os,stat,sys
root,run_id=sys.argv[1:3]
os.mkdir(root,0o700); st=os.lstat(root)
assert stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode) and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o700
marker=os.path.join(root,'.owner.json'); fd=None
try:
 fd=os.open(marker,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 body=(json.dumps({'version':1,'runId':run_id,'uid':st.st_uid,'dev':st.st_dev,'ino':st.st_ino},separators=(',',':'))+'\\n').encode()
 os.write(fd,body); os.fsync(fd); os.close(fd); fd=None
 print(json.dumps({'uid':st.st_uid,'dev':st.st_dev,'ino':st.st_ino,'mode':stat.S_IMODE(st.st_mode)},separators=(',',':')))
except BaseException:
 if fd is not None: os.close(fd)
 try: os.unlink(marker)
 except FileNotFoundError: pass
 os.rmdir(root)
 raise
`;

const RUNTIME_VERIFY = `import hashlib,json,os,stat,sys
p=json.loads(sys.argv[1]); root=p['runRoot']; st=os.lstat(root)
assert (st.st_dev,st.st_ino,st.st_uid,stat.S_IMODE(st.st_mode))==(p['rootReceipt']['dev'],p['rootReceipt']['ino'],p['rootReceipt']['uid'],0o700)
def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
 return h.hexdigest()
for row in p['files']:
 path=os.path.join(root,row['path']); st=os.lstat(path)
 assert stat.S_ISREG(st.st_mode) and not stat.S_ISLNK(st.st_mode) and st.st_uid==os.getuid() and st.st_nlink==1
 assert st.st_size==row['bytes'] and sha(path)==row['sha256']
paths={x['path'] for x in p['files']}; support=p['sourceContract']['supportPaths']; helper=p['sourceContract']['getPoolHelperPath']
assert len(support)==14 and len(set(support))==14 and set(support)<=paths
assert helper=='src/http-get-pool.mjs' and helper in paths and helper not in support
assert 'src/server.mjs' in support and 'src/http-get-pool.mjs' in paths
print(json.dumps({'fileCount':len(p['files']),'relaySourceCount':sum(x['path'].startswith('src/') for x in p['files']),'supportLivePinCount':len(support),'getPoolHelperCount':1,'wsFileCount':sum(x['path'].startswith('node_modules/ws/') for x in p['files']),'nodeSha256':sha(os.path.join(root,'node')),'effectiveUid':os.getuid()},separators=(',',':')))
`;

const PROCESS_START = `import json,os,pathlib,select,signal,stat,subprocess,sys,time
p=json.loads(sys.argv[1]); root=p['runRoot']; st=os.lstat(root)
assert (st.st_dev,st.st_ino,st.st_uid,stat.S_IMODE(st.st_mode))==(p['rootReceipt']['dev'],p['rootReceipt']['ino'],p['rootReceipt']['uid'],0o700)
assert hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'), 'pidfd support is required before launch'
probe=os.pidfd_open(os.getpid(),0); os.close(probe)
node=p['nodePath']; entry=p['entryPath']; cfg=p['configPath']; ready=p['readyPath']; log=os.path.join(root,'relay.log'); record=os.path.join(root,'.process.json')
logfd=os.open(log,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
stream=os.fdopen(logfd,'ab',closefd=True); child=None; child_pidfd=None; poller=select.poll()
def identity(pid):
 base=pathlib.Path('/proc')/str(pid); raw=base.joinpath('stat').read_text(); tail=raw[raw.rfind(')')+2:].split()
 uidline=next(x for x in base.joinpath('status').read_text().splitlines() if x.startswith('Uid:')).split()
 return {'pid':pid,'starttime':int(tail[19]),'exe':os.path.realpath(base/'exe'),'cwd':os.path.realpath(base/'cwd'),'argv':[x.decode() for x in base.joinpath('cmdline').read_bytes().split(b'\\0') if x],'euid':int(uidline[2]),'exeDev':os.stat(base/'exe').st_dev,'exeIno':os.stat(base/'exe').st_ino,'pgid':os.getpgid(pid)}
try:
 child=subprocess.Popen([node,entry,cfg],cwd=root,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,close_fds=True,start_new_session=True,env={'PATH':'/usr/bin:/bin'})
 try:
  child_pidfd=os.pidfd_open(child.pid,0)
 finally:
  stream.close()
 poller.register(child_pidfd,select.POLLIN)
 ident=identity(child.pid)
 assert ident['exe']==os.path.realpath(node) and ident['cwd']==os.path.realpath(root) and ident['argv']==[node,entry,cfg] and ident['euid']==os.getuid()
 deadline=time.monotonic()+20; recorded=False
 while time.monotonic()<deadline:
  if poller.poll(0):
   child.wait(timeout=0)
   raise RuntimeError('remote Relay exited before readiness')
  try:
   rs=os.lstat(record)
   assert stat.S_ISREG(rs.st_mode) and not stat.S_ISLNK(rs.st_mode) and rs.st_uid==os.getuid() and rs.st_nlink==1 and stat.S_IMODE(rs.st_mode)==0o600
   try: rec=json.loads(pathlib.Path(record).read_text())
   except json.JSONDecodeError:
    time.sleep(.02); continue
   expected={'version':1,'runId':p['runId'],'rootDev':st.st_dev,'rootIno':st.st_ino,**identity(child.pid)}
   assert rec==expected, 'Node process receipt must match the exact spawned process and owned root'
   recorded=True
  except FileNotFoundError: pass
  if recorded:
   try:
    rs=os.lstat(ready)
    assert stat.S_ISREG(rs.st_mode) and not stat.S_ISLNK(rs.st_mode) and rs.st_uid==os.getuid() and rs.st_nlink==1 and stat.S_IMODE(rs.st_mode)==0o600
    try: r=json.loads(pathlib.Path(ready).read_text())
    except json.JSONDecodeError:
     time.sleep(.02); continue
    assert r['version']==1 and r['runId']==p['runId'] and r['pid']==child.pid and r['runRoot']==root and r['cwd']==root
    assert r['nodeExecutable']==os.path.realpath(node) and r['nodeExecutableSha256']==p['nodeSha256'] and r['ingressPort']==p['ingressPort']
    assert 0<r['controlPort']<=65535 and 0<r['proxyPort']<=65535 and r['controlPort']!=r['proxyPort']
    now=identity(child.pid); assert now==ident and not poller.poll(0)
    print(json.dumps({'ready':True,'runId':p['runId'],'pid':ident['pid'],'starttime':ident['starttime'],'exe':ident['exe'],'exeDev':ident['exeDev'],'exeIno':ident['exeIno'],'processGroup':ident['pgid'],'euid':ident['euid'],'argv':ident['argv'],'cwd':ident['cwd'],'nodeVersion':r['nodeVersion'],'nodeSha256':r['nodeExecutableSha256'],'runRootIdentity':{'dev':st.st_dev,'ino':st.st_ino},'ports':{'ingress':r['ingressPort'],'control':r['controlPort'],'proxy':r['proxyPort']}},separators=(',',':')))
    break
   except FileNotFoundError: pass
  time.sleep(.05)
 else: raise RuntimeError('remote Relay readiness timed out or Node process receipt was not published')
except BaseException:
 if child_pidfd is not None:
  try:
   if not poller.poll(0):
    signal.pidfd_send_signal(child_pidfd,signal.SIGTERM)
    if not poller.poll(5000):
     signal.pidfd_send_signal(child_pidfd,signal.SIGKILL)
     if not poller.poll(5000): raise RuntimeError('failed startup child did not exit after exact pidfd cleanup')
   try: child.wait(timeout=0)
   except subprocess.TimeoutExpired: raise RuntimeError('pidfd reported exit but child could not be reaped')
  except ProcessLookupError: pass
  finally: os.close(child_pidfd)
 raise
else:
 os.close(child_pidfd)
`;

export const ROOT_STOP_ABSENT_BRANCH_PYTHON = `def root_absent_stop_receipt(launch_attempted):
 if launch_attempted: raise RuntimeError('refuse cleanup: remote Relay root absent after launch attempt; ownership and ports unknown')
 return {'remoteRootRemoved':True,'relayStopState':'root-absent-before-launch','rootReceiptRecovered':False,'pid':None,'dynamicPorts':[],'portsFree':[]}
`;

export const ROOT_STOP_ABSENT_BRANCH_REGRESSION_PYTHON = `${ROOT_STOP_ABSENT_BRANCH_PYTHON}
import json
assert root_absent_stop_receipt(False)=={'remoteRootRemoved':True,'relayStopState':'root-absent-before-launch','rootReceiptRecovered':False,'pid':None,'dynamicPorts':[],'portsFree':[]}
try:
 root_absent_stop_receipt(True)
except RuntimeError as error:
 assert str(error)=='refuse cleanup: remote Relay root absent after launch attempt; ownership and ports unknown'
else:
 raise AssertionError('launch-attempted root absence must fail closed')
print('PASS: both root-absent cleanup branches')
`;

const ROOT_STOP = `import hashlib,json,os,pathlib,select,signal,stat,sys,time
p=json.loads(sys.argv[1]); root=p['runRoot']; recpath=os.path.join(root,'.process.json'); ready_path=os.path.join(root,'ready.json')
assert isinstance(p['launchAttempted'],bool)
${ROOT_STOP_ABSENT_BRANCH_PYTHON}
if not os.path.lexists(root):
 print(json.dumps(root_absent_stop_receipt(p['launchAttempted']),separators=(',',':')))
 sys.exit(0)
st=os.lstat(root)
assert stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode) and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o700
def read_private(path):
 q=os.lstat(path); assert stat.S_ISREG(q.st_mode) and not stat.S_ISLNK(q.st_mode) and q.st_uid==os.getuid() and q.st_nlink==1 and stat.S_IMODE(q.st_mode)==0o600
 assert q.st_size<=16384
 return pathlib.Path(path).read_bytes()
owner=json.loads(read_private(os.path.join(root,'.owner.json'))); assert owner=={'version':1,'runId':p['runId'],'uid':st.st_uid,'dev':st.st_dev,'ino':st.st_ino}
recovered={'dev':st.st_dev,'ino':st.st_ino,'uid':st.st_uid,'mode':stat.S_IMODE(st.st_mode)}
root_receipt=p['rootReceipt']; root_receipt_recovered=root_receipt is None
if root_receipt_recovered: root_receipt=recovered
else: assert root_receipt==recovered
if p['launchAttempted'] and not os.path.lexists(recpath):
 deadline=time.monotonic()+5
 while time.monotonic()<deadline and not os.path.lexists(recpath): time.sleep(.05)
if p['launchAttempted'] and not os.path.lexists(recpath): raise RuntimeError('refuse cleanup: launch was attempted but no durable process identity receipt exists')
rec=None; pid=None; relay_state='never-launched'; dynamic=[]
if os.path.lexists(recpath):
 deadline=time.monotonic()+5
 while True:
  raw=read_private(recpath)
  try: rec=json.loads(raw); break
  except json.JSONDecodeError:
   if time.monotonic()>=deadline: raise RuntimeError('process identity receipt remained incomplete; refuse cleanup')
   time.sleep(.02)
 assert rec['version']==1 and rec['runId']==p['runId'] and rec['rootDev']==st.st_dev and rec['rootIno']==st.st_ino
 assert rec['pid']>0 and rec['starttime']>0 and rec['euid']==os.getuid() and rec['cwd']==root
 assert rec['exe']==os.path.join(root,'node') and rec['exeDev']>=0 and rec['exeIno']>0 and rec['pgid']==rec['pid']
 assert rec['argv']==[os.path.join(root,'node'),os.path.join(root,'remote-relay-ingress.once.mjs'),os.path.join(root,'relay-config.json')]
 pid=rec['pid']
 try: fd=os.pidfd_open(pid,0)
 except ProcessLookupError: fd=None; relay_state='recorded-process-already-exited'
 if fd is not None:
  poller=select.poll(); poller.register(fd,select.POLLIN)
  def same():
   base=pathlib.Path('/proc')/str(pid)
   raw=base.joinpath('stat').read_text(); tail=raw[raw.rfind(')')+2:].split(); uid=next(x for x in base.joinpath('status').read_text().splitlines() if x.startswith('Uid:')).split()
   argv=[x.decode() for x in base.joinpath('cmdline').read_bytes().split(b'\\0') if x]
   exe=os.stat(base/'exe')
   return int(tail[19])==rec['starttime'] and os.path.realpath(base/'exe')==rec['exe'] and (exe.st_dev,exe.st_ino)==(rec['exeDev'],rec['exeIno']) and os.path.realpath(base/'cwd')==rec['cwd'] and argv==rec['argv'] and int(uid[2])==rec['euid'] and os.getpgid(pid)==rec['pgid']
  try:
   if poller.poll(0): relay_state='recorded-process-already-exited'
   else:
    try: matches=same()
    except (FileNotFoundError,ProcessLookupError): matches=False
    if poller.poll(0): relay_state='recorded-process-already-exited'
    else:
     assert matches, 'recorded remote Relay PID identity changed; refuse signal/cleanup'
     signal.pidfd_send_signal(fd,signal.SIGTERM)
     if not poller.poll(10000):
      assert same(), 'remote Relay identity changed before bounded SIGKILL'
      signal.pidfd_send_signal(fd,signal.SIGKILL)
      if not poller.poll(5000): raise RuntimeError('remote Relay did not exit after exact pidfd signals')
     relay_state='pidfd-signaled-exited'
  finally: os.close(fd)
if os.path.lexists(ready_path):
 assert rec is not None, 'ready receipt without process identity is unowned; refuse cleanup'
 ready=json.loads(read_private(ready_path))
 assert ready['version']==1 and ready['runId']==p['runId'] and ready['pid']==pid and ready['runRoot']==root and ready['cwd']==root and ready['ingressPort'] in p['ports']
 assert ready['nodeExecutable']==rec['exe']
 dynamic=[ready[k] for k in ('controlPort','proxyPort')]
ports=sorted(set(p['ports']+dynamic))
# KCUX_PORT_RELEASE_CHECK_BEGIN
def tcp_socket_states(port):
 assert isinstance(port,int) and 0<port<=65535
 states=[]; tables=0
 for table in ('/proc/net/tcp','/proc/net/tcp6'):
  try:
   with open(table,'r') as stream: lines=stream.readlines()
  except FileNotFoundError:
   if table=='/proc/net/tcp': raise
   continue
  tables+=1
  if not lines: raise RuntimeError('kernel TCP socket table is empty')
  for line in lines[1:]:
   fields=line.split()
   if not fields: continue
   if len(fields)<4: raise RuntimeError('kernel TCP socket row is malformed')
   local=fields[1].rsplit(':',1)
   if len(local)!=2: raise RuntimeError('kernel TCP local endpoint is malformed')
   if local[1].upper()!=f'{port:04X}': continue
   state=fields[3].upper()
   if len(state)!=2 or any(char not in '0123456789ABCDEF' for char in state):
    raise RuntimeError('kernel TCP state is malformed')
   states.append(state)
 if tables==0: raise RuntimeError('kernel TCP socket tables are unavailable')
 return states
def assert_no_active_tcp_socket(port):
 states=tcp_socket_states(port)
 active=[state for state in states if state!='06']
 if active: raise RuntimeError('port retains non-TIME_WAIT TCP sockets')
 return states.count('06')
# KCUX_PORT_RELEASE_CHECK_END
time_wait_counts={}
for port in ports:
 count=assert_no_active_tcp_socket(port)
 if count: time_wait_counts[str(port)]=count
allowed=set(x['path'] for x in p['runtimeFiles'])|{'.owner.json','.process.json','relay-config.json','registration-store.json','ready.json','relay.log'}
dirs={'src','node_modules','node_modules/ws','node_modules/ws/lib'}; seen=set(); seen_dirs=set()
for current,subdirs,files in os.walk(root,topdown=True,followlinks=False):
 rel=os.path.relpath(current,root); rel='' if rel=='.' else rel
 for name in list(subdirs):
  path=os.path.join(current,name); q=os.lstat(path); r=os.path.join(rel,name)
  assert stat.S_ISDIR(q.st_mode) and not stat.S_ISLNK(q.st_mode) and q.st_uid==os.getuid()
  seen_dirs.add(r)
 for name in files:
  path=os.path.join(current,name); q=os.lstat(path); r=os.path.join(rel,name)
  assert stat.S_ISREG(q.st_mode) and not stat.S_ISLNK(q.st_mode) and q.st_uid==os.getuid() and q.st_nlink==1
  seen.add(r)
assert '.owner.json' in seen and seen<=allowed and seen_dirs<=dirs, 'remote Relay root has an unknown path; fail closed'
def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
 return h.hexdigest()
if 'relay-config.json' in seen: assert sha(os.path.join(root,'relay-config.json'))==p['configSha256']
if 'registration-store.json' in seen: assert sha(os.path.join(root,'registration-store.json'))==p['storeSha256']
for row in p['runtimeFiles']:
 if row['path'] in seen: assert sha(os.path.join(root,row['path']))==row['sha256']
for path in sorted(seen): os.unlink(os.path.join(root,path))
for path in sorted(seen_dirs,key=lambda x:x.count('/'),reverse=True): os.rmdir(os.path.join(root,path))
os.rmdir(root)
print(json.dumps({'remoteRootRemoved':True,'relayStopState':relay_state,'rootReceiptRecovered':root_receipt_recovered,'pid':pid,'dynamicPorts':dynamic,'portsFree':ports,'timeWaitSocketCounts':time_wait_counts},separators=(',',':')))
`;
