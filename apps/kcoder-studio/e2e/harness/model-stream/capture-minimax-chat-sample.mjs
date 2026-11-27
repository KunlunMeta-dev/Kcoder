import assert from "node:assert/strict";
import { isIP } from "node:net";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadApprovedProviderEnvironment } from "../../suites/mobile/real-provider-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const outputPath = resolve(
  repoRoot,
  "apps/kcoder-studio/e2e/fixtures/model-stream/chat-completions/minimax/captured/text-completion/scenario.json",
);
const sampleMarker = "KCODER_E2E:captured-minimax-sample";
const maxResponseBytes = 1024 * 1024;

export function parseSseDataFrames(input) {
  const blocks = String(input).split(/\r?\n\r?\n/);
  const frames = [];
  for (const block of blocks) {
    const data = block.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) frames.push(data);
  }
  return frames;
}

export function sanitizeCapturedFrames(dataFrames, model) {
  assert.ok(Array.isArray(dataFrames) && dataFrames.length > 0, "sample has no SSE data frames");
  const sawDone = dataFrames.at(-1) === "[DONE]";
  const events = dataFrames.filter(frame => frame !== "[DONE]").map(frame => {
    const event = JSON.parse(frame);
    assert.equal(event.object, "chat.completion.chunk", "unexpected Chat Completions frame type");
    assert.ok(Array.isArray(event.choices), "Chat Completions frame has no choices array");
    assert.equal(event.choices.some(choice => choice?.delta?.tool_calls?.length), false,
      "plain-text sampling unexpectedly produced a tool call");
    return event;
  });
  const finishReasons = events.flatMap(event => event.choices.map(choice => choice.finish_reason).filter(Boolean));
  assert.ok(finishReasons.length > 0, "sample has no completion finish_reason");
  const sanitized = events.map(event => {
    const chunk = {
      id: "chatcmpl-captured-redacted",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: event.choices.map(choice => ({
        index: Number.isInteger(choice.index) ? choice.index : 0,
        delta: sanitizeDelta(choice.delta ?? {}),
        finish_reason: safeFinishReason(choice.finish_reason),
      })),
    };
    const usage = sanitizeUsage(event.usage);
    if (usage) chunk.usage = usage;
    return `data: ${JSON.stringify(chunk)}\n\n`;
  });
  if (sawDone) sanitized.push("data: [DONE]\n\n");
  return {
    frames: sanitized,
    summary: {
      frameCount: sanitized.length,
      observedDeltaFields: [...new Set(events.flatMap(event => event.choices.flatMap(choice => Object.keys(choice.delta ?? {}))))].sort(),
      finishReasons: [...new Set(finishReasons.map(safeFinishReason))].sort(),
      usagePresent: events.some(event => sanitizeUsage(event.usage) !== null),
      doneSentinelPresent: sawDone,
      freeTextRedacted: true,
      identifiersNormalized: true,
    },
  };
}

function sanitizeDelta(delta) {
  const output = {};
  for (const [key, value] of Object.entries(delta)) {
    if (key === "role") {
      output.role = value === "assistant" ? "assistant" : "other";
    } else if (key === "content" && typeof value === "string") {
      output.content = "[REDACTED_SAMPLE_TEXT]";
    } else if (key === "reasoning_content" && typeof value === "string") {
      output.reasoning_content = "[REDACTED_SAMPLE_REASONING]";
    } else if (key === "refusal" && typeof value === "string") {
      output.refusal = "[REDACTED_SAMPLE_REFUSAL]";
    } else if (key === "tool_calls" && Array.isArray(value)) {
      output.tool_calls = value.map((call, index) => ({
        index: Number.isInteger(call.index) ? call.index : index,
        ...(call.id ? { id: `call-captured-${index}` } : {}),
        ...(call.type ? { type: "function" } : {}),
        ...(call.function ? { function: {
          ...(call.function.name ? { name: "[REDACTED_TOOL_NAME]" } : {}),
          ...(call.function.arguments !== undefined ? { arguments: "[REDACTED_TOOL_ARGUMENTS]" } : {}),
        } } : {}),
      }));
    } else if (key === "function_call" && value && typeof value === "object") {
      output.function_call = {
        ...(value.name ? { name: "[REDACTED_TOOL_NAME]" } : {}),
        ...(value.arguments !== undefined ? { arguments: "[REDACTED_TOOL_ARGUMENTS]" } : {}),
      };
    } else {
      output[key] = sanitizeUnknown(value);
    }
  }
  return output;
}

function sanitizeUnknown(value) {
  if (typeof value === "string") return "[REDACTED_SAMPLE_VALUE]";
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeUnknown(child)]));
  return value;
}

function safeFinishReason(value) {
  return ["stop", "length", "tool_calls", "function_call", "content_filter"].includes(value) ? value : value == null ? null : "other";
}

function sanitizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const result = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) result[key] = usage[key];
  }
  for (const [section, fields] of [
    ["prompt_tokens_details", ["cached_tokens", "audio_tokens"]],
    ["completion_tokens_details", ["reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"]],
  ]) {
    const values = {};
    for (const key of fields) {
      if (Number.isSafeInteger(usage[section]?.[key]) && usage[section][key] >= 0) values[key] = usage[section][key];
    }
    if (Object.keys(values).length) result[section] = values;
  }
  return Object.keys(result).length ? result : null;
}

async function readBoundedSse(response) {
  if (!response.body) throw new Error("provider response body unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxResponseBytes) {
      await reader.cancel();
      throw new Error("provider sample exceeded the response size limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, bytes };
}

async function main() {
  assert.equal(process.env.KCODER_E2E_CAPTURE_MINIMAX_SAMPLE, "1",
    "set KCODER_E2E_CAPTURE_MINIMAX_SAMPLE=1 to authorize the bounded sample request");
  try {
    await lstat(outputPath);
    throw new Error("captured sample already exists; refusing another provider request");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const selected = await loadApprovedProviderEnvironment(resolve(repoRoot, ".env"));
  const { KUNLUNMETA_BASE_API_KEY: apiKey, KUNLUNMETA_BASE_URL: baseUrl, KUNLUNMETA_BASE_MODEL: model } = selected.values;
  assert.ok(apiKey && baseUrl && model, "approved MiniMax configuration is incomplete");
  assert.match(model, /^MiniMax-/i, "approved profile is not a MiniMax model");
  const base = new URL(baseUrl);
  assert.equal(base.protocol, "http:", "this capture expects the configured private-network HTTP endpoint");
  assert.equal(isPrivateCgnatIpv4(base.hostname), true, "capture endpoint must be in the private CGNAT range");
  assert.equal(base.username, "", "capture endpoint must not embed credentials");
  assert.equal(base.password, "", "capture endpoint must not embed credentials");
  assert.equal(base.search, "", "capture endpoint must not embed query credentials");
  assert.equal(selected.sourceRoles.KUNLUNMETA_BASE_API_KEY, "repo-root-dotenv");
  assert.equal(selected.sourceRoles.KUNLUNMETA_BASE_URL, "repo-root-dotenv");
  assert.equal(selected.sourceRoles.KUNLUNMETA_BASE_MODEL, "repo-root-dotenv");
  const endpoint = new URL(base);
  const basePath = base.pathname.replace(/\/+$/, "");
  endpoint.pathname = `${basePath}${basePath.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
  endpoint.hash = "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 64,
        temperature: 0,
        tools: [],
        messages: [{ role: "user", content: `${sampleMarker} Reply exactly with KCODER_CAPTURED_REPLY_OK. Do not call tools.` }],
      }),
    });
  } catch {
    clearTimeout(timeout);
    throw new Error("MiniMax sample request failed before receiving an HTTP response");
  }
  if (response.status < 200 || response.status >= 300) {
    clearTimeout(timeout);
    await response.body?.cancel().catch(() => {});
    throw new Error(`MiniMax sample request returned HTTP ${response.status}; response body was discarded`);
  }
  if (response.headers.get("content-type")?.split(";")[0].trim() !== "text/event-stream") {
    clearTimeout(timeout);
    await response.body?.cancel().catch(() => {});
    throw new Error("MiniMax sample endpoint did not return SSE");
  }
  let captured;
  try {
    captured = await readBoundedSse(response);
  } catch {
    await response.body?.cancel().catch(() => {});
    throw new Error("MiniMax sample stream failed or exceeded its bounded capture window");
  } finally {
    clearTimeout(timeout);
  }
  const parsed = parseSseDataFrames(captured.text);
  const result = sanitizeCapturedFrames(parsed, model);
  assert.ok(result.summary.doneSentinelPresent, "MiniMax sample omitted [DONE]");
  assert.ok(result.summary.finishReasons.includes("stop"), "MiniMax sample did not complete with stop");

  const scenario = {
    schemaVersion: 1,
    id: "captured-minimax-text-completion",
    protocol: "openai_chat_completions",
    source: {
      kind: "captured",
      provider: "MiniMax",
      model,
      description: "One authorized synthetic MiniMax Chat Completions request. All free-text values and response identifiers were redacted before persistence.",
      requestCount: 1,
      retries: 0,
      httpStatus: response.status,
      responseBytes: captured.bytes,
      endpointClass: "private-network",
      apiFormat: "openai_chat_completions",
      replay: "Sanitized SSE data frames retain event order, response field names, finish reason, and token usage where returned.",
      sampleSummary: result.summary,
    },
    requests: [{
      id: "initial",
      match: { lastMessageRole: "user", lastMessageIncludes: sampleMarker },
      frames: result.frames,
    }],
  };
  await mkdir(dirname(outputPath), { recursive: true });
  const file = await open(outputPath, "wx", 0o644);
  try {
    await file.writeFile(`${JSON.stringify(scenario, null, 2)}\n`, "utf8");
  } finally {
    await file.close();
  }
  process.stdout.write(`${JSON.stringify({
    status: "captured-redacted",
    model,
    apiFormat: scenario.protocol,
    requestCount: 1,
    retries: 0,
    httpStatus: response.status,
    responseBytes: captured.bytes,
    summary: result.summary,
    output: outputPath,
  })}\n`);
}

function isPrivateCgnatIpv4(host) {
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split(".").map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const message = String(error?.message ?? "");
    process.stderr.write(`${message.startsWith("MiniMax sample request returned HTTP") || message.startsWith("UNMET_PREREQUISITE:") || message.startsWith("set KCODER_E2E_CAPTURE") || message.startsWith("captured sample already exists") ? message : "MiniMax sample capture failed; sensitive response data was not written or logged"}\n`);
    process.exitCode = 1;
  });
}
