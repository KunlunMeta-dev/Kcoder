import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, RunContext, runE2E, waitFor } from "../harness/run-context.mjs";
import { buildMarkedPythonSource, createOwnedSshDispatcher } from "../harness/owned-ssh-control-master.mjs";

// Reviewed candidate only. It deletes one authenticated, never-launched Relay root
// after checking the exact root owner receipt, process/port absence, tree shape, and
// the one observed partial Node file against its locally pinned source prefix.
const ENABLE = "KCODER_E2E_PARTIAL_RELAY_ROOT_CLEANUP_ONCE";
const PREVIOUS_RUN = resolve(repoRoot,
  "target/test/apps/kcoder-studio/e2e/private/mobile-public-hosted-relay-ui-once.e2e.mjs/20261009-134143.798Z");
const RECOVERY_RUN = resolve(repoRoot,
  "target/test/apps/kcoder-studio/e2e/private/mobile-public-hosted-relay-ui-once.e2e.mjs/20261009-134220.785Z");
const NODE_PATH = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const NODE_FULL_BYTES = 121_609_656;
const NODE_FULL_SHA256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const NODE_PARTIAL_BYTES = 110_767_104;
const NODE_PARTIAL_PREFIX_SHA256 = "c0ea5c22fad2717fe733af7afea6c312996b41b2f6a667edbcbcca10324d46d5";
const NODE_MODE = 0o755;
const RELAY_INGRESS_PORT = 32552;
const SSH_CONFIG = "/home/hyf/.ssh/config";
const SSH_KNOWN_HOSTS = "/home/hyf/.ssh/known_hosts";
const SSH_TARGET = "aliyun";
const SSH_OPTIONS = [
  "-F", SSH_CONFIG,
  "-o", `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
  "-o", "StrictHostKeyChecking=yes",
  "-o", "BatchMode=yes",
  "-o", "ControlMaster=no",
  "-o", "ControlPath=none",
  "-o", "ConnectTimeout=15",
];

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

assert.equal(process.env[ENABLE], "1", `set ${ENABLE}=1 to authorize this reviewed one-run cleanup candidate`);
assert.equal(process.version, "v22.17.0");

const sourceUrl = pathToFileURL(resolve(repoRoot,
  "apps/kcoder-studio/e2e/private/cleanup-partial-owned-relay-root-20261009.candidate.once.mjs"));
await runE2E(sourceUrl, {
  testId: "cleanup-one-partial-owned-relay-root-20261009",
  tier: "manual-live",
  bodyAbortTimeoutMs: 4_000,
  cleanupTimeoutMs: 8_000,
  retainSuccessLogs: true,
  modelPolicy: "single guarded deletion of the exact never-launched UID-1000 Relay root; no Browser, Provider, production service, or other remote path",
}, async context => {
  const previousManifest = JSON.parse(await readFile(join(PREVIOUS_RUN, "manifest.json"), "utf8"));
  assert.equal(typeof previousManifest.seed, "string");
  const runId = sha256(Buffer.from(`public-relay-direct:${previousManifest.seed}`)).slice(0, 24);
  const runRoot = `/tmp/kc-phone-ux-relay-${runId}`;
  const rootLog = await readFile(join(PREVIOUS_RUN, "logs/ssh-0012-create-remote-relay-owned-root.log"), "utf8");
  const ownerLine = rootLog.split(/\r?\n/).find(line => line.startsWith("{"));
  assert.ok(ownerLine, "exact original Relay root receipt is required");
  const rootReceipt = JSON.parse(ownerLine);
  assert.deepEqual(Object.keys(rootReceipt).sort(), ["dev", "ino", "mode", "uid"]);
  assert.equal(rootReceipt.uid, 1000);
  assert.equal(rootReceipt.mode, 0o700);

  const previousResult = JSON.parse(await readFile(join(PREVIOUS_RUN, "artifacts/result.json"), "utf8"));
  assert.equal(previousResult.status, "failed");
  assert.equal(previousResult.testId, "mobile-public-hosted-relay-real-rust-ui-once");
  assert.equal(await exists(join(PREVIOUS_RUN, "artifacts/remote-relay-ready.json")), false);
  assert.equal(await exists(join(PREVIOUS_RUN, "artifacts/remote-relay-cleanup.json")), false);
  for (const stage of [
    "ssh-stage-0013-write-selected-relay-registration-store.json",
    "ssh-stage-0014-write-remote-relay-private-config.json",
    "ssh-stage-0015-verify-remote-relay-runtime-pins.json",
    "ssh-stage-0016-start-remote-relay-and-wait-ready.json",
  ]) assert.equal(await exists(join(PREVIOUS_RUN, "artifacts", stage)), false);
  const rejectedStopLog = await readFile(join(RECOVERY_RUN,
    "logs/ssh-0013-stop-remote-relay-and-remove-owned-root.log"), "utf8");
  assert.match(rejectedStopLog, /File "<string>", line 130/);
  assert.match(rejectedStopLog, /AssertionError/);

  const localNode = await readFile(NODE_PATH);
  const localNodeStat = await stat(NODE_PATH);
  assert.equal(localNodeStat.size, NODE_FULL_BYTES);
  assert.equal(localNodeStat.mode & 0o777, NODE_MODE);
  assert.equal(sha256(localNode), NODE_FULL_SHA256);
  assert.equal(sha256(localNode.subarray(0, NODE_PARTIAL_BYTES)), NODE_PARTIAL_PREFIX_SHA256);

  context.registerSecret(runId);
  context.registerSecret(runRoot);
  const remotePython = `import hashlib,json,os,stat,sys,time
p=json.loads(sys.argv[1]); root=p['runRoot']; run_id=p['runId']; deadline=time.monotonic()+12.0
assert root=='/tmp/kc-phone-ux-relay-'+run_id and len(run_id)==24 and all(c in '0123456789abcdef' for c in run_id)
port=int(p['ingressPort']); expected=p['rootReceipt']; partial_bytes=int(p['partialBytes']); partial_sha=p['partialSha256']
def fail(message): raise RuntimeError('refuse partial Relay cleanup: '+message)
if p.get('launchAttempted') is not False: fail('Relay launch state is not never-launched')
def port_states(port):
 states=[]; tables=0
 for table in ('/proc/net/tcp','/proc/net/tcp6'):
  try:
   with open(table,'r') as stream: lines=stream.readlines()
  except FileNotFoundError:
   if table.endswith('/tcp'): raise
   continue
  if not lines: fail('kernel TCP socket table is empty')
  tables+=1
  for line in lines[1:]:
   fields=line.split()
   if len(fields)<4: fail('kernel TCP socket row is malformed')
   local=fields[1].rsplit(':',1)
   if len(local)!=2: fail('kernel TCP local endpoint is malformed')
   if local[1].upper()!=format(port,'04X'): continue
   state=fields[3].upper()
   if len(state)!=2 or any(char not in '0123456789ABCDEF' for char in state): fail('kernel TCP state is malformed')
   states.append(state)
 if tables==0: fail('kernel TCP socket tables are unavailable')
 return states
try: rst=os.lstat(root)
except FileNotFoundError: fail('exact root is already absent; candidate is single-use')
if not stat.S_ISDIR(rst.st_mode) or stat.S_ISLNK(rst.st_mode): fail('root type changed')
actual={'dev':rst.st_dev,'ino':rst.st_ino,'uid':rst.st_uid,'mode':stat.S_IMODE(rst.st_mode)}
if actual!=expected or actual['uid']!=1000 or actual['mode']!=0o700: fail('root owner receipt changed')
parent_fd=os.open('/tmp',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
root_name=os.path.basename(root)
try:
 parent_st=os.fstat(parent_fd)
 if not stat.S_ISDIR(parent_st.st_mode) or parent_st.st_uid!=0 or not (parent_st.st_mode&stat.S_ISVTX): fail('temporary parent is not the expected sticky root-owned directory')
 root_fd=os.open(root_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent_fd)
 try:
  opened_root=os.fstat(root_fd)
  if (opened_root.st_dev,opened_root.st_ino,opened_root.st_uid,stat.S_IMODE(opened_root.st_mode))!=(rst.st_dev,rst.st_ino,1000,0o700): fail('root changed while opening')
  names=set(os.listdir(root_fd))
  if names!={'.owner.json','node'}: fail('root entries differ from the one observed partial archive')
  for forbidden in ('.process.json','ready.json','relay-config.json','registration-store.json','relay.log'):
   if os.path.lexists(os.path.join(root,forbidden)): fail('lifecycle receipt or post-upload file exists')
  owner_fd=os.open('.owner.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root_fd)
  try:
   owner_st=os.fstat(owner_fd)
   owner_data=os.read(owner_fd,4097)
  finally: os.close(owner_fd)
  if not stat.S_ISREG(owner_st.st_mode) or owner_st.st_uid!=1000 or owner_st.st_nlink!=1 or stat.S_IMODE(owner_st.st_mode)!=0o600 or owner_st.st_size!=len(owner_data) or len(owner_data)>4096: fail('owner marker type or mode changed')
  owner=json.loads(owner_data)
  if owner!={'version':1,'runId':run_id,'uid':rst.st_uid,'dev':rst.st_dev,'ino':rst.st_ino}: fail('owner marker does not match this run')
  node_fd=os.open('node',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root_fd)
  try:
   node_st=os.fstat(node_fd)
   if not stat.S_ISREG(node_st.st_mode) or node_st.st_uid!=1000 or node_st.st_nlink!=1 or stat.S_IMODE(node_st.st_mode)!=0o755 or node_st.st_size!=partial_bytes: fail('partial Node metadata differs from observed pinned prefix')
   h=hashlib.sha256(); total=0
   while True:
    if time.monotonic()>deadline: fail('hash deadline exceeded')
    block=os.read(node_fd,1024*1024)
    if not block: break
    total+=len(block); h.update(block)
   if total!=partial_bytes or h.hexdigest()!=partial_sha: fail('partial Node bytes differ from the pinned local prefix')
   after=os.fstat(node_fd)
   if (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)!=(node_st.st_dev,node_st.st_ino,node_st.st_size,node_st.st_mtime_ns): fail('partial Node changed while hashing')
  finally: os.close(node_fd)
  states=port_states(port)
  if any(state!='06' for state in states): fail('Relay ingress port has an active TCP socket')
  if set(os.listdir(root_fd))!={'.owner.json','node'}: fail('root entries changed before removal')
  node_now=os.stat('node',dir_fd=root_fd,follow_symlinks=False)
  owner_now=os.stat('.owner.json',dir_fd=root_fd,follow_symlinks=False)
  root_now=os.fstat(root_fd)
  if (root_now.st_dev,root_now.st_ino,root_now.st_uid,stat.S_IMODE(root_now.st_mode))!=(rst.st_dev,rst.st_ino,1000,0o700): fail('root identity changed before removal')
  if (node_now.st_dev,node_now.st_ino,node_now.st_uid,node_now.st_nlink,stat.S_IMODE(node_now.st_mode),node_now.st_size,node_now.st_mtime_ns)!=(node_st.st_dev,node_st.st_ino,1000,1,0o755,node_st.st_size,node_st.st_mtime_ns): fail('partial Node identity changed before unlink')
  if (owner_now.st_dev,owner_now.st_ino,owner_now.st_uid,owner_now.st_nlink,stat.S_IMODE(owner_now.st_mode),owner_now.st_size,owner_now.st_mtime_ns)!=(owner_st.st_dev,owner_st.st_ino,1000,1,0o600,owner_st.st_size,owner_st.st_mtime_ns): fail('owner marker identity changed before unlink')
  os.unlink('node',dir_fd=root_fd)
  os.unlink('.owner.json',dir_fd=root_fd)
  os.fsync(root_fd)
  os.rmdir(root_name,dir_fd=parent_fd)
  os.fsync(parent_fd)
  if os.path.lexists(root): fail('root remains after exact owned-file removal')
  if any(state!='06' for state in port_states(port)): fail('Relay ingress port became active after removal')
  print(json.dumps({'remoteRootRemoved':True,'relayStopState':'never-launched','rootReceiptMatched':True,
   'ownerMarkerMatched':True,'removedFileCount':2,'removedPartialFile':'node','partialBytes':partial_bytes,
   'partialSha256':partial_sha,'launchAttempted':False,'processReceiptAbsent':True,
   'readyReceiptAbsent':True,'ingressPortFree':True},separators=(',',':')))
 finally: os.close(root_fd)
finally: os.close(parent_fd)
`;

  const payload = {
    runId,
    runRoot,
    rootReceipt,
    launchAttempted: false,
    ingressPort: RELAY_INGRESS_PORT,
    partialBytes: NODE_PARTIAL_BYTES,
    partialSha256: NODE_PARTIAL_PREFIX_SHA256,
  };
  const command = `python3 -c ${shellQuote(buildMarkedPythonSource(remotePython))} ${shellQuote(JSON.stringify(payload))}`;
  const recovery = await RunContext.create(sourceUrl, {
    testId: "cleanup-one-partial-owned-relay-root-20261009-ssh",
    tier: "manual-live",
    cleanupTimeoutMs: 5_000,
    retainSuccessLogs: true,
  });
  recovery.abortSignal = context.abortSignal;
  recovery.registerSecret(runId);
  recovery.registerSecret(runRoot);
  const dispatcher = createOwnedSshDispatcher({
    primaryContext: context,
    managedTransport: { async spawnManaged() { throw new Error("cleanup uses the reviewed direct recovery path only"); } },
    binary: "/usr/bin/ssh",
    target: SSH_TARGET,
    directOptions: SSH_OPTIONS,
  });
  dispatcher.attachRecoveryContext(recovery);
  context.addCleanup("finish direct SSH cleanup context", async () => {
    if (!recovery.finished) await recovery.finish("failed", null, new Error("direct cleanup context ended before completion"));
  });

  let receipt;
  try {
    const label = "remove-exact-partial-owned-relay-root";
    const child = await dispatcher.spawn(recovery, label, command, {
      cwd: repoRoot,
      env: recovery.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
    });
    const stdout = [];
    let stdoutBytes = 0;
    let overflow = false;
    let closeInfo = null;
    let spawnError = false;
    child.once("error", () => { spawnError = true; });
    child.once("close", (code, signal) => { closeInfo = { code, signal }; });
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 64 * 1024) {
        overflow = true;
        void recovery.stopOwned(label).catch(() => {});
      } else stdout.push(Buffer.from(chunk));
    });
    try {
      await waitFor(() => closeInfo !== null || spawnError, 18_500,
        "single bounded exact-owner Relay root cleanup", 25, context.abortSignal);
    } catch (error) {
      await recovery.stopOwned(label).catch(() => {});
      throw new Error(`bounded exact-owner cleanup did not complete (${error?.name || "Error"})`);
    }
    assert.equal(closeInfo?.code, 0, "guarded partial Relay root cleanup must succeed");
    assert.equal(closeInfo?.signal, null);
    assert.equal(spawnError, false);
    assert.equal(overflow, false);
    receipt = JSON.parse(Buffer.concat(stdout).toString("utf8").trim());
    assert.deepEqual(receipt, {
      remoteRootRemoved: true,
      relayStopState: "never-launched",
      rootReceiptMatched: true,
      ownerMarkerMatched: true,
      removedFileCount: 2,
      removedPartialFile: "node",
      partialBytes: NODE_PARTIAL_BYTES,
      partialSha256: NODE_PARTIAL_PREFIX_SHA256,
      launchAttempted: false,
      processReceiptAbsent: true,
      readyReceiptAbsent: true,
      ingressPortFree: true,
    });
    await context.writeArtifactJson("partial-owned-relay-root-cleanup.json", receipt);
    await recovery.finish("passed", { receipt }, null);
    return receipt;
  } catch (error) {
    await recovery.finish("failed", null, new Error("guarded cleanup failed; raw remote output suppressed")).catch(() => {});
    throw error;
  }
});

async function exists(path) {
  try { await stat(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
