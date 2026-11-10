import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import ts from "../../../mobile/node_modules/typescript/lib/typescript.js";
import { fileURLToPath } from "node:url";

export function parseRpcFrame(raw) {
  try {
    let text;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
    else if (ArrayBuffer.isView(raw)) {
      text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
    } else return null;
    const frame = JSON.parse(text);
    return frame && typeof frame === "object" && !Array.isArray(frame) ? frame : null;
  } catch {
    return null;
  }
}

export function matchesExactResumeResponse({ socketId, expectedSocketId, request, response, threadId }) {
  return socketId === expectedSocketId &&
    request?.method === "thread/resume" &&
    request.params?.threadId === threadId &&
    response?.jsonrpc === "2.0" &&
    Object.is(request.id, response.id) &&
    response.error === undefined &&
    response.result?.thread?.id === threadId;
}

export function matchesExactHistoryReadResponse({
  socketId,
  expectedSocketId,
  socket,
  request,
  response,
  serverId,
  workspace,
  threadId,
}) {
  return socketId === expectedSocketId &&
    socket?.socketId === socketId &&
    socket.serverId === serverId &&
    socket.channel === "runtime" &&
    socket.workspace === workspace &&
    ["thread/read", "thread/read/indexed"].includes(request?.method) &&
    request.params?.threadId === threadId &&
    response?.jsonrpc === "2.0" &&
    Object.is(request.id, response.id) &&
    response.error === undefined &&
    response.result?.thread?.id === threadId;
}

export function matchesPostTerminalHistoryAuthority({
  response,
  requests,
  terminalAtMs,
  socketId,
  serverId,
  workspace,
  threadId,
}) {
  if (!response || !Array.isArray(requests) ||
      typeof terminalAtMs !== "number" || !Number.isFinite(terminalAtMs) ||
      typeof response.receivedAtMs !== "number" || !Number.isFinite(response.receivedAtMs) ||
      response.receivedAtMs < terminalAtMs ||
      response.containsActorAttempt !== true ||
      response.matchesHeldResumeSocketAndScope !== true ||
      response.socketId !== socketId || response.serverId !== serverId ||
      response.channel !== "runtime" || response.workspace !== workspace ||
      response.responseThreadId !== threadId || response.responseIdMatched !== true) return false;

  return requests.some(request => request &&
    Object.is(request.id, response.requestId) &&
    request.socketId === socketId &&
    request.method === response.method &&
    ["thread/read", "thread/read/indexed"].includes(request.method) &&
    request.threadId === threadId &&
    request.serverId === serverId &&
    request.channel === "runtime" &&
    request.workspace === workspace &&
    typeof request.sentAtMs === "number" &&
    Number.isFinite(request.sentAtMs) &&
    request.sentAtMs >= terminalAtMs);
}

export function notificationServerIdFromInitializeResponse(frame) {
  if (frame?.jsonrpc !== "2.0" || frame.id === undefined || frame.error !== undefined ||
      typeof frame.result?.serverInfo?.sessionId !== "string" || !frame.result.serverInfo.sessionId) return null;
  return `server-${frame.result.serverInfo.sessionId}`;
}

let sharedTurnMessageStatusDecoderPromise;

export function loadSharedTurnMessageStatusDecoder() {
  if (!sharedTurnMessageStatusDecoderPromise) {
    sharedTurnMessageStatusDecoderPromise = (async () => {
      const validatorUrl = new URL("../../../shared/generated/validator.mjs", import.meta.url).href;
      const contractsUrl = new URL("../../../shared/generated/contracts.ts", import.meta.url);
      const contractsSource = await readFile(fileURLToPath(contractsUrl), "utf8");
      const contractsJavaScript = transpileSharedTypeScript(contractsSource)
        .replaceAll("'./validator.mjs'", JSON.stringify(validatorUrl))
        .replaceAll('"./validator.mjs"', JSON.stringify(validatorUrl));
      const contractsModuleUrl = asJavaScriptDataUrl(contractsJavaScript);

      const decoderUrl = new URL("../../../shared/turnMessageStatus.ts", import.meta.url);
      const decoderSource = await readFile(fileURLToPath(decoderUrl), "utf8");
      const decoderJavaScript = transpileSharedTypeScript(decoderSource)
        .replaceAll("'./generated/contracts'", JSON.stringify(contractsModuleUrl))
        .replaceAll('"./generated/contracts"', JSON.stringify(contractsModuleUrl));
      const decoderModule = await import(asJavaScriptDataUrl(decoderJavaScript));
      if (typeof decoderModule.decodeTurnMessageStatus !== "function") {
        throw new Error("shared turn-message status decoder could not be loaded");
      }
      return decoderModule.decodeTurnMessageStatus;
    })();
  }
  return sharedTurnMessageStatusDecoderPromise;
}

function transpileSharedTypeScript(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

function asJavaScriptDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

export function isExactTurnStartNotification(frame, {
  threadId,
  turnId,
  attemptId,
  socketId,
  expectedSocketId,
}) {
  const params = frame?.params;
  return typeof socketId === "string" && socketId.length > 0 && socketId === expectedSocketId &&
    frame?.jsonrpc === "2.0" && frame.id === undefined && frame.method === "turn/started" &&
    typeof params?.serverId === "string" && params.serverId.length > 0 &&
    params.threadId === threadId && params.turnId === turnId && params.attemptId === attemptId &&
    params.turn?.id === turnId && params.turn?.threadId === threadId;
}

export function matchesExactTurnNotification(frame, {
  serverId,
  threadId,
  turnId,
  attemptId,
  socketId,
  expectedSocketId,
}) {
  const params = frame?.params;
  return typeof socketId === "string" && socketId.length > 0 && socketId === expectedSocketId &&
    typeof serverId === "string" && serverId.length > 0 &&
    typeof threadId === "string" && threadId.length > 0 &&
    typeof turnId === "string" && turnId.length > 0 &&
    typeof attemptId === "string" && attemptId.length > 0 &&
    frame?.jsonrpc === "2.0" && frame.id === undefined && typeof frame.method === "string" &&
    params?.serverId === serverId &&
    params?.threadId === threadId &&
    params?.turnId === turnId &&
    (params.attemptId === undefined || params.attemptId === attemptId) &&
    (params.turn?.attemptId === undefined || params.turn.attemptId === attemptId) &&
    (frame.method !== "turn/started" || params.attemptId === attemptId);
}

export function isCompletedTurnNotification(frame, identity) {
  return matchesExactTurnNotification(frame, identity) &&
    frame.method === "turn/completed" &&
    frame.params?.turn?.id === identity.turnId &&
    frame.params?.turn?.threadId === identity.threadId &&
    frame.params?.turn?.status === "completed";
}

export function resumePageMessages(frame) {
  const history = frame?.result?.history;
  if (history?.status !== "ready" || !Array.isArray(history.page?.messages)) return null;
  return history.page.messages;
}

export function readPageMessages(frame) {
  const result = frame?.result;
  if (Array.isArray(result?.messages)) return result.messages;
  if (Array.isArray(result?.page?.messages)) return result.page.messages;
  return null;
}

export function attemptMessages(messages, { turnId, attemptId, role } = {}) {
  if (!Array.isArray(messages) || typeof turnId !== "string" || !turnId ||
      typeof attemptId !== "string" || !attemptId) return [];
  return messages.filter(message => message?.turnId === turnId &&
    message?.attemptId === attemptId &&
    (role === undefined || message?.role === role));
}
