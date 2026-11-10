import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  assertOwnedSocketStat,
  createSshStageObserver,
  buildControlCheckArgs,
  buildFreshSshArgs,
  buildManagedSshArgs,
  buildSshMasterArgs,
  createOwnedSshDispatcher,
  createManagedSshTransport,
  runOwnedSshOperation,
  remoteOwnedProcessGuardSource,
  cleanupOwnedControlSocketDirectory,
  parseSshStageMarkers,
  startOwnedSshControlMaster,
} from "./owned-ssh-control-master.mjs";

const config = Object.freeze({
  target: "approved-host-alias",
  configPath: "/private/ssh/config",
  knownHostsPath: "/private/ssh/known_hosts",
  controlPath: "/tmp/kcsm-test/c",
});
const directoryIdentity = { dev: "1", ino: "2", uid: process.getuid(), mode: 0o700 };
const socketIdentity = { dev: "1", ino: "3", uid: process.getuid(), mode: 0o600 };
const fakeDirectoryStat = identity => ({
  dev: BigInt(identity.dev), ino: BigInt(identity.ino), uid: identity.uid, mode: 0o40700,
  isDirectory: () => true, isSymbolicLink: () => false,
});
const fakeSocketStat = identity => ({
  dev: BigInt(identity.dev), ino: BigInt(identity.ino), uid: identity.uid, mode: 0o140600,
  isSocket: () => true, isSymbolicLink: () => false,
});

test("master and managed slave argv are explicit and slave cannot direct-fallback", () => {
  const master = buildSshMasterArgs(config);
  assert.ok(master.includes("-M") && master.includes("-N") && master.includes("-T"));
  assert.ok(master.includes("ControlMaster=yes"));
  assert.ok(master.includes("ControlPersist=no"));
  assert.ok(master.includes("ClearAllForwardings=yes"));
  assert.ok(!master.some(value => ["-f", "-L", "-R", "-D", "-W"].includes(value)));

  const slave = buildManagedSshArgs(config, "sudo -n true");
  assert.ok(slave.includes("ControlMaster=no"));
  assert.ok(slave.includes("ControlPath=" + config.controlPath));
  assert.ok(slave.includes("ProxyCommand=/bin/false"));
  assert.ok(slave.includes("ProxyJump=none"));
  assert.ok(slave.includes("ClearAllForwardings=yes"));
  assert.ok(!slave.some(value => ["-L", "-R", "-D", "-W"].includes(value)));
  assert.equal(slave.at(-2), config.target);
});

test("control check remains a local mux control operation with fail-closed options", () => {
  const args = buildControlCheckArgs(config);
  assert.ok(args.includes("-O") && args.includes("check"));
  assert.ok(args.includes("ControlPath=" + config.controlPath));
  assert.ok(args.includes("ProxyCommand=/bin/false"));
});

test("fresh recovery explicitly disables control sockets and never routes through the master", () => {
  const directOptions = ["-F", config.configPath, "-o", `UserKnownHostsFile=${config.knownHostsPath}`,
    "-o", "ControlMaster=no", "-o", "ControlPath=none"];
  const args = buildFreshSshArgs({ target: config.target, directOptions }, "sudo -n true");
  assert.deepEqual(args.slice(0, 2), ["-T", "-F"]);
  assert.ok(args.includes("ControlMaster=no"));
  assert.ok(args.includes("ControlPath=none"));
  assert.ok(!args.includes(config.controlPath));
  assert.throws(() => buildFreshSshArgs({ target: config.target,
    directOptions: [...directOptions, "-o", "ControlPath=/tmp/kcsm-other/c"] }, "true"));
  assert.throws(() => buildFreshSshArgs({ target: config.target,
    directOptions: ["-oControlMaster=no", "-oControlPath=none", "-S", config.controlPath] }, "true"));
  assert.throws(() => buildFreshSshArgs({ target: config.target,
    directOptions: ["-o", "ControlMaster=no", "-o", "ControlMaster=yes", "-o", "ControlPath=none"] }, "true"));
});

test("transaction dispatcher uses the owned master only for its primary context", async () => {
  const spawned = [];
  const primary = { spawnOwned() { throw new Error("primary direct spawn forbidden"); }, isolatedEnvironment: () => ({}) };
  const recovery = { spawnOwned(label, binary, args, options) { spawned.push({ label, binary, args, options }); return "fresh"; },
    isolatedEnvironment: () => ({}) };
  const foreign = { spawnOwned() { throw new Error("foreign context must not spawn"); }, isolatedEnvironment: () => ({}) };
  let managedCalls = 0;
  const dispatcher = createOwnedSshDispatcher({ primaryContext: primary,
    managedTransport: { async spawnManaged(label, command, options) { managedCalls++; return { label, command, options }; } },
    target: config.target, directOptions: ["-F", config.configPath, "-o", "ControlMaster=no", "-o", "ControlPath=none"] });
  assert.equal((await dispatcher.spawn(primary, "normal-step", "sudo -n true")).label, "normal-step");
  assert.equal(managedCalls, 1);
  dispatcher.attachRecoveryContext(recovery);
  assert.equal(await dispatcher.spawn(recovery, "recovery-step", "sudo -n true"), "fresh");
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes("ControlPath=none"));
  assert.throws(() => dispatcher.attachRecoveryContext({}), /once/);
  await assert.rejects(dispatcher.spawn(foreign, "foreign-step", "true"), /not owned/);
});

test("stage parser accepts only fixed enum markers and does not expose caller data", () => {
  assert.deepEqual(parseSshStageMarkers(
    "noise\nKCUX_STAGE:REMOTE_PYTHON_ENTERED\nKCUX_STAGE:REMOTE_PROGRAM_COMPLETE\n",
    17.25,
  ), [
    { stage: "REMOTE_PYTHON_ENTERED", receivedAtMs: 17.25 },
    { stage: "REMOTE_PROGRAM_COMPLETE", receivedAtMs: 17.25 },
  ]);
  assert.throws(() => parseSshStageMarkers("KCUX_STAGE:REMOTE_PYTHON_ENTERED token=hidden"));
});

test("bounded stage observer handles split lines and fails closed on unknown or excess markers", () => {
  const observer = createSshStageObserver(performance.now(), 1);
  observer.push(Buffer.from("KCUX_STAGE:REMOTE_PYTHON_"));
  observer.push(Buffer.from("ENTERED\nKCUX_STAGE:REMOTE_PROGRAM_COMPLETE\n"));
  const result = observer.finish();
  assert.equal(result.valid, false);
  assert.equal(result.markers.length, 1);
  assert.equal(result.markers[0].stage, "REMOTE_PYTHON_ENTERED");
  assert.equal(result.droppedMarkerCount, 1);
  assert.throws(() => observer.push(Buffer.from("later")));

  const malformed = createSshStageObserver();
  malformed.push(Buffer.from("KCUX_STAGE:REMOTE_PYTHON_ENTERED secret=hidden\n"));
  assert.equal(malformed.finish().invalidMarkerCount, 1);

  const byteBounded = createSshStageObserver(performance.now(), 4, 8);
  byteBounded.push(Buffer.from("123456789"));
  const byteResult = byteBounded.finish();
  assert.equal(byteResult.valid, false);
  assert.equal(byteResult.droppedBytes, 9);
});

test("socket cleanup ownership compares device, inode, uid, type and mode", () => {
  assertOwnedSocketStat(fakeSocketStat(socketIdentity), socketIdentity, process.getuid());
  assert.throws(() => assertOwnedSocketStat(fakeSocketStat({ ...socketIdentity, ino: "4" }), socketIdentity, process.getuid()));
  assert.throws(() => assertOwnedSocketStat(fakeSocketStat({ ...socketIdentity, uid: process.getuid() + 1 }), socketIdentity, process.getuid()));
  assert.throws(() => assertOwnedSocketStat({ ...fakeSocketStat(socketIdentity), isSocket: () => false }, socketIdentity, process.getuid()));
});

test("every managed spawn awaits owner, inode and control gates; failed gate never spawns", async () => {
  let spawned = 0, checked = 0, ownerChecks = 0, socketChecks = 0;
  const child = { pid: 123, exitCode: null, signalCode: null };
  const context = {
    spawnOwned(_label, _binary, args) { spawned++; return { args }; },
  };
  const makeTransport = checkControl => createManagedSshTransport({
    context, binary: "/usr/bin/ssh", config, controlPath: config.controlPath,
    controlDirectory: "/tmp/kcsm-test", masterChild: child,
    masterIdentity: {}, directoryIdentity, socketIdentity: () => socketIdentity,
    assertMasterOwner: async () => { ownerChecks++; },
    fsOps: {
      async lstat(path) {
        if (path === "/tmp/kcsm-test") return fakeDirectoryStat(directoryIdentity);
        socketChecks++;
        return fakeSocketStat(socketIdentity);
      },
      async readdir() { return []; }, async unlink() {}, async rmdir() {},
    },
    checkControl,
  });

  const transport = makeTransport(async () => { checked++; return true; });
  const result = await transport.spawnManaged("one-command", "sudo -n true");
  assert.equal(spawned, 1);
  assert.equal(checked, 1);
  assert.equal(ownerChecks, 2, "master process identity is checked both before and after the mux probe");
  assert.equal(socketChecks, 2, "socket identity is rechecked after the awaited control check");
  assert.equal(result.args.at(-2), config.target);

  const blocked = makeTransport(async () => false);
  await assert.rejects(blocked.spawnManaged("must-not-spawn", "sudo -n true"));
  assert.equal(spawned, 1, "no SSH child is created after the readiness gate rejects");

  const exitsDuringCheck = makeTransport(async () => { child.exitCode = 0; return true; });
  await assert.rejects(exitsDuringCheck.spawnManaged("master-exits-during-check", "sudo -n true"));
  assert.equal(spawned, 1, "a master that exits during readiness cannot fall back to direct SSH");

  child.exitCode = 0;
  await assert.rejects(transport.spawnManaged("master-already-gone", "sudo -n true"));
  assert.equal(spawned, 1, "an exited master never reaches context.spawnOwned");
});

test("managed spawn rejects a replaced directory or master after the mux check", async () => {
  const child = { pid: 321, exitCode: null, signalCode: null };
  let spawned = 0;
  const context = { spawnOwned() { spawned++; return {}; } };
  let directoryStats = 0;
  const directoryReplacement = createManagedSshTransport({
    context, binary: "/usr/bin/ssh", config, controlPath: config.controlPath,
    controlDirectory: "/tmp/kcsm-test", masterChild: child, masterIdentity: {},
    directoryIdentity, socketIdentity: () => socketIdentity,
    assertMasterOwner: async () => {},
    fsOps: {
      async lstat(path) {
        if (path === "/tmp/kcsm-test") {
          directoryStats++;
          return fakeDirectoryStat(directoryStats === 1 ? directoryIdentity : { ...directoryIdentity, ino: "99" });
        }
        return fakeSocketStat(socketIdentity);
      },
      async readdir() { return []; }, async unlink() {}, async rmdir() {},
    },
    async checkControl() { return true; },
  });
  await assert.rejects(directoryReplacement.spawnManaged("directory-replaced", "sudo -n true"));
  assert.equal(spawned, 0);

  let ownerChecks = 0;
  const masterReplacement = createManagedSshTransport({
    context, binary: "/usr/bin/ssh", config, controlPath: config.controlPath,
    controlDirectory: "/tmp/kcsm-test", masterChild: child, masterIdentity: {},
    directoryIdentity, socketIdentity: () => socketIdentity,
    assertMasterOwner: async () => {
      ownerChecks++;
      if (ownerChecks === 2) throw new Error("master identity changed");
    },
    fsOps: {
      async lstat(path) { return path === "/tmp/kcsm-test" ? fakeDirectoryStat(directoryIdentity) : fakeSocketStat(socketIdentity); },
      async readdir() { return []; }, async unlink() {}, async rmdir() {},
    },
    async checkControl() { return true; },
  });
  await assert.rejects(masterReplacement.spawnManaged("master-replaced", "sudo -n true"), /master identity changed/);
  assert.equal(spawned, 0);
});

test("owned cleanup refuses an inode replacement even when basename is unchanged", async () => {
  let unlinked = false, removedDirectory = false;
  const child = { exitCode: 0, signalCode: null };
  const context = { spawnOwned() { throw new Error("unused"); } };
  const transport = createManagedSshTransport({
    context, binary: "/usr/bin/ssh", config, controlPath: config.controlPath,
    controlDirectory: "/tmp/kcsm-test", masterChild: child,
    masterIdentity: {}, directoryIdentity, socketIdentity: () => socketIdentity,
    assertMasterOwner: async () => {},
    fsOps: {
      async lstat(path) {
        if (path === "/tmp/kcsm-test") return fakeDirectoryStat(directoryIdentity);
        return fakeSocketStat({ ...socketIdentity, ino: "99" });
      },
      async readdir() { return ["c"]; },
      async unlink() { unlinked = true; },
      async rmdir() { removedDirectory = true; },
    },
    async checkControl() { return true; },
  });
  await assert.rejects(transport.removeOwnedSocketDirectory());
  assert.equal(unlinked, false);
  assert.equal(removedDirectory, false);
});

test("owned socket cleanup first proves the master process is gone", async () => {
  let unlinked = false;
  const child = { pid: 123, exitCode: 0, signalCode: null };
  const context = { spawnOwned() { throw new Error("unused"); } };
  const transport = createManagedSshTransport({
    context, binary: "/usr/bin/ssh", config, controlPath: config.controlPath,
    controlDirectory: "/tmp/kcsm-test", masterChild: child,
    masterIdentity: {}, directoryIdentity, socketIdentity: () => socketIdentity,
    assertMasterGone: async () => { throw new Error("master still owned"); },
    fsOps: {
      async lstat(path) { return path === "/tmp/kcsm-test" ? fakeDirectoryStat(directoryIdentity) : fakeSocketStat(socketIdentity); },
      async readdir() { return ["c"]; }, async unlink() { unlinked = true; }, async rmdir() {},
    },
    async checkControl() { return true; },
  });
  await assert.rejects(transport.removeOwnedSocketDirectory(), /master still owned/);
  assert.equal(unlinked, false);
});

test("actual RunContext cleanup callback verifies directory identity before socket access or unlink", async () => {
  const child = { pid: 456, exitCode: 0, signalCode: null };
  let socketLookups = 0, unlinked = false, readdirCalls = 0;
  const replacementFs = {
    async lstat(path) {
      if (path === "/tmp/kcsm-test") return fakeDirectoryStat({ ...directoryIdentity, ino: "900" });
      socketLookups++;
      return fakeSocketStat(socketIdentity);
    },
    async readdir() { readdirCalls++; return ["c"]; },
    async unlink() { unlinked = true; },
    async rmdir() {},
  };
  await assert.rejects(cleanupOwnedControlSocketDirectory({
    directory: "/tmp/kcsm-test", directoryIdentity, child, spawnFailure: null,
    masterIdentity: {}, socketIdentity, assertMasterGone: async () => {}, fsOps: replacementFs,
  }));
  assert.equal(socketLookups, 0, "directory mismatch fails before socket-path lookup");
  assert.equal(readdirCalls, 0, "directory mismatch fails before traversing the replacement directory");
  assert.equal(unlinked, false, "directory mismatch never unlinks a socket in the replacement directory");

  let names = ["c"], removedDirectory = false;
  const ownedFs = {
    async lstat(path) { return path === "/tmp/kcsm-test" ? fakeDirectoryStat(directoryIdentity) : fakeSocketStat(socketIdentity); },
    async readdir() { return [...names]; },
    async unlink(path) { assert.equal(path, "/tmp/kcsm-test/c"); names = []; },
    async rmdir(path) { assert.equal(path, "/tmp/kcsm-test"); removedDirectory = true; },
  };
  await cleanupOwnedControlSocketDirectory({
    directory: "/tmp/kcsm-test", directoryIdentity, child, spawnFailure: null,
    masterIdentity: {}, socketIdentity, assertMasterGone: async () => {}, fsOps: ownedFs,
  });
  assert.equal(removedDirectory, true, "the verified original directory is removed after its owned socket");
});

test("failed master spawn removes only its still-empty private socket directory", async () => {
  const { EventEmitter } = await import("node:events");
  let cleanup;
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  const context = {
    isolatedEnvironment: () => ({}),
    addCleanup(_label, callback) { cleanup = callback; },
    spawnOwned() {
      setImmediate(() => {
        child.exitCode = -2;
        const error = new Error("synthetic spawn failure");
        error.code = "ENOENT";
        child.emit("error", error);
      });
      return child;
    },
  };
  await assert.rejects(startOwnedSshControlMaster(context, {
    binary: "/usr/bin/ssh", target: config.target, configPath: config.configPath,
    knownHostsPath: config.knownHostsPath, cwd: process.cwd(),
  }), /spawn failed/);
  assert.equal(typeof cleanup, "function");
  await cleanup();
});

test("owned SSH operation bounds output, checks stage markers, and keeps stderr out of its result", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const makeChild = (stdoutText, stderrText, code = 0) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    setImmediate(() => {
      child.stdout.end(stdoutText); child.stderr.end(stderrText);
      setImmediate(() => child.emit("close", code, null));
    });
    return child;
  };
  let stopped = 0;
  const context = { abortSignal: undefined, isolatedEnvironment: () => ({}), spawnOwned() {}, stopOwned: async () => { stopped++; } };
  const dispatcher = { spawn: async () => makeChild("{\"safe\":true}\n",
    "KCUX_STAGE:REMOTE_PYTHON_ENTERED\nKCUX_STAGE:REMOTE_PROGRAM_COMPLETE\n") };
  const result = await runOwnedSshOperation({ context, dispatcher, label: "test-safe-operation",
    command: "python3 -c 'print(1)' KCUX_STAGE:REMOTE_PYTHON_ENTERED", cwd: "/tmp", timeoutMs: 1000, maxStdoutBytes: 128, maxStderrBytes: 256 });
  assert.equal(result.stdout.toString("utf8"), "{\"safe\":true}\n");
  assert.equal(result.stage.valid, true);
  assert.equal(result.stderrBytes, Buffer.byteLength("KCUX_STAGE:REMOTE_PYTHON_ENTERED\nKCUX_STAGE:REMOTE_PROGRAM_COMPLETE\n"));
  assert.equal(stopped, 0);

  const overflowDispatcher = { spawn: async () => makeChild("x".repeat(32), "") };
  await assert.rejects(runOwnedSshOperation({ context, dispatcher: overflowDispatcher, label: "test-overflow",
    command: "true", cwd: "/tmp", timeoutMs: 1000, maxStdoutBytes: 8, maxStderrBytes: 256 }), /output bound/);
  assert.equal(stopped, 1, "overflow stops only this operation's owned SSH child");
});

test("remote owner guards accept the exact root/process and reject symlink, inode, uid, pid, and starttime drift", () => {
  const python = remoteOwnedProcessGuardSource() + [
    'import json,os,stat,tempfile',
    'base=tempfile.mkdtemp(prefix="owned-remote-guard-")',
    'root=os.path.join(base,"root"); os.mkdir(root,0o700); os.chmod(root,0o700)',
    'run_id="a"*24; marker_name=".owner.json"; uid=os.getuid(); rs=os.lstat(root)',
    'marker={"version":1,"runId":run_id,"uid":uid,"dev":rs.st_dev,"ino":rs.st_ino}',
    'def write_marker(value):',
    ' path=os.path.join(root,marker_name)',
    ' fd=os.open(path,os.O_CREAT|os.O_TRUNC|os.O_WRONLY|os.O_NOFOLLOW,0o600)',
    ' os.write(fd,(json.dumps(value,separators=(",",":"))+"\\n").encode()); os.close(fd); os.chmod(path,0o600)',
    'write_marker(marker); _read_owner_marker(root,run_id,marker_name,uid); print("ok exact-owner-root")',
    'receipt_path=os.path.join(root,"receipt.json"); receipt={"runId":run_id,"state":"complete"}',
    'fd=os.open(receipt_path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600); os.write(fd,json.dumps(receipt).encode()); os.close(fd); os.chmod(receipt_path,0o600)',
    'assert _read_owned_json(root,"receipt.json",uid,512)==receipt; print("ok exact-private-json")',
    'os.symlink(receipt_path,os.path.join(root,"receipt-link.json"))',
    'try: _read_owned_json(root,"receipt-link.json",uid,512); raise RuntimeError("private JSON symlink accepted")',
    'except AssertionError: print("ok private-json-symlink-rejected")',
    'bad=dict(marker); bad["ino"]=marker["ino"]+1; write_marker(bad)',
    'try: _read_owner_marker(root,run_id,marker_name,uid); raise RuntimeError("inode drift accepted")',
    'except AssertionError: print("ok changed-inode-rejected")',
    'write_marker(marker)',
    'try: _read_owner_marker(root,run_id,marker_name,uid+1); raise RuntimeError("foreign uid accepted")',
    'except AssertionError: print("ok foreign-uid-rejected")',
    'link=os.path.join(base,"root-link"); os.symlink(root,link)',
    'try: _read_owner_marker(link,run_id,marker_name,uid); raise RuntimeError("symlink root accepted")',
    'except AssertionError: print("ok symlink-root-rejected")',
    'old_root=os.path.join(base,"root-old"); os.rename(root,old_root); os.mkdir(root,0o700); os.chmod(root,0o700); write_marker(marker)',
    'assert os.lstat(root).st_ino != marker["ino"]',
    'try: _read_owner_marker(root,run_id,marker_name,uid); raise RuntimeError("replaced root inode accepted")',
    'except AssertionError: print("ok changed-root-inode-rejected")',
    'import shutil; shutil.rmtree(root); os.rename(old_root,root)',
    'os.chdir(root); actual=_read_process(os.getpid()); config_sha="b"*64',
    'receipt={"runId":run_id,"pid":actual["pid"],"startTicks":actual["startTicks"],"euid":actual["euid"],"exe":actual["exe"],"argvSha256":actual["argvSha256"],"cwd":actual["cwd"],"configSha256":config_sha}',
    'assert_owned_process(receipt,root,run_id,marker_name,uid,actual["exe"],config_sha,actual["argv"]); print("ok exact-process-owner")',
    'bad=dict(receipt); bad["pid"]=1',
    'try: assert_owned_process(bad,root,run_id,marker_name,uid,actual["exe"],config_sha,actual["argv"]); raise RuntimeError("foreign pid accepted")',
    'except AssertionError: print("ok foreign-pid-rejected")',
    'bad=dict(receipt); bad["startTicks"]=actual["startTicks"]+1',
    'try: assert_owned_process(bad,root,run_id,marker_name,uid,actual["exe"],config_sha,actual["argv"]); raise RuntimeError("starttime drift accepted")',
    'except AssertionError: print("ok changed-starttime-rejected")',
    'os.chdir("/"); import shutil; shutil.rmtree(base)',
  ].join("\n");
  const lines = execFileSync("/usr/bin/python3", ["-c", python], { encoding: "utf8", timeout: 5000 }).trim().split(/\r?\n/);
  assert.deepEqual(lines, ["ok exact-owner-root", "ok exact-private-json", "ok private-json-symlink-rejected",
    "ok changed-inode-rejected", "ok foreign-uid-rejected", "ok symlink-root-rejected", "ok changed-root-inode-rejected",
    "ok exact-process-owner", "ok foreign-pid-rejected", "ok changed-starttime-rejected"]);
});

test("remote owned-tree guard accepts normal Linux directory link counts but rejects file hardlinks", () => {
  const python = remoteOwnedProcessGuardSource() + [
    'import json,os,shutil,stat,tempfile',
    'base=tempfile.mkdtemp(prefix="owned-remote-tree-"); root=os.path.join(base,"root"); os.mkdir(root,0o700); os.chmod(root,0o700)',
    'for name in ("config","data","tmp"): os.mkdir(os.path.join(root,name),0o700)',
    'run_id="b"*24; uid=os.getuid(); rs=os.lstat(root); marker={"version":1,"runId":run_id,"uid":uid,"dev":rs.st_dev,"ino":rs.st_ino}',
    'path=os.path.join(root,".owner.json"); fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600); os.write(fd,json.dumps(marker).encode()); os.close(fd); os.chmod(path,0o600)',
    '_read_owner_marker(root,run_id,".owner.json",uid)',
    'assert os.lstat(root).st_nlink>1 and all(os.lstat(os.path.join(root,n)).st_nlink>1 for n in ("config","data","tmp"))',
    'print("ok normal-directory-link-counts")',
    'file=os.path.join(root,"Caddyfile"); fd=os.open(file,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600); os.write(fd,b"candidate"); os.close(fd); os.chmod(file,0o600)',
    'allowed={".owner.json","Caddyfile","config","data","tmp"}',
    'assert _assert_owned_tree(root,uid,allowed)=={"fileCount":2,"totalBytes":len(b"candidate")+len(open(path,"rb").read())}',
    'print("ok real-private-tree-accepted")',
    'link=os.path.join(root,"data","candidate-hardlink"); os.link(file,link)',
    'try: _assert_owned_tree(root,uid,allowed); raise RuntimeError("regular file hardlink accepted")',
    'except AssertionError: print("ok regular-file-hardlink-rejected")',
    'os.unlink(link); assert _assert_owned_tree(root,uid,allowed)["fileCount"]==2',
    'print("ok private-tree-valid-after-hardlink-removal")',
    'os.chdir("/"); shutil.rmtree(base)',
  ].join("\n");
  const lines = execFileSync("/usr/bin/python3", ["-c", python], { encoding: "utf8", timeout: 5000 }).trim().split(/\r?\n/);
  assert.deepEqual(lines, ["ok normal-directory-link-counts", "ok real-private-tree-accepted",
    "ok regular-file-hardlink-rejected", "ok private-tree-valid-after-hardlink-removal"]);
});
