import { createServer } from "node:http";

// Transparent real-provider transport observer. Never stores headers or request content.
export async function startLiveModelObserver(
  context,
  endpoint,
  maxRequests = 160,
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
  const controllers = new Set();
  let requests = 0;
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    controllers.add(abort);
    const timer = setTimeout(() => abort.abort(), 120000);
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
        try {
          record.model =
            JSON.parse(Buffer.concat(chunks).toString("utf8")).model ?? null;
        } catch {
          record.model = null;
        }
      }
      const headers = {};
      for (const [key, value] of Object.entries(request.headers))
        if (
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
          ...(!valid
            ? { prefix: tool.text.slice(0, 160), suffix: tool.text.slice(-160) }
            : {}),
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
  context.addCleanup("stop owned real model observer", async () => {
    for (const abort of controllers) abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  context.registerPort("real-model-observer", port);
  return {
    endpoint: `http://127.0.0.1:${port}${upstream.pathname.replace(/\/$/, "")}`,
    observations,
  };
}
