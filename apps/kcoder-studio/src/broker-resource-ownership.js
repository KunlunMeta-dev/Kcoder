import { attachmentPathsFromTurn } from './broker-attachment-paths.js';
import { unclaimedDurableDraft } from './broker-durable-attachment-drafts.js';
import { MIGRATION_VIEW_CREATIONS } from './broker-migration-view-leases.js';
import { terminalSessionIdFrom, threadIdFrom } from './broker-request-identity.js';

// Ownership of client-created resources (terminals, browsers, staged and
// retained attachments, uploads, Wiki archive transfers) on a shared broker.
// The broker remains the owner of the maps; these functions read and update
// them through the broker so dispatch and ordering stay unchanged.

export const STAGED_INPUT_METHODS = new Set([
  "workspace/file/importAttachment",
  "knowledge/attachment/digest",
  "knowledge/source/importAttachment", "knowledge/importArchive",
  "knowledge/markdown/import", "knowledge/export/read",
]);
export const WIKI_ARTIFACT_METHODS = new Set(["knowledge/export", "knowledge/markdown/export", "knowledge/source/original/export"]);
export const WIKI_ARCHIVE_START_METHODS = new Set(["knowledge/archiveTransfer/exportStart", "knowledge/archiveTransfer/importStart"]);
export const WIKI_ARCHIVE_OWNED_METHODS = new Set(["knowledge/archiveTransfer/status", "knowledge/archiveTransfer/read",
  "knowledge/archiveTransfer/chunk", "knowledge/archiveTransfer/importFinish", "knowledge/archiveTransfer/cancel"]);


export const LATE_CREATION_METHODS = new Set([
  ...MIGRATION_VIEW_CREATIONS,
  ...WIKI_ARTIFACT_METHODS,
  ...WIKI_ARCHIVE_START_METHODS,
  "knowledge/source/directoryStage",
  "mcp/login",
  "thread/start",
  "thread/fork",
  "terminal/start",
  "browser/start",
  "attachment/save",
  "attachment/upload/start",
  "attachment/upload/finish",
]);

// The app-server reserves -32041 for a stale transcript cursor, and clients
// answer it by rebuilding their transcript projection. Resource failures that
// are not about the transcript must therefore carry their own codes.
export const RESOURCE_OWNERSHIP_CONFLICT = -32048;
export const RESOURCE_NOT_READY = -32049;

export function resourceKeyFromMessage(message) {
  const params = message?.params ?? message;
  if (!params || typeof params !== "object") return null;
  const method = String(message?.method ?? "");
  if (WIKI_ARCHIVE_OWNED_METHODS.has(method) && typeof params.transferId === "string" && params.transferId) {
    return `wiki-archive\0${params.transferId}`;
  }
  if (STAGED_INPUT_METHODS.has(method) && typeof params.attachmentPath === "string") {
    return `attachment\0${params.attachmentPath}`;
  }

  if (
    method.startsWith("attachment/upload/") &&
    typeof params.upload_id === "string"
  ) {
    return `attachment-upload\0${params.upload_id}`;
  }
  if (
    [
      "attachment/read",
      "attachment/read/chunk",
      "attachment/delete",
    ].includes(method) &&
    typeof params.path === "string"
  ) {
    return `attachment\0${params.path}`;
  }
  const terminalId = method.startsWith("terminal/")
    ? terminalSessionIdFrom(message)
    : null;
  if (typeof terminalId === "string") return `terminal\0${terminalId}`;
  const browserId =
    params.browserId ??
    params.sessionId ??
    (method === 'browser/profile/humanAction' ? params.action?.session_id : null) ??
    (method.startsWith("browser/") ? params.session_id : null) ??
    params.browser?.id ??
    params.session?.id;
  if (typeof browserId === "string") return `browser\0${browserId}`;
  return null;
}

// Returns true when the request was refused here and must not be forwarded.
export function refuseResourceRequest(broker, client, request, requestedThreadId) {
  const requestedResourceKey = broker.resourceKeyFrom(request);
  const requestedTerminalId = request.method?.startsWith("terminal/")
    ? terminalSessionIdFrom(request)
    : null;
  const resourceOwner = requestedResourceKey
    ? (broker.resourceOwners.get(requestedResourceKey) ??
      (requestedTerminalId
        ? broker.terminalClaims.get(requestedTerminalId)
        : null))
    : null;
  if (WIKI_ARCHIVE_OWNED_METHODS.has(request.method) && (!requestedResourceKey || !resourceOwner)) {
    client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: RESOURCE_NOT_READY,
      message: "Wiki archive transfer must be owned by this connection" } });
    return true;
  }
  if (request.method === "attachment/delete" && requestedResourceKey) {
    const retained = broker.retainedAttachmentBindings.get(requestedResourceKey);
    if (retained && (retained.owner !== client.authorizationOwner || resourceOwner !== client || retained.cleaning || retained.cleared)) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: RESOURCE_OWNERSHIP_CONFLICT, message: "Retained attachment deletion requires its current original owner or scoped cleanup" } }); return true;
    }
  }
  if (requestedResourceKey?.startsWith('attachment\0') && unclaimedDurableDraft(broker, requestedResourceKey.slice(11))) {
    client.send({ jsonrpc: '2.0', id: request.id ?? null, error: { code: RESOURCE_NOT_READY,
      message: 'Durable draft attachments must be recovered by their original owner before use' } }); return true;
  }
  if (STAGED_INPUT_METHODS.has(request.method) && requestedResourceKey && !resourceOwner) {
    client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: RESOURCE_NOT_READY, message: "Input must be an upload owned by this client" } });
    return true;
  }
  const terminalClaimInFlight = requestedTerminalId
    ? broker.terminalClaims.has(requestedTerminalId)
    : false;
  if (["attachment/read", "attachment/read/chunk"].includes(request.method) &&
      requestedResourceKey && !resourceOwner && broker.persistentResources.has(requestedResourceKey) &&
      !broker.materializedAttachments.has(requestedResourceKey)) {
    client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: RESOURCE_NOT_READY, message: "Retained staged attachment must be claimed by its next turn before preview" } });
    return true;
  }
  if (
    request.method &&
    resourceOwner &&
    (resourceOwner !== client ||
      (request.method === "terminal/attach" && terminalClaimInFlight)) &&
    !(["attachment/read", "attachment/read/chunk"].includes(request.method) &&
      requestedThreadId && broker.materializedAttachments.get(requestedResourceKey) === requestedThreadId)
  ) {
    if (request.id !== undefined) {
      client.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: RESOURCE_OWNERSHIP_CONFLICT,
          message: "resource belongs to another Gateway client",
        },
      });
    }
    return true;
  }
  if (
    request.method?.startsWith("terminal/") &&
    request.method !== "terminal/attach" &&
    requestedTerminalId &&
    broker.liveTerminals.has(requestedTerminalId) &&
    !resourceOwner
  ) {
    if (request.id !== undefined) {
      client.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: RESOURCE_NOT_READY,
          message: "terminal must be attached before use",
        },
      });
    }
    return true;
  }
  if (["turn/start", "turn/steer"].includes(request.method)) {
    const attachmentPaths = attachmentPathsFromTurn(request);
    const foreignAttachment = attachmentPaths.find((path) => {
      const owner = broker.resourceOwners.get(`attachment\0${path}`);
      return owner && owner !== client;
    });
    if (foreignAttachment) {
      if (request.id !== undefined) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: RESOURCE_OWNERSHIP_CONFLICT,
            message: "attachment belongs to another Gateway client",
          },
        });
      }
      return true;
    }
    if (attachmentPaths.some(path => {
      const binding = broker.retainedAttachmentBindings.get(`attachment\0${path}`);
      return unclaimedDurableDraft(broker, path) || (binding && (binding.cleaning || binding.cleared || binding.threadId !== requestedThreadId || binding.owner !== client.authorizationOwner));
    })) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: RESOURCE_OWNERSHIP_CONFLICT, message: "Retained attachment is bound to another thread or authorization" } }); return true;
    }
    for (const path of attachmentPaths) {
      const key = `attachment\0${path}`;
      if (
        !broker.resourceOwners.has(key) &&
        broker.persistentResources.has(key)
      ) {
        broker.resourceOwners.set(key, client);
      }
    }
  }
  return false;
}

export function bindCreatedResourceOwners(broker, pending, response) {
  if (response.error) {
    if (pending.method === "browser/start" && pending.client) pending.client.browserStarted = false;
    if (pending.method === "attachment/upload/finish") {
      const uploadKey = broker.resourceKeyFrom({
        method: pending.method,
        params: pending.params,
      });
      if (uploadKey) broker.resourceOwners.delete(uploadKey);
    }
    return;
  }
  const result = response.result;
  if (pending.method === "workspace/file/importAttachment" && result?.status === "uploaded") {
    const key = broker.resourceKeyFrom({ method: pending.method, params: pending.params });
    if (key) broker.resourceOwners.delete(key);
  }

  if (WIKI_ARCHIVE_START_METHODS.has(pending.method) && typeof result?.transferId === "string") {
    // The upstream archive registry retains one current collection per process.
    // A successful new admission supersedes all previous terminal transfer IDs.
    for (const key of broker.resourceOwners.keys()) if (key.startsWith("wiki-archive\0")) broker.resourceOwners.delete(key);
    broker.resourceOwners.set(`wiki-archive\0${result.transferId}`, pending.client);
  }
  if (pending.method === "knowledge/archiveTransfer/cancel") {
    const key = broker.resourceKeyFrom({ method: pending.method, params: pending.params });
    if (key) broker.resourceOwners.delete(key);
  }
  if (pending.method === "knowledge/source/directoryStage" && Array.isArray(result?.items)) {
    for (const item of result.items) if (typeof item?.attachmentPath === "string") {
      broker.resourceOwners.set(`attachment\0${item.attachmentPath}`, pending.client);
    }
  }

  if (pending.method.startsWith('cron/')) {
    if (Number.isSafeInteger(result?.jobCount) && result.jobCount >= 0) broker.projectAutomationJobCount = result.jobCount;
    else if (Array.isArray(result?.jobs)) broker.projectAutomationJobCount = result.jobs.length;
    else if (result?.job) broker.projectAutomationJobCount = Math.max(1, broker.projectAutomationJobCount);
    broker.onIdleStateChange?.(broker);
  }
  if (pending.method === "terminal/start") {
    const id = terminalSessionIdFrom(result);
    if (id) {
      if (broker.exitedTerminalIds.delete(id)) return;
      const wasLive = broker.liveTerminals.has(id);
      broker.liveTerminals.add(id);
      broker.resourceOwners.set(`terminal\0${id}`, pending.client);
      if (!wasLive) broker.onIdleStateChange?.(broker);
    }
  }
  if (pending.method === "terminal/attach") {
    const id = terminalSessionIdFrom(result) ?? pending.claimedTerminalId;
    if (id && pending.client) {
      if (broker.exitedTerminalIds.delete(id)) return;
      const wasLive = broker.liveTerminals.has(id);
      broker.liveTerminals.add(id);
      broker.resourceOwners.set(`terminal\0${id}`, pending.client);
      if (!wasLive) broker.onIdleStateChange?.(broker);
    }
  }
  if (pending.method === "browser/start") {
    const id =
      result?.browser?.id ??
      result?.session?.id ??
      result?.browserId ??
      result?.sessionId ??
      result?.session_id;
    if (typeof id === "string")
      broker.resourceOwners.set(`browser\0${id}`, pending.client);
  }
  if (
    (pending.method === "attachment/save" || WIKI_ARTIFACT_METHODS.has(pending.method)) &&
    typeof result?.path === "string"
  ) {
    broker.resourceOwners.set(`attachment\0${result.path}`, pending.client);
  }
  if (
    pending.method === "attachment/upload/start" &&
    typeof result?.upload_id === "string"
  ) {
    broker.resourceOwners.set(
      `attachment-upload\0${result.upload_id}`,
      pending.client,
    );
  }
  if (
    pending.method === "attachment/upload/finish" &&
    typeof result?.path === "string"
  ) {
    const uploadKey = broker.resourceKeyFrom({
      method: pending.method,
      params: pending.params,
    });
    if (uploadKey) broker.resourceOwners.delete(uploadKey);
    broker.resourceOwners.set(`attachment\0${result.path}`, pending.client);
  }
  if (
    [
      "terminal/close",
      "browser/close",
      "attachment/delete",
      "attachment/upload/cancel",
    ].includes(pending.method)
  ) {
    if (pending.method === "browser/close" && result?.closed !== true) return;
    const key = broker.resourceKeyFrom({
      method: pending.method,
      params: pending.params,
    });
    const closedOwnBrowser = pending.method === "browser/close" && key && broker.resourceOwners.get(key) === pending.client;
    if (key) {
      broker.resourceOwners.delete(key);
      broker.persistentResources.delete(key);
      broker.materializedAttachments.delete(key);
    }
    if (pending.method === "terminal/close") {
      const sessionId = terminalSessionIdFrom({
        method: pending.method,
        params: pending.params,
      });
      if (sessionId) broker.forgetTerminal(sessionId);
    }
    if (closedOwnBrowser && pending.client) pending.client.browserStarted = false;
  }
}

export function compensateLateCreatedResources(broker, pending, response) {
  if (response.error) return;
  if (pending.method === "mcp/login") {
    if (typeof response.result?.flowId === "string") broker.cancelMcpFlow(response.result.flowId);
    return;
  }
  const result = response.result;
  if (WIKI_ARCHIVE_START_METHODS.has(pending.method)) {
    if (typeof result?.transferId === "string") broker.cancelArchiveTransfer(result.transferId);
    return;
  }
  if (["thread/start", "thread/fork"].includes(pending.method)) {
    const threadId = threadIdFrom(result);
    if (threadId) {
      broker.sendInternalRequest(result?.ephemeral === true ? "thread/dispose" : "thread/delete", { threadId });
    }
    return;
  }
  if (pending.method === "terminal/start") {
    const sessionId = terminalSessionIdFrom(result);
    if (sessionId) {
      broker.sendInternalRequest("terminal/close", { session_id: sessionId });
    }
    return;
  }
  if (pending.method === "browser/start") {
    const sessionId =
      result?.browser?.id ??
      result?.session?.id ??
      result?.browserId ??
      result?.sessionId ??
      result?.session_id;
    if (typeof sessionId === "string") {
      broker.sendInternalRequest("browser/close", { session_id: sessionId });
    }
    return;
  }
  if (pending.method === "knowledge/source/directoryStage" && Array.isArray(result?.items)) {
    for (const item of result.items) if (typeof item?.attachmentPath === "string") {
      broker.sendInternalRequest("attachment/delete", { path: item.attachmentPath });
    }
    return;
  }
  if (
    (pending.method === "attachment/save" || WIKI_ARTIFACT_METHODS.has(pending.method)) &&
    typeof result?.path === "string"
  ) {
    broker.sendInternalRequest("attachment/delete", { path: result.path });
  }
  if (
    pending.method === "attachment/upload/start" &&
    typeof result?.upload_id === "string"
  ) {
    broker.sendInternalRequest("attachment/upload/cancel", { upload_id: result.upload_id });
  }
  if (
    pending.method === "attachment/upload/finish" &&
    typeof result?.path === "string"
  ) {
    broker.sendInternalRequest("attachment/delete", { path: result.path });
  }
}

export function promoteTurnAttachments(broker, pending, response) {
  if (response.error || pending.method !== "turn/start") return;
  const paths = new Set(pending.attachmentPaths ?? attachmentPathsFromTurn({ params: pending.params }));
  const threadId = threadIdFrom({ method: pending.method, params: pending.params });
  for (const [key, owner] of broker.resourceOwners) {
    if (owner !== pending.client || !key.startsWith("attachment\0")) continue;
    const path = key.slice("attachment\0".length);
    if (threadId && paths.has(path)) {
      broker.persistentResources.add(key);
      broker.materializedAttachments.set(key, threadId);
    }
  }
}

export async function discardRetainedAttachmentPaths(broker, client, threadId, paths) {
  const cleared = [];
  const pending = [];
  for (const path of paths) {
    const key = `attachment\0${path}`;
    const binding = broker.retainedAttachmentBindings.get(key);
    const owner = broker.resourceOwners.get(key);
    const materialized = broker.materializedAttachments.get(key);
    if (!broker.clients.has(client) || !binding || binding.threadId !== threadId || binding.owner !== client.authorizationOwner ||
        binding.cleaning || (owner && owner !== client) || (materialized && materialized !== threadId)) { pending.push(path); continue; }
    if (binding.cleared) { cleared.push(path); continue; }
    // Claim synchronously before the first await. Retain preserves this exact
    // object and next-turn admission refuses paths while cleanup owns it.
    binding.cleaning = true;
    try {
      const absence = await new Promise(resolve => broker.sendInternalRequest("thread/read", { threadId, limit: 1 }, { onResponse: resolve }));
      if (absence.error?.code !== -32021 || absence.error?.message !== `persisted thread not found: ${threadId}`) { pending.push(path); continue; }
      const currentOwner = broker.resourceOwners.get(key);
      const currentMaterialized = broker.materializedAttachments.get(key);
      if (!broker.clients.has(client) || (currentOwner && currentOwner !== client) || broker.retainedAttachmentBindings.get(key) !== binding ||
          (currentMaterialized && currentMaterialized !== threadId)) { pending.push(path); continue; }
      if (!currentMaterialized) {
        const response = await new Promise(resolve => broker.sendInternalRequest("attachment/delete", { path }, { onResponse: resolve }));
        if (response.error || response.result?.removed !== true) { pending.push(path); continue; }
      }
      binding.cleared = true;
      broker.resourceOwners.delete(key);
      broker.persistentResources.delete(key);
      broker.materializedAttachments.delete(key);
      cleared.push(path);
    } finally { binding.cleaning = false; }
  }
  broker.onIdleStateChange?.(broker);
  return { cleared, pending };
}

export function releaseClientResources(broker, client) {
  for (const [key, owner] of broker.resourceOwners) {
    if (owner !== client) continue;
    broker.resourceOwners.delete(key);
    const [kind, resourceId] = key.split("\0", 2);
    const method =
      kind === "terminal"
        ? broker.liveTerminals.has(resourceId)
          ? null
          : "terminal/close"
        : kind === "browser"
          ? "browser/close"
          : null;
    if (method) broker.sendInternalRequest(method, { session_id: resourceId });
    if (kind === "wiki-archive") broker.cancelArchiveTransfer(resourceId);
    if (kind === "attachment-upload") {
      broker.sendInternalRequest("attachment/upload/cancel", { upload_id: resourceId });
    }
    const persistent = broker.persistentResources.has(key);
    if (kind === "attachment" && !persistent) {
      broker.sendInternalRequest("attachment/delete", { path: resourceId });
    }
  }
}
