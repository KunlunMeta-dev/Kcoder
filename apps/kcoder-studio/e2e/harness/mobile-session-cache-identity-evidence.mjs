import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const MAX_IDENTITY_LENGTH = 4096;

export function projectClientMessageIdEvidence(value, runKey) {
  assert.ok(Buffer.isBuffer(runKey) && runKey.length >= 32,
    "client message identity hashing requires a per-run key of at least 32 bytes");
  const explicit = typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH;
  return {
    clientMessageIdHmacSha256: explicit
      ? createHmac("sha256", runKey).update(value, "utf8").digest("hex")
      : null,
    clientMessageIdExplicit: explicit,
  };
}

export function projectMessageIdentityTuples(messages, runKey) {
  return (Array.isArray(messages) ? messages : []).slice(0, 200).map(message => ({
    id: typeof message?.id === "string" && message.id.length <= MAX_IDENTITY_LENGTH ? message.id : null,
    role: typeof message?.role === "string" && message.role.length <= 32 ? message.role : null,
    turnId: typeof message?.turnId === "string" && message.turnId.length <= MAX_IDENTITY_LENGTH ? message.turnId : null,
    attemptId: typeof message?.attemptId === "string" && message.attemptId.length <= MAX_IDENTITY_LENGTH ? message.attemptId : null,
    ...projectClientMessageIdEvidence(message?.clientMessageId, runKey),
  }));
}

export function projectProtocolRpcRequests(requests) {
  return (Array.isArray(requests) ? requests : []).map(request => ({
    method: typeof request?.method === "string" && request.method.length <= 128 ? request.method : null,
    threadId: typeof request?.threadId === "string" && request.threadId.length <= MAX_IDENTITY_LENGTH ? request.threadId : null,
    socketOrdinal: Number.isSafeInteger(request?.socketOrdinal) ? request.socketOrdinal : null,
    ...(request?.method === "turn/start" ? {
      clientMessageIdHmacSha256: typeof request.clientMessageIdHmacSha256 === "string" &&
          /^[a-f0-9]{64}$/.test(request.clientMessageIdHmacSha256)
        ? request.clientMessageIdHmacSha256
        : null,
      clientMessageIdExplicit: request.clientMessageIdExplicit === true,
      clientPromptMarkerPresent: request.clientPromptMarkerPresent === true,
    } : {}),
  }));
}
