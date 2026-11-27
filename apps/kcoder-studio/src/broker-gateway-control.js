import { isTargetWorkspaceAbsolute } from './remotes/target-workspace-path.mjs';
import { threadIdFrom } from './broker-request-identity.js';
import { RESOURCE_NOT_READY } from './broker-resource-ownership.js';

// Gateway-local control requests (MCP login, view attachment handles, self
// detach, exclusive restart, workspace release and retained cleanup). They are
// answered by the Gateway and never forwarded to the app-server. Returns true
// when the request was consumed and the broker must stop processing it.
export function handleGatewayControlRequest(broker, client, request) {
  if (request.method === "gateway/mcp/login") {
    if (!(typeof request.id === "string" || Number.isSafeInteger(request.id))) {
      client.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP authorization requires a request ID" } });
      return true;
    }
    if (!client.initialized) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32002, message: "Initialize is required before authorization" } });
      return true;
    }
    void broker.mcpOAuth.login(client, request).catch(error => {
      if (broker.clients.has(client)) client.send({ jsonrpc: "2.0", id: request.id ?? null,
        error: { code: -32021, message: error.message } });
    });
    return true;
  }
  if (request.method?.startsWith("mcp/")) {
    for (const [flowId, owner] of broker.mcpFlowOwners) {
      if (owner.expiresAt <= Date.now()) broker.mcpFlowOwners.delete(flowId);
    }
    if (["mcp/callback", "mcp/cancel"].includes(request.method) &&
        broker.mcpFlowOwners.get(request.params?.flowId)?.client !== client) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
        code: -32021, message: "MCP authorization flow is unavailable on this Gateway connection",
      } });
      return true;
    }
  }

  if (request.method === "server/shutdown/idle") {
    client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
      code: -32601, message: "idle shutdown is reserved for the Gateway lifecycle owner",
    } });
    return true;
  }
  if (['thread/attach', 'thread/detach'].includes(request.method)) {
    client.send({ jsonrpc:'2.0', id:request.id ?? null,
      error:{code:-32601,message:'Attachment handles belong to the authenticated Gateway transport'} });
    return true;
  }
  if (['gateway/thread/attach', 'gateway/thread/detach'].includes(request.method)) {
    const threadId = request.params?.threadId, viewId = request.params?.viewId;
    const owned = broker.threadOwners.get(threadId) === client || broker.sharedThreads.has(threadId, client);
    if (request.id == null || !broker.clients.has(client) || !client.initialized || !owned ||
        typeof viewId !== 'string' || viewId.length === 0 || viewId.length > 64) {
      client.send({jsonrpc:'2.0', id:request.id ?? null,
        error:{code:-32023,message:'A current authorized conversation view is required'}}); return true;
    }
    const changed = request.method === 'gateway/thread/attach'
      ? broker.sessionAttachments.attach(client, threadId, viewId)
      : broker.sessionAttachments.release(client, threadId, viewId);
    client.send({jsonrpc:'2.0',id:request.id,result:{changed}}); return true;
  }
  if (request.method === "gateway/client/detach") {
    const reject = (code, message) => client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code, message } });
    const params = request.params;
    if (request.jsonrpc !== "2.0" || !(typeof request.id === "string" || (Number.isSafeInteger(request.id) && request.id >= 0))) {
      reject(-32600, "Detach requires a JSON-RPC request with an id"); return true;
    }
    if (!params || typeof params !== "object" || Array.isArray(params) || params.confirm !== true || typeof params.force !== "boolean" ||
        Object.keys(params).some(key => !["confirm", "force"].includes(key))) {
      reject(-32602, "Detach requires {confirm:true, force:boolean}"); return true;
    }
    if (!client.initialized) { reject(-32002, "Initialize is required before detach"); return true; }
    const ownThreads = new Set([...broker.activeTurns].filter(([, turn]) => turn.owner === client).map(([threadId]) => threadId));
    let pendingLegacyAnswer = false;
    const legacyLifetime = !broker.sessionAttachments.enabled();
    for (const pending of broker.pending.values()) {
      if (pending.client !== client) continue;
      if (pending.method === "turn/start") ownThreads.add(threadIdFrom({ method: pending.method, params: pending.params }));
      // Even an expired answer can still admit a turn subject to legacy detach interruption.
      if (legacyLifetime && pending.method === 'asyncQuestion/answer' && !pending.asyncQuestionBindingReleased)
        pendingLegacyAnswer = true;
    }
    if (!params.force && legacyLifetime && (ownThreads.size || pendingLegacyAnswer)) {
      reject(-32043, "Client has active turns; explicit cancellation is required"); return true;
    }
    broker.detach(client);
    const drains = [...ownThreads].map(threadId => broker.threadDrains.get(threadId)?.done ?? Promise.resolve(true));
    Promise.all(drains).then(results => {
      // Answering can steer an existing turn or admit a new one. Until its
      // receipt identifies the admission, there is no exact turn to drain.
      if (pendingLegacyAnswer)
        reject(-32043, "Client detached; unable to confirm whether its pending async answer started a turn or whether that turn has stopped");
      else if (results.some(completed => !completed)) reject(-32043, "Unable to confirm detached turns have stopped");
      else client.send({ jsonrpc: "2.0", id: request.id, result: { detached: true } });
      client.close();
    });
    return true;
  }
  if (request.method === "gateway/app-server/restart") {
    const reject = (code, message) => client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code, message } });
    if (request.jsonrpc !== "2.0" || !(typeof request.id === "string" || (Number.isSafeInteger(request.id) && request.id >= 0))) {
      reject(-32600, "Restart requires a JSON-RPC request with an id");
      return true;
    }
    const params = request.params;
    if (!params || typeof params !== "object" || Array.isArray(params) || params.confirm !== true ||
        Object.keys(params).some(key => !["confirm", "force"].includes(key)) ||
        (params.force !== undefined && typeof params.force !== "boolean")) {
      reject(-32602, "Restart requires {confirm:true, force?:boolean}");
      return true;
    }
    if (!client.initialized) { reject(-32002, "Initialize is required before restart"); return true; }
    if (typeof broker.onRestart !== "function") { reject(-32601, "Restart is not available"); return true; }
    if (broker.restartRequest || broker.clients.size !== 1 || broker.pending.size || broker.liveTerminals.size ||
        broker.threadDrains.size || [...broker.resourceOwners.keys()].some(key => key.startsWith("browser\0")) ||
        broker.projectAutomationPendingCount ||
        ((broker.activeTurns.size || broker.activeAutomationThreads.size) && params.force !== true)) {
      reject(-32043, "Restart refused: another client, terminal, browser or request is using this app-server; close other connections first");
      return true;
    }
    broker.restartRequest = { client, id: request.id };
    Promise.resolve().then(() => broker.onRestart(broker)).then(() => {
      client.send({ jsonrpc: "2.0", id: request.id, result: { restarted: false, stopped: true, reconnectRequired: true } });
      client.close();
    }, () => {
      reject(-32044, "Unable to stop app-server for restart");
      broker.restartRequest = null;
      if (broker.closed) client.close();
    });
    return true;
  }
  if (broker.restartRequest) {
    client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32043, message: "App-server restart is in progress" } });
    return true;
  }
  if (request.method === "gateway/workspace/release") {
    if (request.id === undefined) return true;
    const workspacePath = request.params?.workspacePath;
    if (!isTargetWorkspaceAbsolute({ transport: broker.targetTransport, remotePlatform: broker.remotePlatform }, workspacePath)) {
      client.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32602,
          message: "workspace release requires an absolute workspacePath",
        },
      });
      return true;
    }
    Promise.resolve(broker.onReleaseWorkspace?.(workspacePath))
      .then((result) => {
        if (!broker.clients.has(client)) return;
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          result: result ?? { released: true, releasedCount: 0 },
        });
      })
      .catch((error) => {
        if (!broker.clients.has(client)) return;
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32042,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    return true;
  }
  if (request.method === "gateway/attachments/discardRetained") {
    const { threadId, paths } = request.params ?? {};
    if (request.id === undefined || !client.initialized || typeof threadId !== "string" || !threadId ||
        !client.authorizationOwner || !Array.isArray(paths) || !paths.length || paths.length > 256 ||
        paths.some(path => typeof path !== "string" || !path || path.length > 4096) || new Set(paths).size !== paths.length) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: "Scoped retained cleanup requires initialize, threadId and unique bounded paths" } }); return true;
    }
    void broker.discardRetainedAttachments(client, threadId, paths).then(result => {
      if (broker.clients.has(client)) client.send({ jsonrpc: "2.0", id: request.id, result });
    }).catch(() => {
      if (broker.clients.has(client)) client.send({ jsonrpc: "2.0", id: request.id, error: { code: RESOURCE_NOT_READY, message: "Retained cleanup could not be confirmed" } });
    });
    return true;
  }
  return false;
}
