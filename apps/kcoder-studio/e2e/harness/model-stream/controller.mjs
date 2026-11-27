import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";

const HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export async function startModelStreamController(context, { scenarioId, operationId, scenario }) {
  validateId(scenarioId, "scenarioId");
  validateId(operationId, "operationId");
  validateScenario(scenarioId, scenario);

  const controlToken = randomBytes(32).toString("hex");
  context.registerSecret(controlToken);
  const requests = new Map();
  const expectedRequests = scenario.requests;
  const runtime = { nextRequestIndex: 0, expectedRequests, requests, waitFor: null, wake: null };
  runtime.rejectedRequests = [];
  let serverClosed = false;
  const listeners = new Set();

  const wake = () => {
    for (const listener of listeners) listener();
    listeners.clear();
  };
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for model stream ${label}`);
      await new Promise((resolve, reject) => {
        let timer;
        const listener = () => {
          clearTimeout(timer);
          resolve();
        };
        listeners.add(listener);
        timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`Timed out waiting for model stream ${label}`));
        }, remaining);
        timer.unref?.();
      });
    }
  };
  runtime.waitFor = waitFor;
  runtime.wake = wake;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${HOST}`);
      if (url.pathname.startsWith("/__control/")) {
        await handleControlRequest(request, response, url, {
          scenarioId,
          operationId,
          controlToken,
          runtime,
        });
        return;
      }

      if (request.method !== "POST" || !["/v1/chat/completions", "/chat/completions"].includes(url.pathname)) {
        sendJson(response, 404, { error: "Unknown model stream route" });
        return;
      }

      const body = await readJsonBody(request);
      await serveModelRequest(body, response, runtime);
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.statusCode ?? 400, { error: error.message });
      else response.destroy(error);
    }
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.listen(0, HOST);
  await once(server, "listening");
  const port = server.address().port;
  context.registerPort(`model stream ${scenarioId}/${operationId}`, port);
  const basePath = `/__control/${encodeURIComponent(scenarioId)}/${encodeURIComponent(operationId)}`;
  const controller = {
    endpointUrl: `http://${HOST}:${port}/v1`,
    controlUrl: `http://${HOST}:${port}${basePath}`,
    controlToken,
    scenarioId,
    operationId,
    async waitForRequest(requestId, { timeoutMs = 30_000 } = {}) {
      validateId(requestId, "requestId");
      await waitFor(() => requests.has(requestId), timeoutMs, `request ${requestId}`);
      return publicRequestState(requests.get(requestId));
    },
    async release(requestId, { frames = "all", timeoutMs = 30_000 } = {}) {
      validateId(requestId, "requestId");
      const state = requireRequest(requests, requestId);
      if (state.status === "completed" || state.status === "disconnected" || state.status === "client_closed") {
        throw new Error(`Cannot release frames for terminal request ${requestId} (${state.status})`);
      }
      const expected = expectedRequests[state.requestIndex];
      const nextLimit = frames === "all" ? expected.frames.length : state.framesWritten + validateFrameCount(frames);
      state.releaseLimit = Math.max(state.releaseLimit, nextLimit);
      wake();
      const target = Math.min(nextLimit, expected.frames.length);
      await waitFor(
        () => state.framesWritten >= target || ["disconnected", "client_closed", "completed"].includes(state.status),
        timeoutMs,
        `frame release for ${requestId}`,
      );
      return publicRequestState(state);
    },
    async disconnect(requestId) {
      validateId(requestId, "requestId");
      const state = requireRequest(requests, requestId);
      if (["completed", "disconnected", "client_closed"].includes(state.status)) {
        throw new Error(`Cannot disconnect terminal request ${requestId} (${state.status})`);
      }
      state.disconnectRequested = true;
      wake();
      await waitFor(() => state.status === "disconnected" || state.status === "client_closed", 5_000, `disconnect for ${requestId}`);
      return publicRequestState(state);
    },
    snapshot() {
      return {
        scenarioId,
        operationId,
        protocol: scenario.protocol,
        source: scenario.source,
        nextRequestIndex: runtime.nextRequestIndex,
        expectedRequestCount: expectedRequests.length,
        requests: [...requests.values()].map(publicRequestState),
        rejectedRequestCount: runtime.rejectedRequests.length,
        rejectedRequests: runtime.rejectedRequests.map(entry => ({ ...entry })),
      };
    },
    async close() {
      if (serverClosed) return;
      serverClosed = true;
      for (const state of requests.values()) {
        if (!["completed", "disconnected", "client_closed"].includes(state.status)) {
          state.status = "disconnected";
          state.response.destroy();
        }
      }
      wake();
      server.close();
      server.closeAllConnections?.();
      await once(server, "close");
    },
  };

  context.addCleanup(`close model stream controller ${scenarioId}/${operationId}`, () => controller.close(), { timeoutMs: 10_000 });
  return controller;
}

async function handleControlRequest(request, response, url, options) {
  const { requests, waitFor, wake, expectedRequests, rejectedRequests } = options.runtime;
  const prefix = `/__control/${encodeURIComponent(options.scenarioId)}/${encodeURIComponent(options.operationId)}`;
  if (!url.pathname.startsWith(prefix)) {
    sendJson(response, 404, { error: "Unknown model stream control route" });
    return;
  }
  if (!hasBearer(request, options.controlToken)) {
    sendJson(response, 401, { error: "Unauthorized model stream control request" });
    return;
  }

  const suffix = url.pathname.slice(prefix.length);
  if (request.method === "POST" && suffix === "/transport") {
    const body = await readJsonBody(request);
    await serveModelRequest(body, response, options.runtime);
    return;
  }
  if (request.method === "GET" && suffix === "/status") {
    sendJson(response, 200, {
      expectedRequestCount: expectedRequests.length,
      nextRequestIndex: options.runtime.nextRequestIndex,
      requests: [...requests.values()].map(publicRequestState),
      rejectedRequestCount: rejectedRequests.length,
      rejectedRequests: rejectedRequests.map(entry => ({ ...entry })),
    });
    return;
  }

  const match = /^\/requests\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})(?:\/(release|disconnect))?$/.exec(suffix);
  if (!match) {
    sendJson(response, 404, { error: "Unknown model stream control route" });
    return;
  }
  const [, requestId, action] = match;
  if (!action && request.method === "GET") {
    if (requests.has(requestId)) {
      sendJson(response, 200, publicRequestState(requests.get(requestId)));
      return;
    }
    sendJson(response, 202, { id: requestId, status: "waiting" });
    return;
  }
  if (request.method !== "POST" || !action) {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const state = requireRequest(requests, requestId);
  if (action === "disconnect") {
    if (["completed", "disconnected", "client_closed"].includes(state.status)) {
      sendJson(response, 409, { error: `Request ${requestId} is already terminal` });
      return;
    }
    state.disconnectRequested = true;
    wake();
    await waitFor(() => ["disconnected", "client_closed"].includes(state.status), 5_000, `disconnect for ${requestId}`);
    sendJson(response, 200, publicRequestState(state));
    return;
  }

  const payload = await readJsonBody(request);
  const frames = payload.frames ?? "all";
  if (["completed", "disconnected", "client_closed"].includes(state.status)) {
    sendJson(response, 409, { error: `Request ${requestId} is already terminal` });
    return;
  }
  const frameCount = state.scenario.frames.length;
  const limit = frames === "all" ? frameCount : state.framesWritten + validateFrameCount(frames);
  state.releaseLimit = Math.max(state.releaseLimit, limit);
  wake();
  await waitFor(
    () => state.framesWritten >= Math.min(limit, frameCount) || ["disconnected", "client_closed", "completed"].includes(state.status),
    30_000,
    `frame release for ${requestId}`,
  );
  sendJson(response, 200, publicRequestState(state));
}

async function serveModelRequest(body, response, options) {
  const index = options.nextRequestIndex;
  const expected = options.expectedRequests[index];
  if (!expected) {
    options.rejectedRequests.push({ expectedRequestId: null, reason: "no_expected_request" });
    options.wake();
    sendJson(response, 409, { error: "No unmatched request remains in this model stream scenario" });
    return;
  }
  const mismatch = matchRequest(body, expected.match);
  if (mismatch) {
    options.rejectedRequests.push({ expectedRequestId: expected.id, reason: mismatch });
    options.wake();
    sendJson(response, 409, { error: `Model request did not match scenario request ${expected.id}`, reason: mismatch });
    return;
  }
  const state = {
    id: expected.id,
    requestIndex: index,
    status: "waiting",
    framesWritten: 0,
    releaseLimit: 0,
    disconnectRequested: false,
    response,
    scenario: expected,
  };
  options.requests.set(state.id, state);
  options.nextRequestIndex += 1;
  options.wake();
  await streamExpectedRequest(state, expected, response, options.waitFor, options.wake);
}

// Kept separate so the normal loopback endpoint and test-only transport share matching and stream semantics.
async function streamExpectedRequest(state, expected, response, waitFor, wake) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  state.status = "streaming";
  response.once("close", () => {
    if (state.status === "streaming") state.status = "client_closed";
    wake();
  });
  wake();

  while (state.framesWritten < expected.frames.length) {
    await waitFor(
      () => state.disconnectRequested || state.status === "client_closed" || state.framesWritten < state.releaseLimit,
      60_000,
      `release for ${state.id}`,
    );
    if (state.disconnectRequested) {
      state.status = "disconnected";
      response.destroy();
      wake();
      return;
    }
    if (state.status === "client_closed") return;
    response.write(expected.frames[state.framesWritten]);
    state.framesWritten += 1;
    wake();
  }

  if (!response.destroyed) {
    response.end();
    state.status = "completed";
    wake();
  }
}

function validateScenario(scenarioId, scenario) {
  if (!scenario || scenario.schemaVersion !== 1 || scenario.id !== scenarioId) throw new Error("Invalid model stream scenario identity");
  if (scenario.protocol !== "openai_chat_completions") throw new Error("Only OpenAI Chat Completions scenarios are supported");
  if (!scenario.source || !["synthetic", "captured"].includes(scenario.source.kind) || typeof scenario.source.description !== "string") {
    throw new Error("Model stream scenario must declare its source");
  }
  if (!Array.isArray(scenario.requests) || scenario.requests.length === 0 || scenario.requests.length > 16) {
    throw new Error("Model stream scenario must contain 1 to 16 requests");
  }
  const ids = new Set();
  for (const request of scenario.requests) {
    validateId(request.id, "request.id");
    if (ids.has(request.id)) throw new Error(`Duplicate model stream request ID: ${request.id}`);
    ids.add(request.id);
    if (!request.match || typeof request.match !== "object" || Array.isArray(request.match)) throw new Error(`Request ${request.id} requires a match object`);
    if (!Array.isArray(request.frames) || request.frames.length === 0 || request.frames.length > 256) throw new Error(`Request ${request.id} requires 1 to 256 SSE frames`);
    for (const frame of request.frames) {
      if (typeof frame !== "string" || Buffer.byteLength(frame) > 64 * 1024 || !frame.startsWith("data: ") || !frame.endsWith("\n\n")) {
        throw new Error(`Request ${request.id} contains an invalid SSE frame`);
      }
    }
  }
}

function validateId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`Invalid ${label}`);
}

function validateFrameCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256) throw new Error("frames must be a positive integer or 'all'");
  return value;
}

function matchRequest(body, match) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "request body must be a JSON object";
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return "messages must be a non-empty array";
  if (match.model !== undefined && body.model !== match.model) return "model did not match";
  if (match.messageCount !== undefined && messages.length !== match.messageCount) return "message count did not match";
  const last = messages.at(-1);
  if (match.lastMessageRole !== undefined && last.role !== match.lastMessageRole) return "last message role did not match";
  if (match.lastMessageIncludes !== undefined && !messageText(last).includes(match.lastMessageIncludes)) return "last message marker did not match";
  if (match.lastMessageToolName !== undefined && !lastMessageToolNames(last).includes(match.lastMessageToolName)) return "last message tool name did not match";
  return null;
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map(part => typeof part?.text === "string" ? part.text : "").join("\n");
}

function lastMessageToolNames(message) {
  return Array.isArray(message?.tool_calls)
    ? message.tool_calls.map(tool => tool?.function?.name).filter(name => typeof name === "string")
    : [];
}

function requireRequest(requests, requestId) {
  const state = requests.get(requestId);
  if (!state) {
    const error = new Error(`Model stream request ${requestId} has not arrived`);
    error.statusCode = 409;
    throw error;
  }
  return state;
}

function publicRequestState(state) {
  return {
    id: state.id,
    requestIndex: state.requestIndex,
    status: state.status,
    framesWritten: state.framesWritten,
    frameCount: state.scenario.frames.length,
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Model stream request exceeded size limit");
      error.statusCode = 413;
      request.destroy(error);
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Model stream request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, body) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "connection": "close",
  });
  response.end(JSON.stringify(body));
}

function hasBearer(request, token) {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
