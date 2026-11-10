import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants, createWriteStream, existsSync, lstatSync, realpathSync } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { enforceRetention } from "./retention.mjs";
import { secureWindowsRunState } from "./windows-state-directory.mjs";
import {
  processTreeAlive,
  processTreeIdentity,
  signalProcessTree,
  spawnWindowsSupervised,
} from "./owned-process.mjs";

export const appRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const repoRoot = resolve(appRoot, "../..");
const artifactBoundary = resolve(repoRoot, "target/e2e");
const artifactDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
const execFileAsync = promisify(execFile);

export async function runE2E(sourceUrl, metadata, body) {
  const context = await RunContext.create(sourceUrl, metadata);
  const abortController = new AbortController();
  context.abortSignal = abortController.signal;
  let result;
  let failure;
  let signalFailure;
  let rejectTermination;
  let abortPromise = Promise.resolve();
  const termination = new Promise((_, reject) => { rejectTermination = reject; });
  const onSignal = signal => {
    if (signalFailure) return;
    signalFailure = new Error(`E2E received ${signal}; cleaning owned resources before exit`);
    abortPromise = context.requestAbort(signalFailure);
    abortController.abort(signalFailure);
    rejectTermination(signalFailure);
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const bodyPromise = Promise.resolve().then(() => body(context, abortController.signal));
  try {
    result = await Promise.race([bodyPromise, termination]);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  if (signalFailure) {
    await abortPromise.catch(error => { failure ??= error; });
    const bodyAbortTimeoutMs = positiveTimeout(metadata.bodyAbortTimeoutMs, 5_000);
    const bodyStopped = await waitForBodyAbort(bodyPromise, bodyAbortTimeoutMs, error => { failure ??= error; });
    if (!bodyStopped) failure = new Error(`E2E body did not stop within ${bodyAbortTimeoutMs}ms after abort`);
  }
  try {
    failure ??= signalFailure;
    await context.finish(failure ? "failed" : "passed", result, failure);
  } catch (cleanupError) {
    failure ??= cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
  if (failure) {
    const safeFailure = new Error(context.redactText(errorMessage(failure)));
    safeFailure.name = "E2EFailure";
    throw safeFailure;
  }
  console.log(context.runRoot);
  return result;
}

export class RunContext {
  static async create(sourceUrl, metadata = {}) {
    const sourcePath = resolve(fileURLToPath(sourceUrl));
    const sourceRelative = relative(repoRoot, sourcePath);
    if (sourceRelative.startsWith(".." + sep) || !sourceRelative.startsWith(`apps${sep}kcoder-studio${sep}e2e${sep}`)) {
      throw new Error(`E2E source must be under apps/kcoder-studio/e2e: ${sourcePath}`);
    }
    const startedAt = new Date();
    const sourceRoot = artifactSourceRoot(sourcePath, startedAt);
    if (sourceRoot !== artifactBoundary && !sourceRoot.startsWith(artifactBoundary + sep)) {
      throw new Error(`artifact path escaped KCoder Studio E2E boundary: ${sourceRoot}`);
    }
    await enforceRetention(artifactBoundary);
    await mkdir(sourceRoot, { recursive: true });
    const runRoot = await createCollisionSafeRunRoot(sourceRoot, startedAt);
    const context = new RunContext(sourcePath, sourceRelative.split(sep).join("/"), runRoot, metadata);
    await context.initialize();
    return context;
  }

  constructor(sourcePath, sourceRelative, runRoot, metadata) {
    this.sourcePath = sourcePath;
    this.sourceRelative = sourceRelative;
    this.runRoot = runRoot;
    this.stateDir = resolve(runRoot, "state");
    this.logsDir = resolve(runRoot, "logs");
    this.artifactsDir = resolve(runRoot, "artifacts");
    this.metadata = metadata;
    this.cleanups = [];
    this.processes = new Map();
    this.cleanupSteps = [];
    this.ports = [];
    this.temporaryDirectories = [this.stateDir];
    this.scratchDirectories = [];
    this.workspaceFixtures = [];
    this.startedAt = new Date();
    this.finished = false;
    this.finishing = false;
    this.finishPromise = null;
    this.abortReason = null;
    this.abortSignal = null;
    this.manifestWrite = Promise.resolve();
    this.secrets = new Set();
  }

  async initialize() {
    await Promise.all([
      mkdir(this.stateDir, { recursive: true, mode: 0o700 }),
      mkdir(this.logsDir, { recursive: true }),
      mkdir(this.artifactsDir, { recursive: true }),
    ]);
    if (process.platform === 'win32') {
      const receipt = await secureWindowsRunState(this.stateDir, this.runRoot);
      await this.writeArtifactJson('windows-state-owner.json', receipt);
    }
    this.gitCommit = await gitCommit();
    this.seed = randomBytes(8).toString("hex");
    await this.writeManifest("running");
  }

  pathInState(...parts) {
    this.assertActive();
    return checkedChild(this.stateDir, ...parts);
  }

  async createOwnedScratchDirectory(label, {
    baseDirectory,
    requiredBytes = 0n,
    reserveBytes = 0n,
    requiredMemoryBytes,
    expectedFilesystemType,
    availableMemoryBytes,
    requireCleanupConfirmation = false,
    ownedWorkerTraversal = false,
  } = {}) {
    this.assertActive();
    if (typeof requireCleanupConfirmation !== "boolean") throw new Error("invalid scratch cleanup confirmation policy");
    if (typeof ownedWorkerTraversal !== "boolean") throw new Error("invalid owned worker traversal policy");
    if (typeof process.getuid !== "function") {
      throw new Error("UNMET_PREREQUISITE: owned scratch requires POSIX uid ownership checks");
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(label)) {
      throw new Error("invalid owned scratch directory label");
    }
    if (typeof baseDirectory !== "string" || !isAbsolute(baseDirectory)) {
      throw new Error("owned scratch base directory must be an absolute path");
    }
    const required = nonNegativeByteCount(requiredBytes, "scratch required bytes");
    const reserve = nonNegativeByteCount(reserveBytes, "scratch reserved bytes");
    const memoryRequired = requiredMemoryBytes === undefined
      ? required + reserve
      : nonNegativeByteCount(requiredMemoryBytes, "scratch required memory bytes");
    const memoryAvailable = availableMemoryBytes === undefined
      ? null
      : nonNegativeByteCount(availableMemoryBytes, "scratch available memory bytes");
    const basePath = resolve(baseDirectory);
    const baseIdentity = await inspectScratchBase(basePath);
    const stat = await statfs(basePath, { bigint: true });
    const filesystemAvailable = stat.bavail * stat.bsize;
    const filesystemType = formatFilesystemType(stat.type);
    if (expectedFilesystemType !== undefined && filesystemType !== formatFilesystemType(expectedFilesystemType)) {
      throw new Error("owned scratch filesystem type changed during capacity preflight");
    }
    const capacityRequired = required + reserve;
    if (filesystemAvailable < capacityRequired) {
      throw scratchCapacityError("filesystem", filesystemAvailable, capacityRequired);
    }
    if (memoryAvailable !== null && memoryAvailable < memoryRequired) {
      throw scratchCapacityError("memory", memoryAvailable, memoryRequired);
    }
    await access(basePath, fsConstants.W_OK);
    await assertScratchBaseIdentity(baseIdentity);

    const scratchPath = await mkdtemp(join(basePath, `.kcoder-e2e-${label}-${process.pid}-`));
    const uid = currentUid();
    const initialIdentity = await inspectCreatedScratch(scratchPath, baseIdentity, uid);
    const record = {
      label,
      path: scratchPath,
      basePath: baseIdentity.path,
      baseRealPath: baseIdentity.realPath,
      baseDev: baseIdentity.dev,
      baseIno: baseIdentity.ino,
      baseUid: baseIdentity.uid,
      baseMode: baseIdentity.mode,
      realPath: initialIdentity.realPath,
      dev: initialIdentity.dev,
      ino: initialIdentity.ino,
      uid,
      mode: ownedWorkerTraversal ? "0711" : "0700",
      requiredBytes: required.toString(),
      reserveBytes: reserve.toString(),
      requiredMemoryBytes: memoryRequired.toString(),
      filesystemType,
      filesystemAvailableBytes: filesystemAvailable.toString(),
      memoryAvailableBytes: memoryAvailable?.toString() ?? null,
      createdAt: new Date().toISOString(),
      cleanedAt: null,
      cleanupStatus: "allocated",
      requireCleanupConfirmation,
      cleanupConfirmed: !requireCleanupConfirmation,
    };
    this.scratchDirectories.push(record);
    this.addCleanup(`remove owned scratch ${label}`, () => this.removeOwnedScratchDirectory(record));
    try {
      await chmod(scratchPath, ownedWorkerTraversal ? 0o711 : 0o700);
      await assertOwnedScratchIdentity(record);
    } catch (error) {
      record.cleanupStatus = "allocation-verification-failed";
      throw error;
    }
    await this.writeManifest("running");
    return record;
  }

  pathInScratch(scratch, ...parts) {
    this.assertActive();
    if (!this.scratchDirectories.includes(scratch)) {
      throw new Error("owned scratch directory does not belong to this RunContext");
    }
    assertOwnedScratchIdentitySync(scratch);
    return checkedChild(scratch.path, ...parts);
  }

  async removeOwnedScratchDirectory(scratch) {
    if (!this.scratchDirectories.includes(scratch)) {
      throw new Error("owned scratch directory does not belong to this RunContext");
    }
    if (scratch.cleanupStatus === "removed" || scratch.cleanupStatus === "already-absent") return;
    if (scratch.requireCleanupConfirmation && !scratch.cleanupConfirmed) {
      scratch.cleanupStatus = "retained-unconfirmed";
      await this.writeManifest(this.finishing ? "cleaning" : "running");
      throw new Error("owned scratch retained until original external cleanup is confirmed");
    }
    try {
      await assertScratchBaseIdentity({
        path: scratch.basePath,
        realPath: scratch.baseRealPath,
        dev: scratch.baseDev,
        ino: scratch.baseIno,
        uid: scratch.baseUid,
        mode: scratch.baseMode,
      });
    } catch {
      scratch.cleanupStatus = "identity-mismatch";
      throw new Error("owned scratch base identity changed; refusing cleanup");
    }
    try {
      await assertOwnedScratchIdentity(scratch);
    } catch (error) {
      if (error?.code === "ENOENT") {
        scratch.cleanupStatus = "already-absent";
        scratch.cleanedAt = new Date().toISOString();
        return;
      }
      scratch.cleanupStatus = "identity-mismatch";
      throw error;
    }
    await rm(scratch.path, { recursive: true, force: false });
    try {
      await lstat(scratch.path);
      scratch.cleanupStatus = "replacement-remains";
      throw new Error("owned scratch path was replaced during cleanup; refusing further cleanup");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    scratch.cleanupStatus = "removed";
    scratch.cleanedAt = new Date().toISOString();
    await this.writeManifest(this.finishing ? "cleaning" : "running");
  }

  async confirmOwnedScratchCleanup(scratch) {
    if (this.finished || !this.scratchDirectories.includes(scratch)) throw new Error("scratch cleanup confirmation has no active owner");
    await assertOwnedScratchIdentity(scratch);
    scratch.cleanupConfirmed = true;
    await this.writeManifest(this.finishing ? "cleaning" : "running");
  }

  async resumeOwnedScratchDirectory(snapshot) {
    this.assertActive();
    if (snapshot.requireCleanupConfirmation !== true || dirname(snapshot.path) !== snapshot.basePath ||
        !basename(snapshot.path).startsWith(".kcoder-e2e-")) throw new Error("invalid original scratch recovery proof");
    await assertOwnedScratchIdentity(snapshot);
    const scratch = { ...snapshot, cleanupStatus: "resumed", cleanupConfirmed: false };
    this.scratchDirectories.push(scratch);
    this.addCleanup(`remove resumed owned scratch ${scratch.label}`, () => this.removeOwnedScratchDirectory(scratch));
    await this.writeManifest("running");
    return scratch;
  }

  pathInArtifacts(...parts) {
    this.assertActive();
    return checkedChild(this.artifactsDir, ...parts);
  }

  pathInCase(project, testSlug, ...parts) {
    this.assertActive();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(project)) throw new Error(`invalid E2E project slug: ${project}`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(testSlug)) throw new Error(`invalid E2E test slug: ${testSlug}`);
    return checkedChild(this.runRoot, "cases", project, testSlug, ...parts);
  }

  registerPort(label, port) {
    this.assertActive();
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid port for ${label}: ${port}`);
    this.ports.push({ label, port });
    void this.writeManifest("running");
  }

  registerTemporaryDirectory(label, path) {
    this.assertActive();
    const normalized = resolve(path);
    if (normalized !== this.runRoot && !normalized.startsWith(this.runRoot + sep)) {
      throw new Error(`temporary directory must be inside the run root: ${normalized}`);
    }
    this.temporaryDirectories.push(normalized);
    void this.writeManifest("running");
  }

  registerSecret(value) {
    this.assertActive();
    if (typeof value !== "string" || value.length < 8) throw new Error("registered E2E secrets must contain at least 8 characters");
    this.secrets.add(value);
  }

  registerWorkspaceFixture(fixture) {
    this.assertActive();
    const path = resolve(fixture.path);
    if (path !== this.runRoot && !path.startsWith(this.runRoot + sep)) throw new Error(`工作区 fixture 路径必须位于运行根目录内：${path}`);
    this.workspaceFixtures.push({
      id: fixture.id,
      version: fixture.version,
      materializer: fixture.materializer,
      sourceDigest: fixture.sourceDigest,
      path: relative(this.runRoot, path),
      gitHead: fixture.gitHead || null,
    });
    void this.writeManifest("running");
  }

  redactText(value) {
    return redactString(String(value), this.secrets);
  }

  redactValue(value) {
    return redact(value, "", this.secrets);
  }

  // Generic owned JSON storage. Native Windows profile settings must use
  // writeWindowsProfileSettings; POSIX mode is not a protected Windows DACL.
  async writeStateJson(name, value, mode = 0o600) {
    this.assertActive();
    const path = this.pathInState(name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    checkedChild(this.stateDir, relative(this.stateDir, path));
    const file = await open(path, "wx", mode);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    return path;
  }

  async writeArtifactJson(name, value) {
    this.assertActive();
    if (name === "result.json") throw new Error("result.json is reserved for RunContext.finish");
    return this.writeArtifactJsonInternal(name, value);
  }

  async writeArtifactJsonInternal(name, value) {
    const path = checkedChild(this.artifactsDir, name);
    await mkdir(dirname(path), { recursive: true });
    checkedChild(this.artifactsDir, relative(this.artifactsDir, path));
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(this.redactValue(value), null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    return path;
  }

  addCleanup(label, callback) {
    this.assertActive();
    this.cleanups.push({ label, callback });
  }

  spawnOwned(label, command, args, options = {}) {
    this.assertActive();
    return this.#spawnTrackedOwned(label, command, args, options, false);
  }

  spawnCleanupOwned(label, command, args, options = {}) {
    if (!this.finishing || this.finished) throw new Error("cleanup processes require an active finish transaction");
    return this.#spawnTrackedOwned(label, command, args, options, true);
  }

  #spawnTrackedOwned(label, command, args, options, cleanupOnly) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(label)) {
      throw new Error(`invalid owned process label: ${label}`);
    }
    if (this.processes.has(label)) throw new Error(`owned process label already registered: ${label}`);
    const logPath = resolve(this.logsDir, `${safeSlug(label)}.log`);
    const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
    const stdoutRedactor = createRedactingStream(value => this.redactText(value), () => this.secrets);
    const stderrRedactor = createRedactingStream(value => this.redactText(value), () => this.secrets);
    const spawnOptions = {
      ...options,
      env: options.env || isolatedEnvironment({}, [], {
        HOME: checkedChild(this.stateDir, "home"), USERPROFILE: checkedChild(this.stateDir, "home"),
      }),
      detached: process.platform !== "win32",
      stdio: [options.stdin || "ignore", "pipe", "pipe"],
    };
    const supervised = process.platform === "win32"
      ? spawnWindowsSupervised(
        command,
        args,
        spawnOptions,
        checkedChild(this.stateDir, "process-supervisors", safeSlug(label)),
      )
      : null;
    const child = supervised?.child || spawn(command, args, spawnOptions);
    child.stdout?.pipe(stdoutRedactor).pipe(log, { end: false });
    child.stderr?.pipe(stderrRedactor).pipe(log, { end: false });
    const identity = supervised?.identity || processTreeIdentity(child);
    const record = {
      label,
      child,
      log,
      logPath,
      pid: identity.pid,
      pgid: identity.pgid,
      identity,
      command: basename(command),
      stopped: false,
      stopPromise: null,
      spawnError: null,
      cleanupOnly,
      redactors: [stdoutRedactor, stderrRedactor],
    };
    child.once("error", error => { record.spawnError = errorMessage(error); });
    this.processes.set(label, record);
    if (!cleanupOnly) this.addCleanup(`stop process ${label}`, () => this.stopOwned(label));
    void this.writeManifest(cleanupOnly ? "cleaning" : "running");
    return child;
  }

  async stopOwned(label) {
    const record = this.processes.get(label);
    if (!record || record.stopped) return;
    if (record.stopPromise) return record.stopPromise;
    record.stopPromise = (async () => {
      const { child, identity } = record;
      const signalTimeoutMs = positiveTimeout(this.metadata.processSignalTimeoutMs, 5_000);
      const streamTimeoutMs = positiveTimeout(this.metadata.streamCloseTimeoutMs, 5_000);
      const failures = [];
      if (!record.spawnError && child.pid) {
        const alive = await bounded(processTreeAlive(child, identity), signalTimeoutMs, `检查进程树 ${label}`)
          .catch(error => { failures.push(error); return true; });
        if (alive) {
          await bounded(signalProcessTree(child, identity, "SIGTERM"), signalTimeoutMs, `向进程树 ${label} 发送 SIGTERM`)
            .catch(error => failures.push(error));
          await waitFor(async () => !(await bounded(processTreeAlive(child, identity), signalTimeoutMs, `检查进程树 ${label}`)), 5_000)
            .catch(() => undefined);
        }
        const survivedTerm = await bounded(processTreeAlive(child, identity), signalTimeoutMs, `检查进程树 ${label}`)
          .catch(error => { failures.push(error); return true; });
        if (survivedTerm) {
          await bounded(signalProcessTree(child, identity, "SIGKILL"), signalTimeoutMs, `向进程树 ${label} 发送 SIGKILL`)
            .catch(error => failures.push(error));
          await waitFor(
            async () => !(await bounded(processTreeAlive(child, identity), signalTimeoutMs, `检查进程树 ${label}`)),
            2_000,
            `进程树 ${label} 退出`,
          ).catch(error => failures.push(error));
        }
      }
      await Promise.all(record.redactors.map(stream => bounded(waitForStream(stream), streamTimeoutMs, `等待 ${label} 脱敏日志流结束`)))
        .catch(error => failures.push(error));
      await bounded(new Promise(resolveClose => record.log.end(resolveClose)), streamTimeoutMs, `关闭 ${label} 日志文件`)
        .catch(error => failures.push(error));
      record.stopped = true;
      if (failures.length) throw new AggregateError(failures, `停止 owned process ${label} 失败`);
    })();
    return record.stopPromise;
  }

  async finish(status, result, failure) {
    if (this.finished) return;
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = this.finishInternal(status, result, failure).catch(error => {
      if (!this.finished) this.finishPromise = null;
      throw error;
    });
    return this.finishPromise;
  }

  async finishInternal(status, result, failure) {
    this.finishing = true;
    const cleanupErrors = [];
    const finalizationErrors = [];
    const cleanupTimeoutMs = positiveTimeout(this.metadata.cleanupTimeoutMs, 10_000);
    const survivorTimeoutMs = positiveTimeout(this.metadata.survivorCheckTimeoutMs, 5_000);
    await this.writeManifest("cleaning", failure).catch(error => finalizationErrors.push(error));
    for (const cleanup of [...this.cleanups].reverse()) {
      try {
        await bounded(Promise.resolve().then(() => cleanup.callback()), cleanupTimeoutMs, `cleanup ${cleanup.label}`);
        this.cleanupSteps.push({ label: cleanup.label, status: "completed" });
      } catch (error) {
        cleanupErrors.push(error);
        this.cleanupSteps.push({ label: cleanup.label, status: "failed", error: errorMessage(error) });
      }
    }
    for (const record of this.processes.values()) {
      if (!record.cleanupOnly) continue;
      try { await this.stopOwned(record.label); }
      catch (error) { cleanupErrors.push(error); }
    }
    const aliveStates = await Promise.all([...this.processes.values()].map(async record => {
      try {
        return {
          record,
          alive: await bounded(processTreeAlive(record.child, record.identity), survivorTimeoutMs, `检查 survivor ${record.label}`),
        };
      } catch (error) {
        cleanupErrors.push(error);
        return { record, alive: true };
      }
    }));
    const survivors = aliveStates.filter(item => item.alive).map(item => item.record);
    if (survivors.length) cleanupErrors.push(new Error(`owned process groups survived cleanup: ${survivors.map(item => item.label).join(", ")}`));
    // Unknown cleanup outcomes may still have an owner writing this state.
    if (cleanupErrors.length === 0 && survivors.length === 0) {
      await rm(this.stateDir, {
        recursive: true, force: true,
        ...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 100 } : {}),
      }).catch(error => finalizationErrors.push(error));
    }
    if (status === "passed" && !failure && cleanupErrors.length === 0 && finalizationErrors.length === 0 && !this.metadata.retainSuccessLogs) {
      await rm(this.logsDir, { recursive: true, force: true }).catch(error => finalizationErrors.push(error));
    }
    await enforceRetention(artifactBoundary).catch(error => finalizationErrors.push(error));
    let effectiveFailure = failure || cleanupErrors[0] || finalizationErrors[0];
    let effectiveStatus = effectiveFailure ? "failed" : status;
    await this.writeArtifactJsonInternal("result.json", {
      status: effectiveStatus,
      testId: this.metadata.testId,
      durationMs: Date.now() - this.startedAt.getTime(),
      result: result ?? null,
      error: effectiveFailure ? errorMessage(effectiveFailure) : null,
      cleanupErrors: [...cleanupErrors, ...finalizationErrors].map(errorMessage),
    }).catch(error => finalizationErrors.push(error));
    effectiveFailure = failure || cleanupErrors[0] || finalizationErrors[0];
    effectiveStatus = effectiveFailure ? "failed" : status;
    try {
      await this.writeManifest(effectiveStatus, effectiveFailure);
      this.finished = true;
    } finally {
      this.finishing = false;
    }
    if (effectiveFailure) throw effectiveFailure;
  }

  requestAbort(reason) {
    this.abortReason ??= reason instanceof Error ? reason : new Error(String(reason));
    return Promise.allSettled([...this.processes.keys()].map(label => this.stopOwned(label))).then(results => {
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
  }

  assertActive() {
    if (this.finished || this.finishing || this.abortReason) {
      throw new Error(this.abortReason ? `E2E run is aborting: ${errorMessage(this.abortReason)}` : "E2E run is finishing or already finished");
    }
  }

  isolatedEnvironment(overrides = {}, passNames = []) {
    return isolatedEnvironment(overrides, passNames, {
      HOME: this.pathInState("home"),
      USERPROFILE: this.pathInState("home"),
    });
  }

  writeManifest(status, failure) {
    const write = this.manifestWrite.then(() => this.writeManifestFile(status, failure));
    this.manifestWrite = write.catch(() => undefined);
    return write;
  }

  async writeManifestFile(status, failure) {
    const manifest = {
      schemaVersion: 1,
      source: this.sourceRelative,
      testId: this.metadata.testId || basename(this.sourcePath),
      tier: this.metadata.tier || "full-integration",
      modelPolicy: this.metadata.modelPolicy || "model-independent",
      gitCommit: this.gitCommit || null,
      seed: this.seed || null,
      startedAt: this.startedAt.toISOString(),
      endedAt: status === "running" ? null : new Date().toISOString(),
      status,
      ports: this.ports,
      temporaryDirectories: this.temporaryDirectories.map(path => relative(this.runRoot, path) || "."),
      scratchDirectories: this.scratchDirectories.map(scratch => ({ ...scratch })),
      workspaceFixtures: this.workspaceFixtures,
      processes: [...this.processes.values()].map(record => ({
        label: record.label,
        pid: record.pid,
        pgid: record.pgid,
        command: record.command,
        stopped: record.stopped,
        spawnError: record.spawnError,
        cleanupOnly: record.cleanupOnly,
      })),
      cleanupSteps: this.cleanupSteps,
      error: failure ? errorMessage(failure) : null,
    };
    const target = resolve(this.runRoot, "manifest.json");
    const temporary = resolve(this.runRoot, `.manifest-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(this.redactValue(manifest), null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export async function waitFor(predicate, timeoutMs, label, intervalMs = 50, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason || new Error(`Aborted while waiting for ${label}`);
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      throw new Error(`Failed while waiting for ${label}: ${errorMessage(error)}`, { cause: error });
    }
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function requireExecutable(path, capability) {
  try {
    await access(path);
  } catch {
    throw new Error(`UNMET_PREREQUISITE: ${capability} executable not found at ${path}`);
  }
  return path;
}

function checkedChild(root, ...parts) {
  const path = resolve(root, ...parts);
  if (path !== root && !path.startsWith(root + sep)) throw new Error(`path escaped run directory: ${path}`);
  try {
    if (lstatSync(root).isSymbolicLink()) throw new Error(`path root is a symbolic link: ${root}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let cursor = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`path contains a symbolic link: ${cursor}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      break;
    }
  }
  return path;
}

const BASE_ENV_NAMES = [
  "PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
  "CI", "TERM", "COLORTERM", "NO_COLOR", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
  "USER", "USERNAME",
  "LANG", "LC_ALL", "LC_CTYPE",
];

export function isolatedEnvironment(overrides = {}, passNames = [], defaults = {}) {
  const env = {};
  for (const name of [...BASE_ENV_NAMES, ...passNames]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries({ ...defaults, ...overrides })) {
    if (value !== undefined && value !== "") env[name] = String(value);
  }
  return env;
}

async function createCollisionSafeRunRoot(sourceRoot, startedAt) {
  const timestamp = portableTimestamp(startedAt);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-p${process.pid}-${attempt}-${randomBytes(2).toString("hex")}`;
    const candidate = resolve(sourceRoot, `${timestamp}${suffix}`);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`unable to create collision-safe run root under ${sourceRoot}`);
}

function nonNegativeByteCount(value, label) {
  let parsed;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^\d+$/.test(value)) parsed = BigInt(value);
  else throw new Error(`${label} must be a non-negative integer byte count`);
  if (parsed < 0n) throw new Error(`${label} must be a non-negative integer byte count`);
  return parsed;
}

function currentUid() {
  return typeof process.getuid === "function" ? String(process.getuid()) : null;
}

async function inspectScratchBase(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("owned scratch base must be a real directory");
  }
  const realPath = await realpath(path);
  if (realPath !== path) throw new Error("owned scratch base realpath does not match its selected path");
  const mode = Number(info.mode & 0o7777n);
  if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
    throw new Error("owned scratch base is writable by other users without a sticky bit");
  }
  return {
    path,
    realPath,
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    uid: info.uid.toString(),
    mode: mode.toString(8).padStart(4, "0"),
  };
}

async function assertScratchBaseIdentity(expected) {
  const info = await lstat(expected.path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("owned scratch base identity changed");
  }
  const realPath = await realpath(expected.path);
  const mode = Number(info.mode & 0o7777n).toString(8).padStart(4, "0");
  if (realPath !== expected.realPath || info.dev.toString() !== expected.dev ||
      info.ino.toString() !== expected.ino || info.uid.toString() !== expected.uid ||
      (expected.mode !== undefined && mode !== expected.mode)) {
    throw new Error("owned scratch base identity changed");
  }
}

function scratchCapacityError(kind, available, required) {
  const error = new Error(
    `owned scratch ${kind} capacity is insufficient (${available} available bytes; ${required} required including reserve)`,
  );
  error.code = "KCODER_E2E_SCRATCH_CAPACITY";
  return error;
}

function formatFilesystemType(type) {
  const value = typeof type === "bigint" ? type : BigInt(type);
  return `0x${value.toString(16)}`;
}

async function inspectCreatedScratch(path, base, uid) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || dirname(path) !== base.path) {
    throw new Error("new owned scratch directory is not a real direct child of its selected base");
  }
  const realPath = await realpath(path);
  if (realPath !== path || info.dev.toString() !== base.dev ||
      (uid !== null && info.uid.toString() !== uid)) {
    throw new Error("new owned scratch directory failed identity verification");
  }
  return {
    realPath,
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    mode: Number(info.mode & 0o7777n).toString(8).padStart(4, "0"),
  };
}

async function assertOwnedScratchIdentity(expected) {
  const base = {
    path: expected.basePath,
    realPath: expected.baseRealPath,
    dev: expected.baseDev,
    ino: expected.baseIno,
    uid: expected.baseUid,
    mode: expected.baseMode,
  };
  await assertScratchBaseIdentity(base);
  const info = await lstat(expected.path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("owned scratch directory identity changed");
  }
  const realPath = await realpath(expected.path);
  const uid = currentUid();
  if (realPath !== expected.realPath || info.dev.toString() !== expected.dev ||
      info.ino.toString() !== expected.ino || (uid !== null && info.uid.toString() !== uid) ||
      (info.mode & 0o7777n) !== BigInt("0o" + expected.mode) || !["0700", "0711"].includes(expected.mode)) {
    throw new Error("owned scratch directory identity changed");
  }
}

function assertOwnedScratchIdentitySync(expected) {
  const baseInfo = lstatSync(expected.basePath, { bigint: true });
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) {
    throw new Error("owned scratch base identity changed");
  }
  const baseMode = Number(baseInfo.mode & 0o7777n).toString(8).padStart(4, "0");
  if (realpathSync(expected.basePath) !== expected.baseRealPath ||
      baseInfo.dev.toString() !== expected.baseDev || baseInfo.ino.toString() !== expected.baseIno ||
      baseInfo.uid.toString() !== expected.baseUid || baseMode !== expected.baseMode) {
    throw new Error("owned scratch base identity changed");
  }
  const info = lstatSync(expected.path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("owned scratch directory identity changed");
  }
  const uid = currentUid();
  if (realpathSync(expected.path) !== expected.realPath || info.dev.toString() !== expected.dev ||
      info.ino.toString() !== expected.ino || (uid !== null && info.uid.toString() !== uid) ||
      (info.mode & 0o7777n) !== BigInt("0o" + expected.mode) || !["0700", "0711"].includes(expected.mode)) {
    throw new Error("owned scratch directory identity changed");
  }
}

function portableTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-");
}

function safeSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "process";
}

const PUBLIC_TOKEN_COUNTS = new Set([
  "contextwindowtokens", "outputheadroomtokens", "maxoutputtokens", "maxtokens", "summarymaxtokens",
  "inputtokens", "outputtokens", "totaltokens", "cachedinputtokens", "cachecreationinputtokens", "cachereadinputtokens",
  "cachereadtokens", "cachecreationtokens",
]);

export function redact(value, key = "", secrets = []) {
  // Public numeric limits and usage are not authentication tokens. Keep their
  // types intact so retained model snapshots remain replayable; a registered
  // secret or a non-numeric value never receives this exception.
  if (PUBLIC_TOKEN_COUNTS.has(key.replace(/[_-]/g, "").toLowerCase())
      && Number.isSafeInteger(value) && value >= 0
      && ![...secrets].includes(String(value))) return value;
  if (/token|secret|credential|cookie|password|api.?key|private.?key/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map(item => redact(item, "", secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey, secrets)]));
  }
  return value;
}

function redactString(value, secrets = []) {
  let redacted = value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/((?:["']?(?:token|secret|credential|cookie|password|api[_-]?key|private[_-]?key)["']?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|secret|credential|password|api[_-]?key)=)[^&#\s]*/gi, "$1[REDACTED]");
  for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
}

export function createRedactingStream(redactor, registeredSecrets = []) {
  let buffered = Buffer.alloc(0);
  const decoder = new StringDecoder("utf8");
  const currentSecrets = () => {
    const values = typeof registeredSecrets === "function" ? registeredSecrets() : registeredSecrets;
    return [...values]
      .filter(secret => typeof secret === "string" && secret.length > 0)
      .map(secret => Buffer.from(secret, "utf8"))
      .sort((left, right) => right.length - left.length);
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, _encoding);
        buffered = buffered.length === 0 ? Buffer.from(bytes) : Buffer.concat([buffered, bytes]);
        const secrets = currentSecrets();
        const longest = secrets[0]?.length || 0;
        let boundary = Math.max(0, buffered.length - Math.max(0, longest - 1));
        boundary = moveBeforeCrossingSecret(buffered, boundary, secrets);
        if (boundary > 0) {
          const safe = buffered.subarray(0, boundary);
          buffered = buffered.subarray(boundary);
          const text = decoder.write(safe);
          if (text) this.push(redactor(text));
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        const text = decoder.end(buffered);
        if (text) this.push(redactor(text));
        buffered = Buffer.alloc(0);
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

function moveBeforeCrossingSecret(buffer, initialBoundary, secrets) {
  let boundary = initialBoundary;
  for (;;) {
    const previous = boundary;
    for (const secret of secrets) {
      let offset = Math.max(0, boundary - Math.max(0, secret.length - 1));
      while (offset < boundary) {
        const start = buffer.indexOf(secret, offset);
        if (start < 0 || start >= boundary) break;
        if (start + secret.length > boundary) {
          boundary = Math.min(boundary, start);
          break;
        }
        offset = start + 1;
      }
    }
    if (boundary === previous) return boundary;
  }
}

function waitForStream(stream) {
  if (stream.readableEnded) return Promise.resolve();
  return new Promise((resolveEnd, reject) => {
    stream.once("end", resolveEnd);
    stream.once("error", reject);
  });
}

function bounded(promise, timeoutMs, label) {
  return new Promise((resolveBounded, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs}ms`)), timeoutMs);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolveBounded(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

async function gitCommit() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", timeout: 5_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export function e2eDayRoot(date = new Date()) {
  const parts = Object.fromEntries(artifactDate.formatToParts(date).map(({ type, value }) => [type, value]));
  return resolve(artifactBoundary, parts.year, parts.month, parts.day);
}

export function artifactSourceRoot(sourcePath, date = new Date()) {
  const sourceRelative = relative(appRoot, resolve(sourcePath));
  if (!sourceRelative.startsWith(`e2e${sep}`)) throw new Error("source path escaped Studio E2E");
  return resolve(e2eDayRoot(date), sourceRelative.slice(4));
}

export function retainedE2EArtifactBoundary(candidate, workspaceRoot = repoRoot) {
  const datedRoot = resolve(workspaceRoot, "target/e2e");
  const relativePath = relative(datedRoot, candidate).split(sep).join("/");
  if (/^\d{4}\/\d{2}\/\d{2}\/[^/]+\//.test(relativePath)) return datedRoot;
  const archiveRoot = resolve(workspaceRoot, "target/evidence");
  const archivePath = relative(archiveRoot, candidate).split(sep).join("/");
  if (/^\d{4}\/\d{2}\/\d{2}\/studio-e2e\//.test(archivePath)) {
    return resolve(archiveRoot, ...archivePath.split("/").slice(0, 4));
  }
  return resolve(workspaceRoot, "target/test/apps/kcoder-studio/e2e");
}

export function retainedArtifactRunRoot(sourcePath, runId) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.(\d{3})Z(?:-p\d+-\d+-[a-f0-9]{4})?$/.exec(runId);
  if (!match) throw new Error("invalid retained E2E run ID");
  const [, year, month, day, hour, minute, second, ms] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`);
  if (!Number.isFinite(date.getTime()) || portableTimestamp(date) !== runId.slice(0, 20)) {
    throw new Error("invalid retained E2E run date");
  }
  const current = resolve(artifactSourceRoot(sourcePath, date), runId);
  if (existsSync(current)) return current;
  const legacy = resolve(repoRoot, "target/test", relative(repoRoot, resolve(sourcePath)), runId);
  if (existsSync(legacy)) return legacy;
  const archived = resolve(repoRoot, "target/evidence", relative(artifactBoundary, e2eDayRoot(date)),
    "studio-e2e", relative(e2eDayRoot(date), current));
  return existsSync(archived) ? archived : current;
}

export { portableTimestamp };

function positiveTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function waitForBodyAbort(bodyPromise, timeoutMs, onFailure) {
  return new Promise(resolveWait => {
    const timer = setTimeout(() => resolveWait(false), timeoutMs);
    bodyPromise.then(
      () => { clearTimeout(timer); resolveWait(true); },
      error => { clearTimeout(timer); onFailure(error); resolveWait(true); },
    );
  });
}
