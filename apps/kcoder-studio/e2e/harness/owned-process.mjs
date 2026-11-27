import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export function supervisedChildEnvironment(env = {}, helperPid, ownerPid = process.pid) {
  const values = Object.fromEntries(Object.entries(env).map(([name, value]) => [name, String(value)]));
  if (values.KCODER_E2E_BROKER_OWNERSHIP_OBSERVER === '1'
      && values.KCODER_E2E_BROKER_OWNERSHIP_OBSERVER_OWNER_PID === String(ownerPid)
      && Number.isSafeInteger(helperPid) && helperPid > 0) {
    // The verified helper is the target's direct parent; descendants do not inherit that edge.
    values.KCODER_E2E_BROKER_OWNERSHIP_OBSERVER_OWNER_PID = String(helperPid);
  }
  return values;
}

export function spawnWindowsSupervised(command, args, options, statusRoot) {
  if (process.platform !== "win32") throw new Error("Windows supervisor只能在Windows上启动");
  const helper = process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN;
  if (!helper || !isAbsolute(helper)) {
    throw new Error("KCODER_E2E_PROCESS_SUPERVISOR_BIN必须明确指向绝对helper路径");
  }
  accessSync(helper, constants.X_OK);
  if (!isAbsolute(command)) throw new Error("Windows supervised executable必须是绝对路径");
  const cwd = resolve(options.cwd || process.cwd());
  const nonce = randomBytes(24).toString("hex");
  mkdirSync(statusRoot, { recursive: true, mode: 0o700 });
  const statusFile = resolve(statusRoot, `${nonce}.jsonl`);
  const outputStdio = Array.isArray(options.stdio)
    ? [options.stdio[1] || "pipe", options.stdio[2] || "pipe"]
    : options.stdio === "inherit" ? ["inherit", "inherit"] : ["pipe", "pipe"];
  const child = spawn(helper, [], {
    cwd,
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
    },
    windowsHide: true,
    stdio: ["pipe", ...outputStdio],
  });
  const identity = {
    pid: child.pid || null,
    pgid: null,
    nonce,
    statusFile,
    targetPid: null,
    readyPromise: null,
  };
  identity.closed = false;
  identity.closedPromise = new Promise(resolveClose => child.once('close', (code, signal) => {
    identity.closed = true; resolveClose({ code, signal });
  }));
  let startupFailure;
  const failed = error => { startupFailure ??= error; };
  child.on('error', failed);
  child.stdin.on('error', failed);
  const request = {
    version: 1,
    nonce,
    executable: command,
    cwd,
    status_file: statusFile,
    args,
    env: supervisedChildEnvironment(options.env, child.pid),
  };
  identity.readyPromise = writeControlPipe(child, request).then(() => waitForStatus(statusFile, event => {
    if (event.event === "ERROR") throw new Error(`Windows process supervisor失败: ${event.message}`);
    return event.event === "READY" && event.nonce === nonce ? event : null;
  }, 10_000, () => startupFailure)).then(async ready => {
    identity.targetPid = Number(ready.pid);
    await writeControlPipe(child, { command: "START", version: 1, nonce });
    return ready;
  });
  identity.readyPromise.catch(() => {
    child.stdin.destroy();
  });
  return { child, identity };
}

/** The POSIX caller must create this owned child with detached: true. */
export function processTreeIdentity(child) {
  return { pid: child.pid || null, pgid: child.pid || null };
}

export async function signalProcessTree(_child, identity, signal) {
  if (!identity.pid) return;
  if (process.platform === "win32") {
    await identity.readyPromise;
    if (_child.exitCode !== null || _child.signalCode !== null) return;
    await writeControlPipe(_child, { command: "KILL", version: 1, nonce: identity.nonce });
    return;
  }
  if (!Number.isSafeInteger(identity.pgid) || identity.pgid <= 0) throw new Error('Owned process group identity is invalid');
  try {
    process.kill(-identity.pgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function processTreeAlive(child, identity) {
  if (!identity.pid) return false;
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  if (!Number.isSafeInteger(identity.pgid) || identity.pgid <= 0) throw new Error('Owned process group identity is invalid');
  try {
    process.kill(-identity.pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** A stop result is confirmed by the retained helper's close, including lost control writes. */
export async function stopSupervisedProcess(child, identity, { timeoutMs = 5000, signal = signalProcessTree } = {}) {
  if (!child || !identity || identity.pid !== (child.pid || null) || typeof identity.nonce !== 'string'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid owned supervisor stop');
  if (identity.closed) return;
  const closed = identity.closedPromise || new Promise(resolveClose => child.once('close', resolveClose));
  const release = () => { try { child.stdin?.destroy(); } catch {} };
  void Promise.resolve().then(() => signal(child, identity, 'SIGTERM')).catch(() => {}).then(release);
  let timer;
  try {
    await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Owned supervisor exit is unconfirmed'), { code: 'OWNED_SUPERVISOR_EXIT_UNCONFIRMED' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); release(); }
}

function writeControlPipe(child, request) {
  return new Promise((resolveWrite, reject) => {
    if (child.stdin.destroyed || child.stdin.writableEnded) { reject(new Error('Owned supervisor control pipe is closed')); return; }
    child.stdin.write(`${JSON.stringify(request)}\n`, error => error ? reject(error) : resolveWrite());
  });
}

export async function waitForStatus(path, predicate, timeoutMs, failure) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const error = failure?.();
    if (error) throw error;
    try {
      const content = await readFile(path, "utf8");
      // A receipt is appended in multiple writes. Only complete frames can be parsed.
      for (const line of content.split(/\r?\n/).slice(0, -1).filter(Boolean)) {
        const matched = predicate(JSON.parse(line));
        if (matched) return matched;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error("等待Windows process supervisor READY超时");
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}
