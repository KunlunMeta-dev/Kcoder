#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const CONFIG_ENV = "KCODER_E2E_PEER_FIXTURE_CONFIG";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;
const MIN_CHUNK_BYTES = 256 * 1024;
const THREAD_TIMESTAMP = "2026-01-01T00:00:00.000Z";

const launchArgs = process.argv.slice(2);
const directAppServerLaunch = launchArgs.length === 1 && launchArgs[0] === "app-server";
const workspaceAppServerLaunch = launchArgs.length === 3 && launchArgs[0] === "--cwd" &&
  launchArgs[1] === process.cwd() && launchArgs[2] === "app-server";
if (!directAppServerLaunch && !workspaceAppServerLaunch) {
  process.stderr.write("peer route fixture expects the Gateway app-server launch argument\n");
  process.exit(2);
}

let fixture;
try {
  fixture = await loadFixture(process.env[CONFIG_ENV]);
} catch (error) {
  process.stderr.write(`peer route fixture configuration rejected: ${error.message}\n`);
  process.exit(2);
}

const thread = {
  id: fixture.threadId,
  status: "idle",
  title: "Gateway transport fixture",
  cwd: process.cwd(),
  metadata: {},
  createdAt: THREAD_TIMESTAMP,
  updatedAt: THREAD_TIMESTAMP,
};

const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on("line", line => {
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
    process.stderr.write("peer route fixture rejected an oversized JSON-RPC request\n");
    process.exitCode = 1;
    input.close();
    return;
  }
  let request;
  try { request = JSON.parse(line); }
  catch {
    process.stderr.write("peer route fixture rejected malformed JSON-RPC input\n");
    process.exitCode = 1;
    input.close();
    return;
  }
  void handleRequest(request).catch(error => {
    process.stderr.write(`peer route fixture request failed: ${error.message}\n`);
    if (request && Object.hasOwn(request, "id")) writeResponse(errorResponse(request.id, -32603, "Fixture request failed"));
  });
});

async function handleRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" ||
      typeof request.method !== "string" || !Object.hasOwn(request, "id") && request.method !== "initialized") {
    if (request && Object.hasOwn(request, "id")) writeResponse(errorResponse(request.id, -32600, "Invalid request"));
    return;
  }
  if (request.method === "initialized" && !Object.hasOwn(request, "id")) return;
  if (!Object.hasOwn(request, "id")) return;

  try {
    const params = request.params ?? {};
    let result;
    switch (request.method) {
      case "initialize":
        result = {
          protocolVersion: String(params.protocolVersion ?? "1"),
          serverInfo: { name: "kcoder-peer-route-fixture", version: "1.0.0" },
          capabilities: { approvals: false, questions: false, threadResume: true, experimental: {} },
          sessionId: fixture.threadId,
          cwd: process.cwd(),
          model: null,
        };
        break;
      case "thread/list":
        result = {
          threads: matchesThreadFilter(params) ? [thread] : [],
          completeness: "complete",
          issueCount: 0,
        };
        break;
      case "thread/read":
        requireThread(params);
        result = {
          thread,
          messages: [{
            id: "peer-route-fixture-message",
            role: "user",
            content: "Deterministic transport fixture; no model or provider is invoked.",
            blocks: [],
            timestampMs: Date.parse(THREAD_TIMESTAMP),
          }],
          rangeStart: 0,
          rangeEnd: 1,
          hasMoreBefore: false,
        };
        break;
      case "attachment/read/chunk":
        result = await readChunk(params);
        break;
      case "attachment/read":
        result = await readWholeAttachment(params);
        break;
      default:
        writeResponse(errorResponse(request.id, -32601, "Method not found"));
        return;
    }
    writeResponse({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    const code = error.code === "INVALID_PARAMS" ? -32602 : -32038;
    writeResponse(errorResponse(request.id, code, error.message));
  }
}

function matchesThreadFilter(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  if (params.archived === true) return false;
  if (params.cursor !== undefined && params.cursor !== null) return false;
  if (params.query !== undefined && String(params.query).trim() && !thread.title.toLowerCase().includes(String(params.query).trim().toLowerCase())) return false;
  return true;
}

function requireThread(params) {
  if (!params || typeof params !== "object" || Array.isArray(params) || params.threadId !== fixture.threadId) {
    throw fixtureError("Unknown fixture thread", "INVALID_PARAMS");
  }
}

async function readChunk(params) {
  requireThread(params);
  if (params.path !== fixture.attachmentPath || !Number.isSafeInteger(params.offset) || params.offset < 0 ||
      !Number.isInteger(params.length) || params.length < 1 || params.length > fixture.chunkBytes) {
    throw fixtureError("Invalid fixture attachment range", "INVALID_PARAMS");
  }
  const length = Math.min(params.length, Math.max(0, fixture.size - params.offset));
  const bytes = Buffer.allocUnsafe(length);
  if (length > 0) {
    const file = await open(fixture.payloadPath, "r");
    try {
      const { bytesRead } = await file.read(bytes, 0, length, params.offset);
      if (bytesRead !== length) throw new Error("Fixture payload changed during read");
    } finally { await file.close(); }
  }
  return {
    contentBase64: bytes.toString("base64"),
    offset: params.offset,
    size: length,
    totalSize: fixture.size,
    eof: params.offset + length >= fixture.size,
  };
}

async function readWholeAttachment(params) {
  requireThread(params);
  if (params.path !== fixture.attachmentPath || fixture.size > 256 * 1024) {
    throw fixtureError("Fixture attachment requires chunked reads", "INVALID_PARAMS");
  }
  const bytes = await readFile(fixture.payloadPath);
  if (bytes.length !== fixture.size) throw new Error("Fixture payload changed during read");
  return { contentBase64: bytes.toString("base64"), size: bytes.length };
}

function writeResponse(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function fixtureError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function loadFixture(configFile) {
  if (typeof configFile !== "string" || !isAbsolute(configFile)) throw new Error(`${CONFIG_ENV} must point to a private config file`);
  const configPath = resolve(configFile);
  const configInfo = await lstat(configPath);
  if (!configInfo.isFile() || configInfo.isSymbolicLink() || configInfo.nlink !== 1 || (configInfo.mode & 0o077) !== 0 ||
      typeof process.getuid === "function" && configInfo.uid !== process.getuid() || configInfo.size > 16 * 1024) {
    throw new Error("fixture config must be an owned regular 0600 file under its private run directory");
  }
  const configRoot = dirname(configPath);
  const rootInfo = await lstat(configRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0 ||
      typeof process.getuid === "function" && rootInfo.uid !== process.getuid() || await realpath(configRoot) !== configRoot) {
    throw new Error("fixture config parent must be an owned real 0700 directory");
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const keys = ["threadId", "attachmentPath", "payloadFile", "payloadSha256", "chunkBytes"].sort();
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(keys) ||
      typeof config.threadId !== "string" || !/^[A-Za-z0-9_-]{12,96}$/.test(config.threadId) ||
      typeof config.attachmentPath !== "string" || !/^\/[A-Za-z0-9_./-]{1,160}$/.test(config.attachmentPath) ||
      config.attachmentPath.split("/").some(part => part === "." || part === "..") ||
      typeof config.payloadFile !== "string" || basename(config.payloadFile) !== config.payloadFile ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.payloadFile) || config.payloadFile.includes("..") ||
      typeof config.payloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(config.payloadSha256) ||
      ![MIN_CHUNK_BYTES, MAX_CHUNK_BYTES].includes(config.chunkBytes)) {
    throw new Error("fixture config fields or values are invalid");
  }
  const payloadPath = join(configRoot, config.payloadFile);
  const payloadInfo = await lstat(payloadPath);
  if (!payloadInfo.isFile() || payloadInfo.isSymbolicLink() || payloadInfo.nlink !== 1 || (payloadInfo.mode & 0o077) !== 0 ||
      typeof process.getuid === "function" && payloadInfo.uid !== process.getuid() ||
      payloadInfo.size < MIN_CHUNK_BYTES || payloadInfo.size > MAX_ATTACHMENT_BYTES || await realpath(payloadPath) !== payloadPath) {
    throw new Error("fixture payload must be an owned regular 0600 file between 256 KiB and 1 MiB");
  }
  const payloadSha256 = await hashFile(payloadPath);
  if (payloadSha256 !== config.payloadSha256) throw new Error("fixture payload SHA-256 does not match its private config");
  return { ...config, payloadPath, size: payloadInfo.size };
}

async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
