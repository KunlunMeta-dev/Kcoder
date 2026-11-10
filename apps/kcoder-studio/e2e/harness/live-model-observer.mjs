import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { nativeSourceReadEvidence, nativeSourceReadRange, nativeSourceRequestShape, nativeTextOutputShape, nativeTaskInputBindingEvidence } from "./native-source-read-evidence.mjs";

export function liveModelRequestPath(endpoint, apiFormat) {
  const base = new URL(endpoint).pathname.replace(/\/+$/, "");
  const suffix = {
    anthropic_messages: "/v1/messages",
    openai_chat_completions: "/chat/completions",
    openai_responses: "/responses",
  }[apiFormat];
  if (!suffix) throw Error("Unsupported protected model API format");
  return apiFormat !== "anthropic_messages" && base.endsWith(suffix)
    ? base
    : base + suffix;
}

// Transparent real-provider transport observer. Never stores headers or request content.
export async function startLiveModelObserver(
  context,
  endpoint,
  maxRequests = 160,
  options = {},
) {
  const upstream = new URL(endpoint);
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash
  )
    throw Error("Invalid model endpoint");
  const observations = [];
  const upstreamHeaders = options.upstreamHeaders ?? {};
  for (const [name,value] of Object.entries(upstreamHeaders)) {
    if (!['x-api-key','authorization'].includes(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw Error('Invalid protected upstream credential header');
    context.registerSecret(value);
  }
  const protectedForward = Object.keys(upstreamHeaders).length > 0;
  const allowedPaths = new Set(options.allowedPaths ?? []);
  if (protectedForward && (!allowedPaths.size || [...allowedPaths].some(path => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return true;
    const target = new URL(path, upstream.origin);
    return target.origin !== upstream.origin || target.pathname !== path || target.search || target.hash;
  }))) throw Error("Protected upstream credentials require exact allowed request paths");
  const forwardToken = protectedForward ? randomBytes(32).toString("hex") : undefined;
  if (forwardToken) context.registerSecret(forwardToken);
  const matchesToken = value => typeof value === "string" &&
    Buffer.byteLength(value) === Buffer.byteLength(forwardToken) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(forwardToken));
  const controllers = new Set();
  let requests = 0;
  const server = createServer(async (request, response) => {
    if (protectedForward) {
      const credentials = [request.headers["x-api-key"], request.headers.authorization?.replace(/^Bearer /i, "")]
        .filter(value => value !== undefined);
      const authorized = credentials.length > 0 && credentials.every(matchesToken);
      if (!authorized || !allowedPaths.has(request.url) || !["POST", "HEAD"].includes(request.method)) {
        request.resume();
        response.writeHead(authorized ? 403 : 401, { "cache-control": "no-store" });
        response.end("Model transport request rejected");
        return;
      }
      // Provider warmup stays local and cannot bypass the inference request budget.
      if (request.method === "HEAD") {
        request.resume();
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
    }
    const abort = new AbortController();
    controllers.add(abort);
    const timer = setTimeout(() => abort.abort(), options.requestTimeoutMs ?? 120000);
    const record = {
      request: 0,
      status: null,
      stopReason: null,
      inputUsage: null,
      outputUsage: null,
      tools: [],
    };
    try {
      record.request = request.method === "POST" ? ++requests : requests;
      if (requests > maxRequests)
        throw Error("Live model request budget exceeded");
      for (const value of [
        request.headers["x-api-key"],
        request.headers.authorization?.replace(/^Bearer /i, ""),
      ])
        if (value) context.registerSecret(value);
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw Error("Model request too large");
        chunks.push(chunk);
      }
      if (request.method === "POST") {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw Error("Invalid real model request JSON"); }
        record.model = body.model ?? null;
        const tools = (body.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(name => typeof name === "string");
        const metadata = { model: record.model, bodyBytes: size,
          outputTokenLimit: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens,
          exposedToolNames: tools };
        if (options.nativeSourceReadEvidence === true) {
          metadata.sourceReads = nativeSourceReadEvidence(body);
          record.sourceReads = metadata.sourceReads;
          record.requestShape = nativeSourceRequestShape(body);
        }
        if (options.nativeTaskInputBinding) {
          metadata.taskInputBinding = nativeTaskInputBindingEvidence(body, options.nativeTaskInputBinding());
          record.taskInputBinding = metadata.taskInputBinding;
        }
        record.requestBodyBytes = size;
        record.outputTokenLimit = Number.isSafeInteger(metadata.outputTokenLimit) ? metadata.outputTokenLimit : null;
        record.exposedToolCount = tools.length;
        // This callback receives only shape/budget metadata, never headers or prompts.
        const admission = await options.beforeForward?.(metadata);
        if (admission !== undefined) record.admission = admission;
      }
      const headers = {};
      for (const [key, value] of Object.entries(request.headers))
        if (
          !(protectedForward && ["authorization", "x-api-key", "cookie", "proxy-authorization"].includes(key)) &&
          ![
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
          ].includes(key) &&
          typeof value === "string"
        )
          headers[key] = value;
      if (!request.url?.startsWith("/") || request.url.startsWith("//"))
        throw Error("Invalid relative provider path");
      const target = new URL(request.url, upstream.origin);
      if (target.origin !== upstream.origin)
        throw Error("Provider origin changed");
      Object.assign(headers, upstreamHeaders);
      const remote = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "POST" ? Buffer.concat(chunks) : undefined,
        signal: abort.signal,
        redirect: "error",
      });
      record.status = remote.status;
      response.writeHead(remote.status, {
        "content-type":
          remote.headers.get("content-type") || "application/octet-stream",
        "cache-control": "no-store",
      });
      const tools = new Map();
      if (options.nativeSourceReadEvidence === true) record.textOutput = nativeTextOutputShape(null, null);
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of remote.body ?? []) {
        response.write(chunk);
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop().slice(-1024 * 1024);
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let frame;
          try {
            frame = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (options.nativeSourceReadEvidence === true)
            record.textOutput = nativeTextOutputShape(record.textOutput, frame);
          if (
            frame.type === "content_block_start" &&
            frame.content_block?.type === "tool_use"
          )
            tools.set(frame.index, {
              name: frame.content_block.name,
              text: Object.keys(frame.content_block.input || {}).length
                ? JSON.stringify(frame.content_block.input)
                : "",
            });
          if (
            frame.type === "content_block_delta" &&
            frame.delta?.type === "input_json_delta"
          ) {
            const tool = tools.get(frame.index);
            if (tool) tool.text += frame.delta.partial_json;
          }
          for (const choice of frame.choices ?? []) {
            for (const call of choice.delta?.tool_calls ?? []) {
              if (!tools.has(call.index))
                tools.set(call.index, { name: "", text: "" });
              const tool = tools.get(call.index);
              if (call.function?.name) tool.name = call.function.name;
              if (call.function?.arguments)
                tool.text += call.function.arguments;
            }
            if (choice.finish_reason) record.stopReason = choice.finish_reason;
          }
          if (frame.usage) {
            record.inputUsage = frame.usage.prompt_tokens ?? record.inputUsage;
            record.outputUsage =
              frame.usage.completion_tokens ?? record.outputUsage;
          }
          if (frame.type === "message_start")
            record.inputUsage = frame.message?.usage?.input_tokens ?? null;
          if (frame.type === "message_delta") {
            record.stopReason = frame.delta?.stop_reason ?? null;
            record.outputUsage = frame.usage?.output_tokens ?? null;
          }
        }
      }
      record.tools = [...tools.values()].map((tool) => {
        let valid = true;
        try {
          JSON.parse(tool.text);
        } catch {
          valid = false;
        }
        return {
          name: tool.name,
          chars: tool.text.length,
          valid,
          ...(options.nativeSourceReadEvidence === true ? { sourceRange: nativeSourceReadRange(tool.name, tool.text) } : {}),
        };
      });
      if (request.method === "POST") observations.push(record);
      response.end();
    } catch (error) {
      record.error = error instanceof Error ? error.name : "Error";
      if (request.method === "POST") observations.push(record);
      if (!response.headersSent) response.writeHead(502);
      response.end("Model transport failed");
    } finally {
      clearTimeout(timer);
      controllers.delete(abort);
    }
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const abort of controllers) abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  context.addCleanup("stop owned real model observer", stop);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  context.registerPort("real-model-observer", port);
  return {
    endpoint: `http://127.0.0.1:${port}${upstream.pathname.replace(/\/+$/, "")}`,
    forwardToken,
    observations,
    stop,
  };
}
