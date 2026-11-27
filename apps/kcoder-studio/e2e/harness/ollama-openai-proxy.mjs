import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";

const STANDARD_FIELDS = new Set([
  "frequency_penalty", "logit_bias", "logprobs", "max_completion_tokens", "max_tokens",
  "messages", "model", "n", "parallel_tool_calls", "presence_penalty", "reasoning_effort",
  "response_format", "seed", "stop", "stream", "stream_options", "temperature", "tool_choice",
  "tools", "top_logprobs", "top_p", "user",
]);

export async function startOwnedOllamaOpenAiProxy(context, { upstreamBaseUrl, stamp, startSentinel, endSentinel }) {
  const upstream = new URL(upstreamBaseUrl);
  assert.equal(upstream.protocol, "http:");
  assert.equal(upstream.hostname, "127.0.0.1");
  assert.ok(upstream.port && Number(upstream.port) !== 11_434);
  const requests = [];
  let generationCount = 0;
  let activeRecord = null;
  let activeUpstreamRequest = null;
  let activeUpstreamResponse = null;
  let activeRequestTimer = null;
  let closePromise = null;
  let server;
  const close = () => {
    if (closePromise) return closePromise;
    if (activeRequestTimer) clearTimeout(activeRequestTimer);
    activeUpstreamResponse?.destroy();
    activeUpstreamRequest?.destroy();
    if (!server?.listening) return closePromise = Promise.resolve();
    server.closeAllConnections?.();
    closePromise = new Promise((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    });
    return closePromise;
  };
  server = createServer((incoming, outgoing) => {
    const path = incoming.url || "/";
    const record = {
      method: incoming.method || null, path, providerRequestReceivedAt: stamp(),
      requestContentType: incoming.headers["content-type"] || null,
      authorizationHeaderPresent: Boolean(incoming.headers.authorization),
      responseStatus: null, responseContentType: null, responseHeadersAt: null,
      responseFirstByteAt: null, firstSseFrameAt: null, firstSseReasoningAt: null,
      firstSseContentAt: null, terminalSseDoneAt: null, responseEndedAt: null,
      sseFrameCount: 0, reasoningBytes: 0, contentBytes: 0, finishReason: null,
      usagePromptCount: null, usageCompletionCount: null, requestRejected: false,
    };
    requests.push(record);
    const abortUpstream = () => {
      if (activeRecord !== record) return;
      record.clientDisconnectedAt = stamp();
      if (activeRequestTimer) clearTimeout(activeRequestTimer);
      activeRequestTimer = null;
      activeUpstreamResponse?.destroy();
      activeUpstreamRequest?.destroy();
      activeUpstreamResponse = null;
      activeUpstreamRequest = null;
      activeRecord = null;
    };
    incoming.on("aborted", abortUpstream);
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) abortUpstream();
    });
    if (incoming.method !== "POST" || path !== "/v1/chat/completions") {
      return rejectRequest(incoming, outgoing, record, 404, "unexpected_path");
    }
    if (++generationCount > 1) return rejectRequest(incoming, outgoing, record, 429, "generation_cap");

    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    incoming.on("data", chunk => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        tooLarge = true;
        rejectRequest(incoming, outgoing, record, 413, "request_too_large");
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    incoming.on("end", async () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks);
      record.requestBodyCompleteAt = stamp();
      record.requestBodyBytes = body.length;
      record.requestBodySha256 = sha256(body);
      let payload;
      try { payload = JSON.parse(body.toString("utf8")); }
      catch { return rejectRequest(incoming, outgoing, record, 400, "invalid_json"); }
      record.requestParameters = summarizeRequest(payload, startSentinel, endSentinel);
      if (!record.requestParameters.stream || record.requestParameters.maxOutput !== 8
          || !record.requestParameters.outputLimitsValid
          || !record.requestParameters.choiceCountValid
          || record.requestParameters.thinkFieldSent
          || record.requestParameters.nonStandardFields.length > 0
          || record.requestParameters.toolCount > 0) {
        return rejectRequest(incoming, outgoing, record, 400, "probe_request_budget_or_protocol_mismatch");
      }

      try {
        if (typeof context.writeArtifactJson !== "function") {
          throw new Error("RunContext admission artifact writer is unavailable");
        }
        assertRunActive(context.abortSignal);
        await context.writeArtifactJson("provider-generation-admission.json", {
          stage: "validated-before-upstream-dispatch",
          admittedAt: stamp(),
          method: "POST",
          path: "/v1/chat/completions",
          protocol: record.requestParameters.protocol,
          model: record.requestParameters.model,
          stream: record.requestParameters.stream,
          outputLimits: record.requestParameters.outputLimits,
          choiceCount: record.requestParameters.choiceCount,
          requestBodyBytes: record.requestBodyBytes,
          requestBodySha256: record.requestBodySha256,
          rawRequestBodyRetained: false,
        });
        record.admissionArtifactRecorded = true;
        record.admissionArtifact = "provider-generation-admission.json";
        record.admissionRecordedAt = stamp();
        assertRunActive(context.abortSignal);
      } catch (error) {
        record.admissionArtifactError = safeCode(error);
        return rejectRequest(incoming, outgoing, record, 503, "run_aborting_or_admission_not_recorded");
      }

      const target = new URL("/v1/chat/completions", upstream);
      const headers = {
        "content-type": incoming.headers["content-type"] || "application/json",
        "content-length": String(body.length),
        "accept-encoding": "identity",
        ...(incoming.headers.accept ? { accept: incoming.headers.accept } : {}),
        ...(incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {}),
      };
      record.upstreamRequestStartedAt = stamp();
      const sent = httpRequest(target, { method: "POST", headers, agent: false }, response => {
        activeUpstreamResponse = response;
        record.responseHeadersAt = stamp();
        record.responseStatus = response.statusCode || null;
        record.responseContentType = response.headers["content-type"] || null;
        outgoing.writeHead(response.statusCode || 502, {
          ...(record.responseContentType ? { "content-type": record.responseContentType } : {}),
          ...(response.headers["cache-control"] ? { "cache-control": response.headers["cache-control"] } : {}),
          ...(response.headers["x-request-id"] ? { "x-request-id": response.headers["x-request-id"] } : {}),
        });
        outgoing.flushHeaders();
        const sse = observeSse(record, stamp);
        response.on("data", chunk => {
          if (record.responseFirstByteAt === null) record.responseFirstByteAt = stamp();
          sse.push(chunk);
          if (!outgoing.write(chunk)) response.pause();
        });
        outgoing.on("drain", () => response.resume());
        response.on("end", () => {
          sse.finish();
          record.responseEndedAt = stamp();
          outgoing.end();
          if (activeRequestTimer) clearTimeout(activeRequestTimer);
          activeRequestTimer = null;
          activeUpstreamResponse = null;
          activeUpstreamRequest = null;
          activeRecord = null;
        });
        response.on("error", error => {
          record.upstreamResponseError = safeCode(error);
          outgoing.destroy(error);
          if (activeRequestTimer) clearTimeout(activeRequestTimer);
          activeRequestTimer = null;
          activeUpstreamResponse = null;
          activeUpstreamRequest = null;
          activeRecord = null;
        });
      });
      activeRecord = record;
      activeUpstreamRequest = sent;
      activeRequestTimer = setTimeout(() => {
        sent.destroy(Object.assign(new Error("bounded Ollama request timeout"), { code: "ETIMEDOUT" }));
      }, 240_000);
      sent.on("error", error => {
        record.upstreamRequestError = safeCode(error);
        if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "application/json" });
        outgoing.end();
        if (activeRequestTimer) clearTimeout(activeRequestTimer);
        activeRequestTimer = null;
        activeUpstreamResponse = null;
        activeUpstreamRequest = null;
        activeRecord = null;
      });
      sent.end(body);
    });
    incoming.on("error", error => {
      record.clientRequestError = safeCode(error);
      if (!outgoing.headersSent) outgoing.writeHead(400);
      outgoing.end();
    });
  });
  context.addCleanup("close owned Ollama OpenAI proxy", close);

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const port = server.address().port;
  context.registerPort("ollama-openai-proxy", port);
  return { port, baseUrl: `http://127.0.0.1:${port}`, requests, close };
}

function summarizeRequest(payload, startSentinel, endSentinel) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const userMessages = messages
    .filter(message => message?.role === "user")
    .map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? null));
  const joinedUserContent = JSON.stringify(userMessages);
  const outputLimits = ["max_tokens", "max_completion_tokens"]
    .filter(name => Object.hasOwn(payload, name))
    .map(name => ({ field: name, value: payload[name] }));
  const maxOutput = outputLimits.length > 0 && outputLimits.every(limit => Number.isSafeInteger(limit.value))
    ? outputLimits[0].value
    : null;
  const fields = Object.keys(payload).sort();
  return {
    protocol: "openai-chat-completions", model: payload.model || null,
    stream: payload.stream === true, maxOutput, messageCount: messages.length,
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
    outputLimits,
    outputLimitsValid: outputLimits.length > 0
      && outputLimits.every(limit => Number.isSafeInteger(limit.value) && limit.value === 8),
    choiceCount: payload.n ?? null,
    choiceCountValid: payload.n === undefined || payload.n === 1,
    userMessageCount: userMessages.length,
    userContentBytes: userMessages.reduce((total, content) => total + Buffer.byteLength(content, "utf8"), 0),
    userContentSha256: sha256(Buffer.from(joinedUserContent, "utf8")),
    userMessages: userMessages.map((content, index) => ({
      index,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: sha256(Buffer.from(content, "utf8")),
      startSentinelPresent: content.includes(startSentinel),
      endSentinelPresent: content.includes(endSentinel),
    })),
    selectedUserMessageIndex: userMessages.length ? userMessages.length - 1 : null,
    startSentinelPresent: userMessages.some(content => content.includes(startSentinel)),
    endSentinelPresent: userMessages.some(content => content.includes(endSentinel)),
    thinkFieldSent: Object.hasOwn(payload, "think"), reasoningEffort: payload.reasoning_effort || null,
    streamOptionsIncludeUsage: payload.stream_options?.include_usage === true,
    topLevelFields: fields, nonStandardFields: fields.filter(field => !STANDARD_FIELDS.has(field)),
  };
}

function assertRunActive(signal) {
  if (signal?.aborted) {
    const error = signal.reason instanceof Error ? signal.reason : new Error("RunContext is aborting");
    error.code ||= "ABORT_ERR";
    throw error;
  }
}

function observeSse(record, stamp) {
  const decoder = new TextDecoder();
  let pending = "";
  const observe = text => {
    const data = text.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return;
    record.sseFrameCount += 1;
    if (record.firstSseFrameAt === null) record.firstSseFrameAt = stamp();
    if (data === "[DONE]") { record.terminalSseDoneAt = stamp(); return; }
    let event;
    try { event = JSON.parse(data); } catch { return; }
    for (const choice of event.choices || []) {
      const delta = choice?.delta || {};
      const contentBytes = textBytes(delta.content);
      const reasoningBytes = textBytes(delta.reasoning_content ?? delta.reasoning ?? delta.thinking);
      if (contentBytes) {
        if (record.firstSseContentAt === null) record.firstSseContentAt = stamp();
        record.contentBytes += contentBytes;
      }
      if (reasoningBytes) {
        if (record.firstSseReasoningAt === null) record.firstSseReasoningAt = stamp();
        record.reasoningBytes += reasoningBytes;
      }
      if (typeof choice.finish_reason === "string") record.finishReason = choice.finish_reason;
    }
    if (Number.isSafeInteger(event.usage?.prompt_tokens)) record.usagePromptCount = event.usage.prompt_tokens;
    if (Number.isSafeInteger(event.usage?.completion_tokens)) record.usageCompletionCount = event.usage.completion_tokens;
  };
  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary = /\r?\n\r?\n/.exec(pending);
      while (boundary) {
        observe(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
        boundary = /\r?\n\r?\n/.exec(pending);
      }
    },
    finish() { pending += decoder.decode(); if (pending.trim()) observe(pending); },
  };
}

function rejectRequest(incoming, outgoing, record, status, reason) {
  record.requestRejected = true;
  record.rejectionReason = reason;
  record.responseStatus = status;
  incoming.resume();
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end();
}
function textBytes(value) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, item) => total + textBytes(item?.text ?? item), 0);
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function safeCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "UNKNOWN";
}
