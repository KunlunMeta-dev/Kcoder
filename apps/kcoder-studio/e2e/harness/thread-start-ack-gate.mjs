import { access, appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { waitFor } from "./run-context.mjs";

/**
 * Build a run-owned stdio proxy which holds only app-server thread/start replies.
 * It records request IDs for compensating thread/delete frames and their matching
 * responses without persisting request payloads, credentials, or transcript data.
 */
export function makeThreadStartAckGateWrapper({ backendBinary, gateDir, gateEventsPath }) {
  const encodedBackendBinary = JSON.stringify(backendBinary);
  const encodedGateDir = JSON.stringify(gateDir);
  const encodedEventsPath = JSON.stringify(gateEventsPath);
  return [
    "#!/usr/bin/env node",
    "\"use strict\";",
    "const { spawn } = require('node:child_process');",
    "const { access, appendFile } = require('node:fs/promises');",
    "const { setTimeout: delay } = require('node:timers/promises');",
    "const { once } = require('node:events');",
    "const readline = require('node:readline');",
    `const backendBinary = ${encodedBackendBinary};`,
    `const gateDir = ${encodedGateDir};`,
    `const gateEventsPath = ${encodedEventsPath};`,
    "const child = spawn(backendBinary, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] });",
    "const requests = new Map();",
    "let gateIndex = 0;",
    "let stopping = false;",
    "let inputChain = Promise.resolve();",
    "const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "input.on('line', line => {",
    "  inputChain = inputChain.then(async () => {",
    "    let frame; try { frame = JSON.parse(line); } catch {}",
    "    if (frame && typeof frame.method === 'string') {",
    "      await appendFile(gateEventsPath, JSON.stringify({ kind: 'client-method', method: frame.method, idPresent: Object.hasOwn(frame, 'id') }) + '\\n', { mode: 0o600 });",
    "    }",
    "    if (frame && Number.isInteger(frame.id) && typeof frame.method === 'string') {",
    "      requests.set(String(frame.id), { method: frame.method, params: frame.params || {} });",
    "    }",
    "    if (frame?.method === 'thread/delete') {",
    "      await appendFile(gateEventsPath, JSON.stringify({ kind: 'delete-forwarded', idPresent: Object.hasOwn(frame, 'id'), requestId: Number.isSafeInteger(frame.id) ? frame.id : null, threadId: frame.params?.threadId || null }) + '\\n', { mode: 0o600 });",
    "    }",
    "    if (!child.stdin.write(line + '\\n')) await once(child.stdin, 'drain');",
    "  }).catch(error => { process.stderr.write('stdio gate input failure: ' + String(error?.message || error) + '\\n'); process.exitCode = 70; });",
    "});",
    "input.on('close', () => child.stdin.end());",
    "process.on('SIGTERM', () => { stopping = true; child.kill('SIGTERM'); });",
    "process.on('SIGINT', () => { stopping = true; child.kill('SIGINT'); });",
    "child.on('error', error => { process.stderr.write('fixed backend launch failure: ' + String(error?.message || error) + '\\n'); process.exitCode = 71; });",
    "const childExit = new Promise(resolve => child.once('exit', code => resolve(code)));",
    "const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });",
    "async function main() {",
    "for await (const line of output) {",
    "  let frame; try { frame = JSON.parse(line); } catch {}",
    "  if (frame && Number.isInteger(frame.id) && !frame.method) {",
    "    const request = requests.get(String(frame.id));",
    "    if (request?.method === 'thread/delete') {",
    "      await appendFile(gateEventsPath, JSON.stringify({ kind: 'delete-response', requestId: frame.id, threadId: request.params?.threadId || null, ok: !frame.error, errorCode: frame.error?.code ?? null }) + '\\n', { mode: 0o600 });",
    "    }",
    "    if (request?.method === 'thread/start') {",
    "      gateIndex += 1;",
    "      const event = { kind: 'held', index: gateIndex, requestId: frame.id, threadId: frame.result?.thread?.id || null, hasClientRequestId: typeof request.params?.clientRequestId === 'string' && request.params.clientRequestId.trim().length > 0 };",
    "      await appendFile(gateEventsPath, JSON.stringify(event) + '\\n', { mode: 0o600 });",
    "      const releasePath = require('node:path').join(gateDir, 'release-' + gateIndex);",
    "      while (!stopping) {",
    "        try { await access(releasePath); break; } catch {}",
    "        await delay(20);",
    "      }",
    "      if (stopping) break;",
    "      await appendFile(gateEventsPath, JSON.stringify({ kind: 'released', index: gateIndex, requestId: frame.id, threadId: event.threadId }) + '\\n', { mode: 0o600 });",
    "    }",
    "    requests.delete(String(frame.id));",
    "  }",
    "  if (!process.stdout.write(line + '\\n')) await once(process.stdout, 'drain');",
    "}",
    "const code = await childExit;",
    "if (process.exitCode === undefined) process.exitCode = Number.isInteger(code) ? code : 0;",
    "}",
    "main().catch(error => { process.stderr.write('stdio gate failure: ' + String(error?.message || error) + '\\n'); process.exitCode = 72; });",
    "",
  ].join("\n");
}

export async function readThreadStartGateEvents(path) {
  const raw = await readFile(path, "utf8").catch(error => error?.code === "ENOENT" ? "" : Promise.reject(error));
  return raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

export async function waitForThreadStartGateEvent(context, path, index, kind, timeoutMs) {
  return waitFor(
    async () => (await readThreadStartGateEvents(path)).find(event => event.index === index && event.kind === kind) ?? null,
    timeoutMs,
    `stdio gate ${kind} event ${index}`,
    25,
    context.abortSignal,
  );
}

export async function releaseThreadStartGate(gateDir, index) {
  const releasePath = resolve(gateDir, `release-${index}`);
  await writeFile(releasePath, "released\n", { mode: 0o600, flag: "wx" });
}

/** Return only run-relative paths associated with one thread ID. */
export async function collectThreadStatePaths(root, stateRoot, threadId) {
  const found = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      const relativePath = relative(stateRoot, path).split(sep).join("/");
      const components = relativePath.split("/");
      if (components.some(component => component === threadId || component.startsWith(`${threadId}.`))) {
        found.push(relativePath);
      }
      if (entry.isDirectory()) await walk(path);
    }
  }
  await walk(root);
  return found.sort();
}
