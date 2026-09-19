import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, lstatSync } from "node:fs";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { enforceRetention } from "./retention.mjs";
import {
  processTreeAlive,
  processTreeIdentity,
  signalProcessTree,
  spawnWindowsSupervised,
} from "./owned-process.mjs";

export const appRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const repoRoot = resolve(appRoot, "../..");
const artifactBoundary = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e");
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
    const sourceRoot = resolve(repoRoot, "target/test", sourceRelative);
    if (sourceRoot !== artifactBoundary && !sourceRoot.startsWith(artifactBoundary + sep)) {
      throw new Error(`artifact path escaped KCoder Studio E2E boundary: ${sourceRoot}`);
    }
    await enforceRetention(artifactBoundary);
    await mkdir(sourceRoot, { recursive: true });
    const runRoot = await createCollisionSafeRunRoot(sourceRoot);
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
    this.gitCommit = await gitCommit();
    this.seed = randomBytes(8).toString("hex");
    await this.writeManifest("running");
  }

  pathInState(...parts) {
    this.assertActive();
    return checkedChild(this.stateDir, ...parts);
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
      env: options.env || this.isolatedEnvironment(),
      detached: process.platform !== "win32",
      stdio: [options.stdin || "ignore", "pipe", "pipe"],
    };
    const supervised = process.platform === "win32"
      ? spawnWindowsSupervised(
        command,
        args,
        spawnOptions,
        this.pathInState("process-supervisors", safeSlug(label)),
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
      redactors: [stdoutRedactor, stderrRedactor],
    };
    child.once("error", error => { record.spawnError = errorMessage(error); });
    this.processes.set(label, record);
    this.addCleanup(`stop process ${label}`, () => this.stopOwned(label));
    void this.writeManifest("running");
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
    await rm(this.stateDir, { recursive: true, force: true }).catch(error => finalizationErrors.push(error));
    if (status === "passed" && !failure && cleanupErrors.length === 0 && !this.metadata.retainSuccessLogs) {
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
      workspaceFixtures: this.workspaceFixtures,
      processes: [...this.processes.values()].map(record => ({
        label: record.label,
        pid: record.pid,
        pgid: record.pgid,
        command: record.command,
        stopped: record.stopped,
        spawnError: record.spawnError,
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

async function createCollisionSafeRunRoot(sourceRoot) {
  const timestamp = portableTimestamp(new Date());
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

function portableTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-");
}

function safeSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "process";
}

export function redact(value, key = "", secrets = []) {
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

export function artifactSourceRoot(sourcePath) {
  const normalized = resolve(sourcePath);
  const sourceRelative = relative(repoRoot, normalized);
  if (sourceRelative.startsWith(".." + sep)) throw new Error("source path escaped repository");
  return resolve(repoRoot, "target/test", sourceRelative);
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
