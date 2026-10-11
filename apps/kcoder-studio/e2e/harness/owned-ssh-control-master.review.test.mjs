import assert from "node:assert/strict";
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
