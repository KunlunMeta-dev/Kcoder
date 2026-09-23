import { createServer } from "node:http";

export async function startApprovalModelFixture(context, options = {}) {
  const requests = [];
  const requestOutcomes = [];
  let activeBackgroundRequests = 0;
  const activeResponses = new Set();
  const activeHandlers = new Set();
  const activeTimers = new Set();
  let matchedHttpErrorCount = 0;
  const handleRequest = async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const requestPath = options.protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
    if (request.method !== "POST" || request.url !== requestPath) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    activeResponses.add(response);
    response.once("close", () => activeResponses.delete(response));
    const body = await readJsonBody(request);
    requests.push(body);
    const requestNumber = requests.length;
    const requestOutcome = { requestNumber, closed: false, aborted: false };
    requestOutcomes.push(requestOutcome);
    response.once("close", () => {
      requestOutcome.closed = true;
      requestOutcome.aborted = !response.writableEnded;
    });
    if (options.protocol === "anthropic") {
      // A strict deterministic endpoint catches probe-created budget failures.
      if (body.thinking?.type === "enabled" &&
          (!Number.isInteger(body.thinking.budget_tokens) || body.thinking.budget_tokens < 1024 || body.thinking.budget_tokens >= body.max_tokens)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "invalid thinking budget" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "message_start", message: { id: `fixture-${requestNumber}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: options.textOnlyResponse ?? "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
      return;
    }
    const hasToolResult = Array.isArray(body.messages) && body.messages.some(message => message?.role === "tool");
    const toolResultCount = Array.isArray(body.messages)
      ? body.messages.filter(message => message?.role === "tool").length
      : 0;
    const latestMessage = Array.isArray(body.messages) ? body.messages.at(-1) : null;
    const serializedMessages = JSON.stringify(body.messages ?? []);
    const matchesHttpError =
      options.httpErrorPrompt && serializedMessages.includes(options.httpErrorPrompt)
      && toolResultCount >= (options.httpErrorAfterToolResults ?? 0);
    const httpErrorMatchLimit = options.httpErrorMatchLimit ?? Number.POSITIVE_INFINITY;
    if (matchesHttpError && matchedHttpErrorCount < httpErrorMatchLimit) {
      matchedHttpErrorCount += 1;
      response.writeHead(options.httpErrorStatus || 500, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { message: options.httpErrorMessage || "deterministic provider failure", ...(options.httpErrorCode ? { code: options.httpErrorCode } : {}) },
      }));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    if (options.responseSteps) {
      // Deterministic protocol/geometry tests can gate deltas on observed UI state.
      // Closing the response still cancels every pending gate and timer.
      for (const step of options.responseSteps({ requestNumber, body })) {
        while (step.ready && !step.ready()) {
          if (!(await abortableResponseDelay(response, 20, activeTimers)))
            return;
        }
        if (response.destroyed) return;
        writeEvent(
          response,
          chunk(step.delta ?? {}, step.finishReason ?? null),
        );
      }
    } else if (options.sessionApprovalPrompt && serializedMessages.includes(options.sessionApprovalPrompt)) {
      const sequenceCount = options.sessionApprovalCount || 2;
      if (toolResultCount < sequenceCount) {
        writeEvent(response, chunk({
          role: "assistant",
          tool_calls: [{
            ...approvalToolCall(
              `approval-session-e2e-command-${toolResultCount + 1}`,
              options.sessionApprovalCommands?.[toolResultCount]
                || options.sessionApprovalCommand
                || options.approvalCommand
                || "printf 'APPROVAL_SESSION_E2E\\n'",
            ),
            index: 0,
          }],
        }, null));
        writeEvent(response, chunk({}, "tool_calls"));
      } else {
        writeEvent(response, chunk({
          role: "assistant",
          content: options.sessionApprovalFinalText || "会话级批准验证完成。",
        }, null));
        writeEvent(response, chunk({}, "stop"));
      }
    } else if (options.approvalPerTurn) {
      if (latestMessage?.role === "tool") {
        writeEvent(response, chunk({
          role: "assistant",
          content: toolResultCount >= 2
            ? (options.approvalFinalText || "权限恢复验证完成。")
            : (options.approvalDeniedText || "命令未执行，可在下一轮重试。"),
        }, null));
        writeEvent(response, chunk({}, "stop"));
      } else {
        writeEvent(response, chunk({
          role: "assistant",
          tool_calls: [{
            ...approvalToolCall(
              `approval-e2e-command-${toolResultCount + 1}`,
              options.approvalCommand || "printf 'APPROVAL_E2E_ACCEPTED\\n'",
            ),
            index: 0,
          }],
        }, null));
        writeEvent(response, chunk({}, "tool_calls"));
      }
    } else if (options.backgroundJob) {
      if (serializedMessages.includes("BACKGROUND_CHILD_E2E")) {
        activeBackgroundRequests += 1;
        let active = true;
        const release = () => {
          if (!active) return;
          active = false;
          activeBackgroundRequests -= 1;
        };
        response.once("close", release);
        const delayCompleted = await abortableResponseDelay(
          response,
          options.backgroundDelayMs || 30_000,
          activeTimers,
        );
        release();
        if (!delayCompleted) return;
        writeEvent(response, chunk({ role: "assistant", content: "background child completed" }, null));
        writeEvent(response, chunk({}, "stop"));
      } else if (hasToolResult) {
        writeEvent(response, chunk({ role: "assistant", content: "background job accepted" }, null));
        writeEvent(response, chunk({}, "stop"));
      } else {
        writeEvent(response, chunk({
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "background-e2e-agent",
            type: "function",
            function: {
              name: "spawn_agent",
              arguments: JSON.stringify({
                agent_type: "general",
                message: "BACKGROUND_CHILD_E2E: inspect the fixture and return a short report",
                max_turns: 20,
                run_in_background: true,
              }),
            },
          }],
        }, null));
        writeEvent(response, chunk({}, "tool_calls"));
      }
    } else if (options.question && !hasToolResult) {
      const questionOptions = options.questionOptions || [
        { label: "自动", description: "由系统自动完成部署。" },
        { label: "手动", description: "保留人工控制步骤。" },
      ];
      writeEvent(response, chunk({
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: "question-e2e-request",
          type: "function",
          function: {
            name: "AskUserQuestion",
            arguments: JSON.stringify({
              questions: [{
                question: options.questionText || "请选择部署方式",
                header: options.questionHeader || "部署",
                options: questionOptions,
                multi_select: false,
              }],
            }),
          },
        }],
      }, null));
      writeEvent(response, chunk({}, "tool_calls"));
    } else if (options.question && hasToolResult) {
      writeEvent(response, chunk({
        role: "assistant",
        content: options.questionFinalText || "权限确认后的命令已执行。",
      }, null));
      writeEvent(response, chunk({}, "stop"));
    } else if (options.textOnly) {
      const latestUser = [...(body.messages ?? [])].reverse().find(message => message?.role === "user");
      const userText = extractUserText(latestUser?.content);
      const structuredCompaction = body.response_format?.json_schema?.name === "kcoder_compaction_summary";
      const compactionRequest = options.compactionSummary && (structuredCompaction || JSON.stringify(body.messages ?? []).includes("<summary>"));
      const delayedRequestNumbers = Array.isArray(options.delayedRequestNumbers)
        ? options.delayedRequestNumbers
        : [options.delayedRequestNumber];
      if (delayedRequestNumbers.includes(requestNumber)) {
        writeEvent(response, chunk({ role: "assistant", content: `ACTIVE_STREAM_PARTIAL: ${userText}` }, null));
        const delayCompleted = await abortableResponseDelay(
          response,
          options.streamDelayMs || 30_000,
          activeTimers,
        );
        if (!delayCompleted) return;
      }
      const configuredResponse = typeof options.textOnlyResponse === "function"
        ? options.textOnlyResponse({ body, requestNumber, userText })
        : options.textOnlyResponse;
      if (options.textOnlyReasoning) {
        writeEvent(response, chunk({ role: "assistant", reasoning_content: options.textOnlyReasoning }, null));
      }
      if (Array.isArray(options.textOnlyChunks) && !compactionRequest) {
        for (const content of options.textOnlyChunks) {
          writeEvent(response, chunk({ role: "assistant", content }, null));
          if (options.textOnlyChunkDelayMs && !await abortableResponseDelay(response, options.textOnlyChunkDelayMs, activeTimers)) return;
        }
        writeEvent(response, chunk({}, "stop"));
        response.end("data: [DONE]\n\n");
        return;
      }
      writeEvent(response, chunk({
        role: "assistant",
        content: compactionRequest
          ? structuredCompaction ? JSON.stringify({ summary: "deterministic compacted history" }) : "<summary>deterministic compacted history</summary>"
          : configuredResponse ?? `deterministic renderer response: ${userText}`,
      }, null));
      writeEvent(response, chunk({}, "stop"));
    } else if (options.primeFirstRequest && requests.length === 1) {
      writeEvent(response, chunk({ role: "assistant", content: "权限测试线程已就绪。" }, null));
      writeEvent(response, chunk({}, "stop"));
    } else if (hasToolResult) {
      writeEvent(response, chunk({ role: "assistant", content: "权限确认后的命令已执行。" }, null));
      writeEvent(response, chunk({}, "stop"));
    } else {
      const toolCalls = options.multiApproval
        ? [
            approvalToolCall("approval-e2e-command-a", options.approvalCommandA || "printf 'APPROVAL_A\\n'"),
            approvalToolCall("approval-e2e-command-b", options.approvalCommandB || "printf 'APPROVAL_B\\n'"),
          ]
        : [approvalToolCall(
            "approval-e2e-command",
            options.approvalCommand || "printf 'APPROVAL_E2E_ACCEPTED\\n'",
          )];
      writeEvent(response, chunk({
        role: "assistant",
        tool_calls: toolCalls.map((call, index) => ({ ...call, index })),
      }, null));
      writeEvent(response, chunk({}, "tool_calls"));
    }
    if (options.usage) writeEvent(response, { ...chunk({}, null), choices: [], usage: options.usage });
    response.write("data: [DONE]\n\n");
    response.end();
  };
  const server = createServer((request, response) => {
    const handler = handleRequest(request, response).catch(error => {
      if (!response.destroyed) response.destroy(error);
    });
    activeHandlers.add(handler);
    void handler.finally(() => activeHandlers.delete(handler));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  context.addCleanup("close approval model fixture", async () => {
    const closed = new Promise((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    });
    for (const response of activeResponses) response.destroy();
    server.closeAllConnections?.();
    await withTimeout(
      Promise.allSettled([...activeHandlers]),
      1_000,
      "approval model fixture handlers did not settle",
    );
    await withTimeout(closed, 1_000, "approval model fixture close timed out");
  });
  const address = server.address();
  context.registerPort("approval-model", address.port);
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    requestOutcomes,
    get activeBackgroundRequests() { return activeBackgroundRequests; },
    get activeResponseCount() { return activeResponses.size; },
    get activeHandlerCount() { return activeHandlers.size; },
    get activeTimerCount() { return activeTimers.size; },
  };
}

function extractUserText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "unknown";
  const text = content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
  return text || "unknown";
}

function abortableResponseDelay(response, delayMs, activeTimers) {
  return new Promise(resolveDelay => {
    let settled = false;
    const finish = completed => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeTimers.delete(timer);
      response.off("close", onClose);
      resolveDelay(completed);
    };
    const onClose = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    activeTimers.add(timer);
    response.once("close", onClose);
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function approvalToolCall(id, command) {
  return {
    id,
    type: "function",
    function: {
      name: "bash",
      arguments: JSON.stringify({
        command,
        description: "验证真实权限协议",
        timeout: 10_000,
      }),
    },
  };
}

function chunk(delta, finishReason) {
  return {
    id: "chatcmpl-approval-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model: "approval-e2e-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeEvent(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("approval model request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
