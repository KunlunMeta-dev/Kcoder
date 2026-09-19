import { BrokerMcpOAuth, MCP_OAUTH_RECEIVER, MCP_OAUTH_COMPLETION } from "./broker-mcp-oauth.js";
import { BoundedJsonlDecoder } from "./bounded-jsonl-decoder.js";
import { inspectGatewayChannelMessage } from "./gateway-channel.js";
import { isAbsolute } from "node:path";
import { BrokerLifecycleMetrics } from "./broker-lifecycle-metrics.js";
import { BrokerIdleShutdown } from "./broker-idle-shutdown.js";
import { BrokerHistoryRefresh, HISTORY_REFRESH_METHOD, HistoryRefreshRequestError } from "./broker-history-refresh.js";

function threadIdFrom(message) {
  const params = message?.params ?? message;
  if (!params || typeof params !== "object") return null;
  return typeof params.threadId === "string"
    ? params.threadId
    : typeof params.thread_id === "string"
      ? params.thread_id
      : typeof params.thread?.threadId === "string"
        ? params.thread.threadId
        : typeof params.thread?.id === "string"
          ? params.thread.id
          : null;
}

function turnIdFrom(message) {
  const params = message?.params ?? message;
  if (!params || typeof params !== "object") return null;
  return typeof params.turnId === "string"
    ? params.turnId
    : typeof params.turn_id === "string"
      ? params.turn_id
      : typeof params.turn?.turnId === "string"
        ? params.turn.turnId
        : typeof params.turn?.id === "string"
          ? params.turn.id
          : null;
}

function cloneWithId(message, id) {
  return { ...message, id };
}

function terminalSessionIdFrom(message) {
  const params = message?.params ?? message;
  if (!params || typeof params !== "object") return null;
  const sessionId =
    params.session_id ?? params.terminalId ?? params.terminal?.id;
  return typeof sessionId === "string" ? sessionId : null;
}

function attachmentPathsFromTurn(request) {
  const open = '<kcoder_attachments version="1">\n';
  const close = "\n</kcoder_attachments>";
  const paths = [];
  // Match Rust prompt_from_params exactly: explicit prompt wins; otherwise join
  // direct input.text entries and trim Unicode White_Space (not JavaScript BOM).
  const params = request.params ?? {};
  const prompt = typeof params.prompt === "string" ? params.prompt
    : (Array.isArray(params.input) ? params.input : [])
      .map(item => item?.text).filter(value => typeof value === "string")
      .join("\n").replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const openIndex = prompt.lastIndexOf(open);
  if (openIndex < 0 || !prompt.endsWith(close)) return paths;
  const bodyStart = openIndex + open.length;
  const bodyEnd = prompt.length - close.length;
  for (const line of prompt.slice(bodyStart, bodyEnd).split(/\r?\n/)) {
    try {
      const record = JSON.parse(line);
      if (typeof record?.path === "string") paths.push(record.path);
    } catch {
      // App-server owns the canonical validation error for malformed envelopes.
    }
  }
  return paths;
}

const LATE_CREATION_METHODS = new Set([
  "mcp/login",
  "thread/start",
  "thread/fork",
  "terminal/start",
  "browser/start",
  "attachment/save",
  "attachment/upload/start",
  "attachment/upload/finish",
]);

const CLIENT_NOTIFICATION_METHODS = new Set(["initialized"]);
const THREAD_READONLY_METHODS = new Set([
  "session/modes",
  "thread/read",
  "thread/read/indexed",
  "thread/goal/get",
  "thread/goal/history",
  "attachment/read",
  "attachment/read/chunk",
]);
const THREAD_DRAIN_TIMEOUT_MS = 15_000;

/**
 * Multiplex several gateway WebSockets over one workspace app-server stdio connection.
 *
 * The broker handles wire-protocol multiplexing only. The gateway host still owns
 * process creation, termination, and idle grace.
 */
export class WorkspaceAppServerBroker {
  #lifecycleMetrics;
  #onLifecycleMetrics;

  constructor({
    child,
    adapter,
    maxMessageBytes,
    serverId,
    onClose,
    onRestart,
    onIdleStateChange,
    onWorkspaceRemoved,
    onReleaseWorkspace,
    residentThreads,
    monotonicNow,
    onLifecycleMetrics,
  }) {
    this.#lifecycleMetrics = new BrokerLifecycleMetrics(monotonicNow);
    this.#onLifecycleMetrics = onLifecycleMetrics;
    this.child = child;
    this.adapter = adapter;
    this.maxMessageBytes = maxMessageBytes;
    this.serverId = serverId;
    this.onClose = onClose;
    this.onRestart = onRestart;
    this.onIdleStateChange = onIdleStateChange;
    this.onWorkspaceRemoved = onWorkspaceRemoved;
    this.onReleaseWorkspace = onReleaseWorkspace;
    this.clients = new Set();
    this.threadOwners = new Map();
    this.mcpFlowOwners = new Map();
    this.mcpOAuth = new BrokerMcpOAuth({
      attached: client => this.clients.has(client) && !this.closed,
      forward: (client, message) => this.forwardClientRequest(client, message),
      cancel: flowId => { this.mcpFlowOwners.delete(flowId); this.cancelMcpFlow(flowId); },
      notify: (client, params) => client.send({ jsonrpc: "2.0", method: "mcp/authorizationChanged", params }),
    });
    this.ephemeralThreadOwners = new Map();
    this.threadClaims = new Map();
    this.activeTurns = new Map();
    // After detach, turn/interrupt must await the terminal app-server notification.
    // During drain, do not write thread/resume or turn/start early to the same resident app-server.
    this.threadDrains = new Map();
    this.pending = new Map();
    this.detachedRequestIds = new Set();
    this.detachedRequestsUnknown = false;
    this.historyRefresh = new BrokerHistoryRefresh();
    this.serverRequests = new Map();
    this.resourceOwners = new Map();
    this.liveTerminals = new Set();
    this.terminalClaims = new Map();
    this.exitedTerminalIds = new Set();
    this.persistentResources = new Set();
    this.automationThreads = new Set();
    this.projectAutomationJobCount = 0;
    this.projectAutomationPendingCount = 0;
    this.activeAutomationThreads = new Set();
    this.materializedAttachments = new Map();
    this.nextRequestId = 1;
    this.initializeResponse = null;
    this.initializePending = null;
    this.initializeWaiters = [];
    this.shareability =
      residentThreads === true
        ? "resident"
        : residentThreads === false
          ? "legacy"
          : "unknown";
    this.shareabilityPromise =
      this.shareability === "unknown"
        ? new Promise((resolve) => {
            this.resolveShareability = resolve;
          })
        : Promise.resolve(this.shareability);
    this.closed = false;
    this.idleShutdown = new BrokerIdleShutdown(this, monotonicNow);
    this.lastUsedAt = this.idleShutdown.now();
    this.restartRequest = null;
    this.stdinBackpressured = false;
    this.stdoutBlockedClients = new Set();
    this.stderr = "";
    this.stdoutDecoder = new BoundedJsonlDecoder(maxMessageBytes);

    child.stdout.on("data", (chunk) => this.processStdoutChunk(chunk));
    child.stdout.on("end", () => {
      try {
        const tail = this.stdoutDecoder.finish();
        for (const dropped of tail.dropped) this.handleDroppedFrame(dropped);
        for (const line of tail.lines) this.processStdoutLine(line);
      } catch (error) {
        this.fail(error);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4096);
      process.stderr.write(`[app-server] ${chunk}`);
    });
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      this.resolveShareability?.("closed");
      const disconnected = {
        jsonrpc: "2.0",
        method: "server/disconnected",
        params: { serverId: this.serverId, code, signal },
      };
      for (const client of this.clients) {
        if (client === this.restartRequest?.client) continue;
        client.send(disconnected);
        client.close();
      }
      this.clients.clear();
      this.clearTransientState();
      this.onClose?.(this);
      this.#finishLifecycleMetrics();
    });
  }

  get clientCount() {
    return this.clients.size;
  }

  get reusable() {
    return !this.closed && !this.idleShutdown.closing && this.shareability === "resident";
  }

  get hasProtectedIdleResources() {
    if (this.clientCount !== 0 || this.hasLiveTerminals || this.hasProjectAutomations ||
      this.hasPendingWork || this.resourceOwners.size > 0) return true;
    for (const key of this.persistentResources) {
      if (!this.materializedAttachments.has(key)) return true;
    }
    return false;
  }

  stopWhenIdle() { return this.idleShutdown.stop(); }
  readResourceSnapshot() { return this.idleShutdown.readResources(); }

  get hasLiveTerminals() {
    return this.liveTerminals.size > 0;
  }

  get hasPendingWork() {
    return this.pending.size > 0 || this.activeTurns.size > 0 ||
      this.threadDrains.size > 0 || this.serverRequests.size > 0 ||
      this.detachedRequestIds.size > 0 || this.detachedRequestsUnknown;
  }

  get hasProjectAutomations() {
    return this.projectAutomationJobCount > 0 || this.projectAutomationPendingCount > 0 || this.activeAutomationThreads.size > 0;
  }

  get acceptsClient() {
    return (
      !this.closed &&
      !this.idleShutdown.closing &&
      !this.restartRequest &&
      (this.shareability === "resident" || this.clientCount === 0)
    );
  }

  whenShareabilityKnown() {
    return this.shareabilityPromise;
  }

  attach(client) {
    if (this.closed || this.restartRequest || this.idleShutdown.closing) throw new Error("workspace app-server broker is closed or restarting");
    this.#lifecycleMetrics.attach(this.clientCount === 0);
    this.lastUsedAt = this.idleShutdown.now();
    client.browserStarted = false;
    client.initialized = false;
    client.toolPathPreviewV1 = undefined;
    this.clients.add(client);
  }

  detach(client) {
    this.mcpOAuth.detach(client);
    for (const [flowId, owner] of this.mcpFlowOwners) {
      if (owner.client === client) {
        this.mcpFlowOwners.delete(flowId);
        this.cancelMcpFlow(flowId);
      }
    }
    if (this.initializeResponse?.result?.capabilities?.experimental?.goalContinuation) {
      for (const [threadId, owner] of this.threadOwners) {
        if (owner !== client) continue;
        // Disarm idle automatic work as well as any currently running turn.
        // Read-only/transient clients never own a thread and cannot suspend it.
        this.safeWriteMessage({ jsonrpc: "2.0", method: "thread/automation/suspend", params: { threadId } });
      }
    }
    for (const [threadId, owner] of this.ephemeralThreadOwners) {
      if (owner !== client) continue;
      this.ephemeralThreadOwners.delete(threadId);
      this.safeWriteMessage({ jsonrpc: "2.0", method: "thread/dispose", params: { threadId } });
    }
    if (this.clients.delete(client) && this.clientCount === 0) {
      this.#lifecycleMetrics.clientFree();
      this.lastUsedAt = this.idleShutdown.now();
    }
    this.releaseStdout(client);
    for (const [threadId, active] of this.activeTurns) {
      if (active.owner !== client) continue;
      this.beginThreadDrain(threadId, active.turnId);
      this.safeWriteMessage({
        jsonrpc: "2.0",
        method: "turn/interrupt",
        params: { threadId, turnId: active.turnId },
      });
      this.activeTurns.delete(threadId);
    }
    for (const [id, pending] of this.pending) {
      if (pending.client !== client) continue;
      if (pending.refreshTicket) pending.client = null;
      else if (pending.method === "initialize") pending.client = null;
      else if (pending.method === "turn/start") {
        // The protocol requires threadId and turnId for interruption. Before the start
        // response arrives, retain a tombstone detached from the client; interrupt
        // immediately when the response arrives without restoring owner state.
        pending.client = null;
        pending.interruptOnResponse = true;
        const threadId = threadIdFrom({ params: pending.params });
        if (threadId) this.beginThreadDrain(threadId);
      } else if (LATE_CREATION_METHODS.has(pending.method)) {
        // A successful creation response may carry a previously unknown thread/resource
        // ID. Retain the tombstone and perform compensating cleanup with the real ID when
        // the response arrives, preventing disconnect retries from exhausting resident slots or session resources.
        pending.client = null;
        pending.cleanupOnResponse = true;
      } else if (pending.method === "terminal/close") {
        // close already reached app-server; retain the tombstone until the authoritative response updates the live set.
        pending.client = null;
      } else {
        this.#lifecycleMetrics.resumeAbandoned(pending.resumeStartedAt);
        this.releaseThreadClaim(pending);
        this.releaseTerminalClaim(pending);
        this.pending.delete(id);
        // Keep only correlation IDs, never disconnected client objects or prompts.
        // Overflow remains conservatively busy until process exit.
        if (this.detachedRequestIds.size < 4096) this.detachedRequestIds.add(id);
        else this.detachedRequestsUnknown = true;
      }
    }
    this.sendRefreshCleanup(this.historyRefresh.detach(client));
    for (const drain of this.threadDrains.values()) {
      drain.queue = drain.queue.filter((entry) => entry.client !== client);
    }
    for (const [threadId, owner] of this.threadOwners) {
      if (owner === client) this.threadOwners.delete(threadId);
    }
    for (const [threadId, owner] of this.threadClaims) {
      if (owner === client) this.threadClaims.delete(threadId);
    }
    for (const [sessionId, owner] of this.terminalClaims) {
      if (owner === client) this.terminalClaims.delete(sessionId);
    }
    this.initializeWaiters = this.initializeWaiters.filter(
      (waiter) => waiter.client !== client,
    );
    for (const [id, owner] of this.serverRequests) {
      if (owner !== client) continue;
      this.serverRequests.delete(id);
      this.safeWriteMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32040, message: "owning Gateway client disconnected" },
      });
    }
    for (const [key, owner] of this.resourceOwners) {
      if (owner !== client) continue;
      this.resourceOwners.delete(key);
      const [kind, resourceId] = key.split("\0", 2);
      const method =
        kind === "terminal"
          ? this.liveTerminals.has(resourceId)
            ? null
            : "terminal/close"
          : kind === "browser"
            ? "browser/close"
            : null;
      if (method)
        this.safeWriteMessage({
          jsonrpc: "2.0",
          method,
          params: { session_id: resourceId },
        });
      if (kind === "attachment-upload") {
        this.safeWriteMessage({
          jsonrpc: "2.0",
          method: "attachment/upload/cancel",
          params: { upload_id: resourceId },
        });
      }
      const persistent = this.persistentResources.has(key);
      if (kind === "attachment" && !persistent) {
        this.safeWriteMessage({
          jsonrpc: "2.0",
          method: "attachment/delete",
          params: { path: resourceId },
        });
      }
    }
  }

  blockStdout(client) {
    if (this.closed || this.stdoutBlockedClients.has(client)) return;
    this.stdoutBlockedClients.add(client);
    this.child.stdout.pause();
  }

  releaseStdout(client) {
    if (!this.stdoutBlockedClients.delete(client)) return;
    if (!this.closed && this.stdoutBlockedClients.size === 0)
      this.child.stdout.resume();
  }

  clearTransientState() {
    this.historyRefresh.reset();
    this.ephemeralThreadOwners.clear();
    this.threadOwners.clear();
    this.mcpFlowOwners.clear();
    this.mcpOAuth.close();
    this.threadClaims.clear();
    this.activeTurns.clear();
    this.activeAutomationThreads.clear();
    this.automationThreads.clear();
    this.projectAutomationJobCount = 0;
    this.projectAutomationPendingCount = 0;
    for (const drain of this.threadDrains.values()) {
      clearTimeout(drain.timer);
      drain.resolveDone?.(false);
    }
    this.threadDrains.clear();
    for (const pending of this.pending.values())
      this.#lifecycleMetrics.resumeAbandoned(pending.resumeStartedAt);
    this.pending.clear();
    this.detachedRequestIds.clear();
    this.detachedRequestsUnknown = false;
    this.serverRequests.clear();
    this.resourceOwners.clear();
    this.liveTerminals.clear();
    this.terminalClaims.clear();
    this.exitedTerminalIds.clear();
    this.persistentResources.clear();
    this.materializedAttachments.clear();
    this.initializeWaiters.length = 0;
    this.initializePending = null;
    this.initializeResponse = null;
    this.stdoutBlockedClients.clear();
  }

  receive(client, raw) {
    if (!this.clients.has(client))
      throw new Error("gateway client is not attached");
    const inspected = inspectGatewayChannelMessage(client.channel, raw, {
      browserStarted: client.browserStarted,
    });
    if (!inspected.allowed) {
      client.send({
        jsonrpc: "2.0",
        id: inspected.request?.id ?? null,
        error: {
          code: -32601,
          message: "Method not available on this gateway channel",
        },
      });
      return;
    }

    let request;
    try {
      request = JSON.parse(raw);
    } catch {
      // After multiplexing, an app-server id:null parse error cannot be associated with
      // the original connection. Return a standard JSON-RPC parse error at the boundary
      // and never spread a malformed frame to other clients.
      client.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    if (request.method === "gateway/mcp/login") {
      if (!(typeof request.id === "string" || Number.isSafeInteger(request.id))) {
        client.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP authorization requires a request ID" } });
        return;
      }
      if (!client.initialized) {
        client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32002, message: "Initialize is required before authorization" } });
        return;
      }
      void this.mcpOAuth.login(client, request).catch(error => {
        if (this.clients.has(client)) client.send({ jsonrpc: "2.0", id: request.id ?? null,
          error: { code: -32021, message: error.message } });
      });
      return;
    }
    if (request.method?.startsWith("mcp/")) {
      for (const [flowId, owner] of this.mcpFlowOwners) {
        if (owner.expiresAt <= Date.now()) this.mcpFlowOwners.delete(flowId);
      }
      if (["mcp/callback", "mcp/cancel"].includes(request.method) &&
          this.mcpFlowOwners.get(request.params?.flowId)?.client !== client) {
        client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
          code: -32021, message: "MCP authorization flow is unavailable on this Gateway connection",
        } });
        return;
      }
    }

    if (request.method === "server/shutdown/idle") {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
        code: -32601, message: "idle shutdown is reserved for the Gateway lifecycle owner",
      } });
      return;
    }
    if (request.method === "gateway/client/detach") {
      const reject = (code, message) => client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code, message } });
      const params = request.params;
      if (request.jsonrpc !== "2.0" || !(typeof request.id === "string" || (Number.isSafeInteger(request.id) && request.id >= 0))) {
        reject(-32600, "Detach requires a JSON-RPC request with an id"); return;
      }
      if (!params || typeof params !== "object" || Array.isArray(params) || params.confirm !== true || typeof params.force !== "boolean" ||
          Object.keys(params).some(key => !["confirm", "force"].includes(key))) {
        reject(-32602, "Detach requires {confirm:true, force:boolean}"); return;
      }
      if (!client.initialized) { reject(-32002, "Initialize is required before detach"); return; }
      const ownThreads = new Set([...this.activeTurns].filter(([, turn]) => turn.owner === client).map(([threadId]) => threadId));
      for (const pending of this.pending.values()) {
        if (pending.client === client && pending.method === "turn/start") ownThreads.add(threadIdFrom({ params: pending.params }));
      }
      if (ownThreads.size && !params.force) { reject(-32043, "Client has active turns; explicit cancellation is required"); return; }
      this.detach(client);
      const drains = [...ownThreads].map(threadId => this.threadDrains.get(threadId)?.done ?? Promise.resolve(true));
      Promise.all(drains).then(results => {
        if (results.some(completed => !completed)) reject(-32043, "Unable to confirm detached turns have stopped");
        else client.send({ jsonrpc: "2.0", id: request.id, result: { detached: true } });
        client.close();
      });
      return;
    }
    if (request.method === "gateway/app-server/restart") {
      const reject = (code, message) => client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code, message } });
      if (request.jsonrpc !== "2.0" || !(typeof request.id === "string" || (Number.isSafeInteger(request.id) && request.id >= 0))) {
        reject(-32600, "Restart requires a JSON-RPC request with an id");
        return;
      }
      const params = request.params;
      if (!params || typeof params !== "object" || Array.isArray(params) || params.confirm !== true ||
          Object.keys(params).some(key => !["confirm", "force"].includes(key)) ||
          (params.force !== undefined && typeof params.force !== "boolean")) {
        reject(-32602, "Restart requires {confirm:true, force?:boolean}");
        return;
      }
      if (!client.initialized) { reject(-32002, "Initialize is required before restart"); return; }
      if (typeof this.onRestart !== "function") { reject(-32601, "Restart is not available"); return; }
      if (this.restartRequest || this.clients.size !== 1 || this.pending.size || this.liveTerminals.size ||
          this.threadDrains.size || [...this.resourceOwners.keys()].some(key => key.startsWith("browser\0")) ||
          this.projectAutomationPendingCount ||
          ((this.activeTurns.size || this.activeAutomationThreads.size) && params.force !== true)) {
        reject(-32043, "Restart refused: another client, terminal, browser or request is using this app-server; close other connections first");
        return;
      }
      this.restartRequest = { client, id: request.id };
      Promise.resolve().then(() => this.onRestart(this)).then(() => {
        client.send({ jsonrpc: "2.0", id: request.id, result: { restarted: false, stopped: true, reconnectRequired: true } });
        client.close();
      }, () => {
        reject(-32044, "Unable to stop app-server for restart");
        this.restartRequest = null;
        if (this.closed) client.close();
      });
      return;
    }
    if (this.restartRequest) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32043, message: "App-server restart is in progress" } });
      return;
    }
    if (request.method === "gateway/workspace/release") {
      if (request.id === undefined) return;
      const workspacePath = request.params?.workspacePath;
      if (typeof workspacePath !== "string" || !isAbsolute(workspacePath)) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: "workspace release requires an absolute workspacePath",
          },
        });
        return;
      }
      Promise.resolve(this.onReleaseWorkspace?.(workspacePath))
        .then((result) => {
          if (!this.clients.has(client)) return;
          client.send({
            jsonrpc: "2.0",
            id: request.id,
            result: result ?? { released: true, releasedCount: 0 },
          });
        })
        .catch((error) => {
          if (!this.clients.has(client)) return;
          client.send({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32042,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
      return;
    }
    if (request.method === "gateway/attachments/retain") {
      if (request.id === undefined) return;
      const requestedPaths = request.params?.paths;
      const paths = Array.isArray(requestedPaths)
        ? [
            ...new Set(
              requestedPaths.filter(
                (path) => typeof path === "string" && path.length > 0,
              ),
            ),
          ]
        : [];
      if (paths.length === 0 || paths.length !== requestedPaths.length) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: "attachment retain requires unique non-empty paths",
          },
        });
        return;
      }
      const keys = paths.map((path) => `attachment\0${path}`);
      if (keys.some((key) => this.resourceOwners.get(key) !== client)) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32041,
            message: "attachment does not belong to this Gateway client",
          },
        });
        return;
      }
      for (const key of keys) this.persistentResources.add(key);
      client.send({
        jsonrpc: "2.0",
        id: request.id,
        result: { retained: true, paths },
      });
      return;
    }
    if (request.method === "initialize") {
      // Cache backend initialization, not another client's opt-in preferences.
      if (client.toolPathPreviewV1 === undefined) {
        client.toolPathPreviewV1 =
          request.params?.capabilities?.experimental?.toolPathPreviewV1 === true;
      }
      if (this.initializeResponse) {
        client.initialized = !this.initializeResponse.error;
        client.send(cloneWithId(this.initializeResponse, request.id ?? null));
        return;
      }
      if (this.initializePending) {
        this.initializeWaiters.push({ client, clientId: request.id ?? null });
        return;
      }
    }
    if (
      request.method &&
      request.id === undefined &&
      !CLIENT_NOTIFICATION_METHODS.has(request.method)
    ) {
      // Every current client-protocol operation except initialized requires a response.
      // Reject ID-less operations so they cannot create threads, terminals, browsers, or attachments without ownership and cleanup.
      return;
    }
    const commandKey = request.params?.command_key;
    if (
      request.method === "device/execute" &&
      ["turn_file_changes_review", "turn_file_changes_revert"].includes(
        commandKey,
      ) &&
      !threadIdFrom(request)
    ) {
      const owned = [...this.threadOwners]
        .filter(([, owner]) => owner === client)
        .map(([threadId]) => threadId);
      if (owned.length !== 1) {
        client.send({
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: {
            code: -32602,
            message:
              "turn file changes command requires threadId when the client owns zero or multiple threads",
          },
        });
        return;
      }
      request.params = { ...request.params, threadId: owned[0] };
    }
    const requestedThreadId = threadIdFrom(request);
    // Catalogs describe the effective resident session, not public thread history.
    // An in-flight resume claim or detached resident is not completed ownership.
    if (request.method === "tools/catalog" && requestedThreadId &&
        this.threadOwners.get(requestedThreadId) !== client) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
        code: -32023, message: "tools/catalog requires a thread resumed by this Gateway client",
      } });
      return;
    }
    const ephemeralOwner = requestedThreadId ? this.ephemeralThreadOwners.get(requestedThreadId) : null;
    if (ephemeralOwner && ephemeralOwner !== client) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: {
        code: -32023, message: "temporary thread belongs to another Gateway client",
      } });
      return;
    }
    // Forking reads the source but binds a new independent child to this client.
    const ephemeralFork = request.method === "thread/fork" && request.params?.ephemeral === true;
    const threadDrain = requestedThreadId
      ? this.threadDrains.get(requestedThreadId)
      : null;
    if (
      threadDrain &&
      request.method &&
      !THREAD_READONLY_METHODS.has(request.method)
    ) {
      if (request.id !== undefined) {
        if (threadDrain.timedOut) this.rejectUnconfirmedDrain(client, request.id);
        else threadDrain.queue.push({ client, raw, id: request.id });
      }
      return;
    }
    const currentClaim = requestedThreadId
      ? this.threadClaims.get(requestedThreadId)
      : null;
    const currentOwner = requestedThreadId
      ? (this.threadOwners.get(requestedThreadId) ?? currentClaim)
      : null;
    if (
      request.method &&
      requestedThreadId &&
      currentOwner &&
      (currentOwner !== client ||
        (request.method === "thread/resume" && currentClaim)) &&
      !THREAD_READONLY_METHODS.has(request.method) && !ephemeralFork
    ) {
      if (request.id !== undefined) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32023,
            message: "thread is already active in another Gateway client",
          },
        });
      }
      return;
    }
    const requestedResourceKey = this.resourceKeyFrom(request);
    const requestedTerminalId = request.method?.startsWith("terminal/")
      ? terminalSessionIdFrom(request)
      : null;
    const resourceOwner = requestedResourceKey
      ? (this.resourceOwners.get(requestedResourceKey) ??
        (requestedTerminalId
          ? this.terminalClaims.get(requestedTerminalId)
          : null))
      : null;
    const terminalClaimInFlight = requestedTerminalId
      ? this.terminalClaims.has(requestedTerminalId)
      : false;
    if (["attachment/read", "attachment/read/chunk"].includes(request.method) &&
        requestedResourceKey && !resourceOwner && this.persistentResources.has(requestedResourceKey) &&
        !this.materializedAttachments.has(requestedResourceKey)) {
      client.send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32041, message: "Retained staged attachment must be claimed by its next turn before preview" } });
      return;
    }
    if (
      request.method &&
      resourceOwner &&
      (resourceOwner !== client ||
        (request.method === "terminal/attach" && terminalClaimInFlight)) &&
      !(["attachment/read", "attachment/read/chunk"].includes(request.method) &&
        requestedThreadId && this.materializedAttachments.get(requestedResourceKey) === requestedThreadId)
    ) {
      if (request.id !== undefined) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32041,
            message: "resource belongs to another Gateway client",
          },
        });
      }
      return;
    }
    if (
      request.method?.startsWith("terminal/") &&
      request.method !== "terminal/attach" &&
      requestedTerminalId &&
      this.liveTerminals.has(requestedTerminalId) &&
      !resourceOwner
    ) {
      if (request.id !== undefined) {
        client.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32041,
            message: "terminal must be attached before use",
          },
        });
      }
      return;
    }
    if (request.method === "turn/start") {
      const attachmentPaths = attachmentPathsFromTurn(request);
      const foreignAttachment = attachmentPaths.find((path) => {
        const owner = this.resourceOwners.get(`attachment\0${path}`);
        return owner && owner !== client;
      });
      if (foreignAttachment) {
        if (request.id !== undefined) {
          client.send({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32041,
              message: "attachment belongs to another Gateway client",
            },
          });
        }
        return;
      }
      for (const path of attachmentPaths) {
        const key = `attachment\0${path}`;
        if (
          !this.resourceOwners.has(key) &&
          this.persistentResources.has(key)
        ) {
          this.resourceOwners.set(key, client);
        }
      }
    }
    if (!request.method && request.id !== undefined) {
      const owner = this.serverRequests.get(request.id);
      if (!owner)
        throw new Error("unsolicited app-server response from Gateway client");
      if (owner !== client)
        throw new Error("server request belongs to another client");
      this.serverRequests.delete(request.id);
    }

    if (this.adapter.rawPassthrough) {
      this.forwardClientRequest(client, request);
      return;
    }
    const translated = this.adapter.toUpstream(request);
    for (const upstream of translated.upstream) {
      this.forwardClientRequest(client, upstream);
    }
    for (const response of translated.client) client.send(response);
  }

  rewriteClientRequest(client, message) {
    if (!message?.method || message.id === undefined) return message;
    const refreshTicket = message.method === HISTORY_REFRESH_METHOD
      ? this.historyRefresh.claim(client, message.params) : null;
    if (message.method === 'initialize') {
      message = { ...message, params: { ...message.params, capabilities: {
        ...message.params?.capabilities, experimental: {
          ...message.params?.capabilities?.experimental,
          projectAutomations: true,
          toolPathPreviewV1: true,
        },
      } } };
    }
    if (message.method === "browser/start") client.browserStarted = true;
    const upstreamId = this.nextRequestId++;
    const claimedThreadId =
      message.method === "thread/resume" ? threadIdFrom(message) : null;
    const claimedTerminalId =
      message.method === "terminal/attach"
        ? terminalSessionIdFrom(message)
        : null;
    if (claimedThreadId && !this.threadOwners.has(claimedThreadId)) {
      this.threadClaims.set(claimedThreadId, client);
    }
    if (claimedTerminalId) this.terminalClaims.set(claimedTerminalId, client);
    this.pending.set(upstreamId, {
      client,
      clientId: message.id,
      method: message.method,
      params: message.params,
      ...(message[MCP_OAUTH_RECEIVER] ? { oauthReceiver: message[MCP_OAUTH_RECEIVER] } : {}),
      ...(message[MCP_OAUTH_COMPLETION] ? { oauthCompletion: message[MCP_OAUTH_COMPLETION] } : {}),
      ...(refreshTicket ? { refreshTicket } : {}),
      ...(claimedThreadId ? { claimedThreadId } : {}),
      ...(claimedTerminalId ? { claimedTerminalId } : {}),
    });
    if (message.method === "initialize") this.initializePending = upstreamId;
    return cloneWithId(message, upstreamId);
  }

  forwardClientRequest(client, message) {
    if (message.method === HISTORY_REFRESH_METHOD) {
      const validId = typeof message.id === "string" ||
        (Number.isSafeInteger(message.id) && message.id >= 0);
      if (message.jsonrpc !== "2.0" || !validId) {
        client.send({ jsonrpc: "2.0", id: validId ? message.id : null,
          error: { code: -32600, message: "History refresh requires a valid JSON-RPC request" } });
        return;
      }
    }
    let upstream;
    try {
      upstream = this.rewriteClientRequest(client, message);
    } catch (error) {
      if (!(error instanceof HistoryRefreshRequestError)) throw error;
      client.send({ jsonrpc: "2.0", id: message.id,
        error: { code: error.code, message: error.message } });
      return;
    }
    try {
      this.writeMessage(upstream, client);
    } catch (error) {
      const pending = this.pending.get(upstream.id);
      if (pending?.refreshTicket) {
        this.pending.delete(upstream.id);
        this.historyRefresh.abortWrite(pending.refreshTicket);
      }
      throw error;
    }
  }

  sendRefreshCleanup(ticket) {
    if (!ticket) return;
    // Refresh is request-only in app-server. Track the internal response instead of sending
    // a notification that would be ignored or recursively cancelling a cancellation.
    const id = this.nextRequestId++;
    const message = { jsonrpc: "2.0", id, method: HISTORY_REFRESH_METHOD, params: ticket.params };
    this.pending.set(id, { client: null, clientId: null, method: message.method,
      params: message.params, refreshTicket: ticket });
    if (!this.safeWriteMessage(message)) {
      this.pending.delete(id);
      // Do not kill unrelated shared threads. A later explicit begin can replace the orphan.
      this.historyRefresh.complete(ticket, { error: { message: "refresh cleanup write failed" } });
    }
  }

  releaseThreadClaim(pending) {
    if (!pending.claimedThreadId) return;
    if (this.threadClaims.get(pending.claimedThreadId) === pending.client) {
      this.threadClaims.delete(pending.claimedThreadId);
    }
  }

  releaseTerminalClaim(pending) {
    if (!pending.claimedTerminalId) return;
    if (this.terminalClaims.get(pending.claimedTerminalId) === pending.client) {
      this.terminalClaims.delete(pending.claimedTerminalId);
    }
  }

  writeRaw(raw, client, resumePending) {
    if (Buffer.byteLength(raw) > this.maxMessageBytes) {
      throw new Error("Adapted app-server request is too large");
    }
    if (!this.child.stdin.writable || this.child.stdin.destroyed) {
      throw new Error("KCoder app-server stdin is closed");
    }
    if (
      this.child.stdin.writableLength + Buffer.byteLength(raw) + 1 >
      this.maxMessageBytes * 2
    ) {
      throw new Error("KCoder app-server stdin queue is full");
    }
    const resumeStartedAt = resumePending ? this.#lifecycleMetrics.timestamp() : undefined;
    const writable = this.child.stdin.write(`${raw}\n`);
    if (resumePending)
      resumePending.resumeStartedAt = this.#lifecycleMetrics.resumeStarted(resumeStartedAt);
    if (!writable && !this.stdinBackpressured) {
      this.stdinBackpressured = true;
      client?.pause();
      this.child.stdin.once("drain", () => {
        this.stdinBackpressured = false;
        for (const attached of this.clients) attached.resume();
      });
    }
  }

  writeMessage(message, client) {
    this.writeRaw(JSON.stringify(message), client,
      message.method === "thread/resume" ? this.pending.get(message.id) : undefined);
  }

  safeWriteMessage(message, client) {
    if (this.closed || !this.child.stdin.writable || this.child.stdin.destroyed)
      return false;
    try {
      this.writeMessage(message, client);
      return true;
    } catch {
      return false;
    }
  }

  processStdoutChunk(chunk) {
    let batch;
    try {
      batch = this.stdoutDecoder.push(chunk);
    } catch (error) {
      this.fail(error);
      return;
    }
    for (const dropped of batch.dropped) this.handleDroppedFrame(dropped);
    try {
      for (const line of batch.lines) this.processStdoutLine(line);
    } catch (error) {
      this.fail(error);
    }
  }

  handleDroppedFrame(dropped) {
    const preview = typeof dropped?.preview === "string" ? dropped.preview : "";
    const idMatch = preview.match(/"id"\s*:\s*(\d+)/);
    if (/"jsonrpc"\s*:\s*"2\.0"/.test(preview) && idMatch) {
      const id = Number(idMatch[1]);
      if (this.pending.has(id)) {
        // A single oversized response must not tear down every client sharing
        // this app-server: answer the owning request and keep the pool alive.
        this.routeServerMessage({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32045,
            message: "app-server response exceeded the frame limit",
          },
        });
        return;
      }
    }
    console.error("[KCoder] dropped oversized app-server frame", {
      serverId: this.serverId,
      bytes: dropped?.bytes,
    });
  }

  processStdoutLine(line) {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id === null && [-32700, -32600].includes(message.error?.code)) {
      // All forwarded frames were already parsed and assigned IDs here. An
      // unattributed rejection indicates a corrupted upstream protocol stream;
      // never leave clients waiting or replay potentially mutating requests.
      this.fail(new Error("KCoder app-server rejected a protocol frame; reconnect before retrying"));
      return;
    }
    const translated = this.adapter.fromUpstream(message);
    for (const upstream of translated.upstream) this.writeMessage(upstream);
    for (const clientMessage of translated.client)
      this.routeServerMessage(clientMessage);
  }

  routeServerMessage(message) {
    if (this.idleShutdown.response(message)) return;
    if (
      ["turn/completed", "turn/failed", "turn/interrupted"].includes(
        message.method,
      )
    ) {
      this.clearTerminalTurn(message);
    }
    if (message.id !== undefined && !message.method) {
      if (this.detachedRequestIds.delete(message.id)) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      this.#lifecycleMetrics.resumeFinished(pending.resumeStartedAt, !message.error);
      const response = cloneWithId(message, pending.clientId);
      if (pending.refreshTicket) {
        this.sendRefreshCleanup(this.historyRefresh.complete(pending.refreshTicket, response));
        if (this.clients.has(pending.client)) pending.client.send(response);
        return;
      }
      if (pending.method === "initialize") {
        this.#lifecycleMetrics.initialize(!response.error);
        if (pending.client) pending.client.initialized = !response.error;
        this.initializeResponse = cloneWithId(response, null);
        this.initializePending = null;
        const resident =
          response.result?.capabilities?.experimental?.residentThreads === true;
        this.shareability = resident ? "resident" : "legacy";
        this.resolveShareability?.(this.shareability);
        this.resolveShareability = null;
        const waiters = this.initializeWaiters.splice(0);
        for (const waiter of waiters) {
          if (!this.clients.has(waiter.client)) continue;
          if (resident) {
            waiter.client.initialized = !response.error;
            waiter.client.send(
              cloneWithId(this.initializeResponse, waiter.clientId),
            );
          } else {
            waiter.client.send({
              jsonrpc: "2.0",
              method: "server/transportError",
              params: {
                serverId: this.serverId,
                message: "legacy app-server requires a dedicated connection",
              },
            });
            waiter.client.close();
          }
        }
      }
      this.releaseThreadClaim(pending);
      if (pending.method === "turn/start" && pending.interruptOnResponse && response.error) {
        const rejectedThread = threadIdFrom({ params: pending.params });
        const drain = rejectedThread ? this.threadDrains.get(rejectedThread) : null;
        if (drain && !drain.turnId && !this.activeTurns.has(rejectedThread)) this.finishThreadDrain(rejectedThread);
      }
      if (pending.cleanupOnResponse) {
        this.compensateLateCreation(pending, response);
        return;
      }
      if (this.mcpOAuth.response(pending, response)) {
        if (!response.error) this.mcpFlowOwners.delete(pending.params?.flowId);
        else this.cancelMcpFlow(pending.params?.flowId);
        return;
      }
      if (!response.error && pending.method === "mcp/login" &&
          typeof response.result?.flowId === "string" && this.clients.has(pending.client)) {
        this.mcpFlowOwners.set(response.result.flowId, {
          client: pending.client, expiresAt: Date.now() + 600_000,
        });
      }
      if (!response.error && ["mcp/callback", "mcp/cancel"].includes(pending.method)) {
        this.mcpFlowOwners.delete(pending.params?.flowId);
      }
      const threadId =
        threadIdFrom(response.result) ??
        threadIdFrom({ params: pending.params });
      if (
        !response.error &&
        threadId &&
        (["thread/start", "thread/resume"].includes(pending.method) ||
          (pending.method === "thread/fork" && response.result?.ephemeral === true))
      ) {
        this.threadOwners.set(threadId, pending.client);
        if (pending.method === "thread/fork" && response.result?.ephemeral === true) {
          this.ephemeralThreadOwners.set(threadId, pending.client);
        }
      }
      if (
        !response.error &&
        threadId &&
        ["thread/delete", "thread/dispose"].includes(pending.method) &&
        this.threadOwners.get(threadId) === pending.client
      ) {
        this.threadOwners.delete(threadId);
        this.ephemeralThreadOwners.delete(threadId);
      }
      if (!response.error && threadId && pending.method === "turn/start") {
        const turnId = turnIdFrom(response.result);
        if (turnId && pending.interruptOnResponse) {
          this.beginThreadDrain(threadId, turnId);
          this.safeWriteMessage({
            jsonrpc: "2.0",
            method: "turn/interrupt",
            params: { threadId, turnId },
          });
        } else if (turnId && pending.client) {
          this.activeTurns.set(threadId, { owner: pending.client, turnId });
        }
      }
      this.bindCreatedResource(pending, response);
      this.releaseTerminalClaim(pending);
      this.promoteReferencedAttachments(pending, response);
      if (this.clients.has(pending.client)) pending.client.send(response);
      if (
        !response.error &&
        pending.method === "runtime.workspaces.remove" &&
        response.result?.accepted !== false
      ) {
        this.onWorkspaceRemoved?.(pending.params);
      }
      return;
    }

    if (message.method === 'automation/stateChanged' && message.id === undefined) {
      const { jobCount, pendingCount } = message.params ?? {};
      if (Number.isSafeInteger(jobCount) && jobCount >= 0 && Number.isSafeInteger(pendingCount) && pendingCount >= 0) {
        this.projectAutomationJobCount = jobCount;
        this.projectAutomationPendingCount = pendingCount;
        this.onIdleStateChange?.(this);
      }
      return;
    }
    if (message.method === 'automation/runStarted' && message.id === undefined) {
      const threadId = threadIdFrom(message);
      if (threadId) {
        this.automationThreads.add(threadId);
        this.activeAutomationThreads.add(threadId);
        this.onIdleStateChange?.(this);
        while (this.automationThreads.size > 2048) this.automationThreads.delete(this.automationThreads.values().next().value);
        this.broadcast(message);
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      const owner = this.ownerFor(message) ?? (this.automationThreads.has(threadIdFrom(message))
        ? [...this.clients].find(client => client.channel === 'runtime' && client.initialized) : null);
      if (!owner) {
        this.safeWriteMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32040,
            message: `app-server request has no connected owner: ${message.method}`,
          },
        });
        return;
      }
      this.serverRequests.set(message.id, owner);
      owner.send(message);
      return;
    }
    if (message.method === 'turn/completed' && this.activeAutomationThreads.delete(threadIdFrom(message))) {
      this.onIdleStateChange?.(this);
    }
    const owner = this.ownerFor(message);
    if (owner) this.sendServerNotification(owner, message);
    else if (this.automationThreads.has(threadIdFrom(message))) this.broadcast(message);
    else if (!threadIdFrom(message) && !this.resourceKeyFrom(message))
      this.broadcast(message);
    if (message.method === "terminal/exit") {
      const sessionId = terminalSessionIdFrom(message);
      if (sessionId) {
        this.exitedTerminalIds.add(sessionId);
        while (this.exitedTerminalIds.size > 1_024) {
          this.exitedTerminalIds.delete(
            this.exitedTerminalIds.values().next().value,
          );
        }
        this.forgetTerminal(sessionId);
      }
    }
  }

  ownerFor(message) {
    const threadId = threadIdFrom(message);
    const owner = threadId ? this.threadOwners.get(threadId) : null;
    if (owner && this.clients.has(owner)) return owner;
    const resourceKey = this.resourceKeyFrom(message);
    const sessionId = message?.method?.startsWith("terminal/")
      ? terminalSessionIdFrom(message)
      : null;
    const resourceOwner = resourceKey
      ? (this.resourceOwners.get(resourceKey) ??
        (sessionId ? this.terminalClaims.get(sessionId) : null))
      : null;
    return resourceOwner && this.clients.has(resourceOwner)
      ? resourceOwner
      : null;
  }

  clearTerminalTurn(message) {
    const threadId = threadIdFrom(message);
    const turnId = turnIdFrom(message);
    if (threadId) {
      const active = this.activeTurns.get(threadId);
      if (active && (!turnId || active.turnId === turnId))
        this.activeTurns.delete(threadId);
      const drain = this.threadDrains.get(threadId);
      if (drain && (!turnId || !drain.turnId || drain.turnId === turnId)) {
        this.finishThreadDrain(threadId);
      }
      return;
    }
    if (!turnId) return;
    for (const [activeThreadId, active] of this.activeTurns) {
      if (active.turnId === turnId) this.activeTurns.delete(activeThreadId);
    }
    for (const [drainingThreadId, drain] of this.threadDrains) {
      if (drain.turnId === turnId) this.finishThreadDrain(drainingThreadId);
    }
  }

  beginThreadDrain(threadId, turnId = null) {
    if (!threadId) return;
    const existing = this.threadDrains.get(threadId);
    if (existing) {
      if (turnId) existing.turnId = turnId;
      return;
    }
    const drain = {
      turnId,
      queue: [],
      timer: setTimeout(
        () => this.finishThreadDrain(threadId, false),
        THREAD_DRAIN_TIMEOUT_MS,
      ),
    };
    drain.done = new Promise(resolve => { drain.resolveDone = resolve; });
    drain.timer.unref?.();
    this.threadDrains.set(threadId, drain);
  }

  finishThreadDrain(threadId, completed = true) {
    const drain = this.threadDrains.get(threadId);
    if (!drain) return;
    clearTimeout(drain.timer);
    drain.resolveDone?.(completed);
    const queue = drain.queue.splice(0);
    if (!completed) {
      // A waiting deadline is not evidence that the upstream turn has stopped.
      drain.timedOut = true;
      for (const entry of queue) {
        if (this.clients.has(entry.client)) this.rejectUnconfirmedDrain(entry.client, entry.id);
      }
      return;
    }
    this.threadDrains.delete(threadId);
    for (const entry of queue) {
      if (!this.clients.has(entry.client)) continue;
      queueMicrotask(() => {
        if (this.clients.has(entry.client))
          this.receive(entry.client, entry.raw);
      });
    }
  }

  rejectUnconfirmedDrain(client, id) {
    client.send({ jsonrpc: "2.0", id, error: {
      code: -32043, message: "Unable to confirm the previous turn has stopped; retry after its terminal event",
    } });
  }

  resourceKeyFrom(message) {
    const params = message?.params ?? message;
    if (!params || typeof params !== "object") return null;
    const method = String(message?.method ?? "");
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
      (method.startsWith("browser/") ? params.session_id : null) ??
      params.browser?.id ??
      params.session?.id;
    if (typeof browserId === "string") return `browser\0${browserId}`;
    return null;
  }

  bindCreatedResource(pending, response) {
    if (response.error) {
      if (pending.method === "browser/start" && pending.client) pending.client.browserStarted = false;
      if (pending.method === "attachment/upload/finish") {
        const uploadKey = this.resourceKeyFrom({
          method: pending.method,
          params: pending.params,
        });
        if (uploadKey) this.resourceOwners.delete(uploadKey);
      }
      return;
    }
    const result = response.result;
    if (pending.method.startsWith('cron/')) {
      if (Number.isSafeInteger(result?.jobCount) && result.jobCount >= 0) this.projectAutomationJobCount = result.jobCount;
      else if (Array.isArray(result?.jobs)) this.projectAutomationJobCount = result.jobs.length;
      else if (result?.job) this.projectAutomationJobCount = Math.max(1, this.projectAutomationJobCount);
      this.onIdleStateChange?.(this);
    }
    if (pending.method === "terminal/start") {
      const id = terminalSessionIdFrom(result);
      if (id) {
        if (this.exitedTerminalIds.delete(id)) return;
        const wasLive = this.liveTerminals.has(id);
        this.liveTerminals.add(id);
        this.resourceOwners.set(`terminal\0${id}`, pending.client);
        if (!wasLive) this.onIdleStateChange?.(this);
      }
    }
    if (pending.method === "terminal/attach") {
      const id = terminalSessionIdFrom(result) ?? pending.claimedTerminalId;
      if (id && pending.client) {
        if (this.exitedTerminalIds.delete(id)) return;
        const wasLive = this.liveTerminals.has(id);
        this.liveTerminals.add(id);
        this.resourceOwners.set(`terminal\0${id}`, pending.client);
        if (!wasLive) this.onIdleStateChange?.(this);
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
        this.resourceOwners.set(`browser\0${id}`, pending.client);
    }
    if (
      pending.method === "attachment/save" &&
      typeof result?.path === "string"
    ) {
      this.resourceOwners.set(`attachment\0${result.path}`, pending.client);
    }
    if (
      pending.method === "attachment/upload/start" &&
      typeof result?.upload_id === "string"
    ) {
      this.resourceOwners.set(
        `attachment-upload\0${result.upload_id}`,
        pending.client,
      );
    }
    if (
      pending.method === "attachment/upload/finish" &&
      typeof result?.path === "string"
    ) {
      const uploadKey = this.resourceKeyFrom({
        method: pending.method,
        params: pending.params,
      });
      if (uploadKey) this.resourceOwners.delete(uploadKey);
      this.resourceOwners.set(`attachment\0${result.path}`, pending.client);
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
      const key = this.resourceKeyFrom({
        method: pending.method,
        params: pending.params,
      });
      const closedOwnBrowser = pending.method === "browser/close" && key && this.resourceOwners.get(key) === pending.client;
      if (key) {
        this.resourceOwners.delete(key);
        this.persistentResources.delete(key);
        this.materializedAttachments.delete(key);
      }
      if (pending.method === "terminal/close") {
        const sessionId = terminalSessionIdFrom({
          method: pending.method,
          params: pending.params,
        });
        if (sessionId) this.forgetTerminal(sessionId);
      }
      if (closedOwnBrowser && pending.client) pending.client.browserStarted = false;
    }
  }

  forgetTerminal(sessionId) {
    const wasLive = this.liveTerminals.delete(sessionId);
    this.resourceOwners.delete(`terminal\0${sessionId}`);
    this.terminalClaims.delete(sessionId);
    if (wasLive) this.onIdleStateChange?.(this);
  }

  cancelMcpFlow(flowId) {
    const id = this.nextRequestId++;
    const message = { jsonrpc: "2.0", id, method: "mcp/cancel", params: { flowId } };
    this.pending.set(id, { client: null, clientId: null, method: message.method, params: message.params });
    if (!this.safeWriteMessage(message)) this.pending.delete(id);
  }

  compensateLateCreation(pending, response) {
    if (response.error) return;
    if (pending.method === "mcp/login") {
      if (typeof response.result?.flowId === "string") this.cancelMcpFlow(response.result.flowId);
      return;
    }
    const result = response.result;
    if (["thread/start", "thread/fork"].includes(pending.method)) {
      const threadId = threadIdFrom(result);
      if (threadId) {
        this.safeWriteMessage({
          jsonrpc: "2.0",
          method: result?.ephemeral === true ? "thread/dispose" : "thread/delete",
          params: { threadId },
        });
      }
      return;
    }
    if (pending.method === "terminal/start") {
      const sessionId = terminalSessionIdFrom(result);
      if (sessionId) {
        this.safeWriteMessage({
          jsonrpc: "2.0",
          method: "terminal/close",
          params: { session_id: sessionId },
        });
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
        this.safeWriteMessage({
          jsonrpc: "2.0",
          method: "browser/close",
          params: { session_id: sessionId },
        });
      }
      return;
    }
    if (
      pending.method === "attachment/save" &&
      typeof result?.path === "string"
    ) {
      this.safeWriteMessage({
        jsonrpc: "2.0",
        method: "attachment/delete",
        params: { path: result.path },
      });
    }
    if (
      pending.method === "attachment/upload/start" &&
      typeof result?.upload_id === "string"
    ) {
      this.safeWriteMessage({
        jsonrpc: "2.0",
        method: "attachment/upload/cancel",
        params: { upload_id: result.upload_id },
      });
    }
    if (
      pending.method === "attachment/upload/finish" &&
      typeof result?.path === "string"
    ) {
      this.safeWriteMessage({
        jsonrpc: "2.0",
        method: "attachment/delete",
        params: { path: result.path },
      });
    }
  }

  promoteReferencedAttachments(pending, response) {
    if (response.error || pending.method !== "turn/start") return;
    const paths = new Set(attachmentPathsFromTurn({ params: pending.params }));
    const threadId = threadIdFrom({ params: pending.params });
    for (const [key, owner] of this.resourceOwners) {
      if (owner !== pending.client || !key.startsWith("attachment\0")) continue;
      const path = key.slice("attachment\0".length);
      if (threadId && paths.has(path)) {
        this.persistentResources.add(key);
        this.materializedAttachments.set(key, threadId);
      }
    }
  }

  sendServerNotification(client, message) {
    if (message.method === "item/event" && message.params?.event?.type === "tool_path_preview") {
      if (!client.initialized || client.channel !== "runtime" || client.toolPathPreviewV1 !== true
        || this.initializeResponse?.result?.capabilities?.experimental?.toolPathPreviewV1 !== true) return;
    }
    client.send(message);
  }

  broadcast(message) {
    for (const client of this.clients) this.sendServerNotification(client, message);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.resolveShareability?.("closed");
    this.resolveShareability = null;
    this.broadcast({
      jsonrpc: "2.0",
      method: "server/transportError",
      params: {
        serverId: this.serverId,
        message: error instanceof Error ? error.message : String(error),
        // Account authentication failures carry a dedicated flag so the
        // login endpoint can answer 401 with actionable guidance instead of
        // the generic transport message.
        ...(error?.authenticationRejected === true ? { authenticationRejected: true } : {}),
      },
    });
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.clearTransientState();
    if (this.child.stdin.writable && !this.child.stdin.destroyed) {
      try {
        this.child.stdin.end();
      } catch {}
    }
    this.onClose?.(this);
    this.#finishLifecycleMetrics();
  }

  #finishLifecycleMetrics() {
    if (!this.#lifecycleMetrics.close()) return;
    try {
      this.#onLifecycleMetrics?.(this.#lifecycleMetrics.snapshot());
    } catch {
      // Diagnostics must never change transport cleanup or client behavior.
    }
  }
}
