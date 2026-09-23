import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

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
  const request = {
    version: 1,
    nonce,
    executable: command,
    cwd,
    status_file: statusFile,
    args,
    env: Object.fromEntries(
      Object.entries(options.env || {}).map(([name, value]) => [name, String(value)]),
    ),
  };
  child.stdin.write(`${JSON.stringify(request)}\n`);
  identity.readyPromise = waitForStatus(statusFile, event => {
    if (event.event === "ERROR") throw new Error(`Windows process supervisor失败: ${event.message}`);
    return event.event === "READY" && event.nonce === nonce ? event : null;
  }, 10_000).then(ready => {
    identity.targetPid = Number(ready.pid);
    child.stdin.write(`${JSON.stringify({ command: "START", version: 1, nonce })}\n`);
    return ready;
  });
  identity.readyPromise.catch(() => {
    child.stdin.destroy();
  });
  return { child, identity };
}

export function processTreeIdentity(child) {
  return { pid: child.pid || null, pgid: child.pid || null };
}

export async function signalProcessTree(_child, identity, signal) {
  if (!identity.pid) return;
  if (process.platform === "win32") {
    await identity.readyPromise;
    if (!_child.stdin.destroyed) {
      _child.stdin.write(`${JSON.stringify({ command: "KILL", version: 1, nonce: identity.nonce })}\n`);
    }
    return;
  }
  try {
    process.kill(-identity.pgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function processTreeAlive(child, identity) {
  if (!identity.pid) return false;
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-identity.pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForStatus(path, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const content = await readFile(path, "utf8");
      for (const line of content.split(/\r?\n/).filter(Boolean)) {
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
