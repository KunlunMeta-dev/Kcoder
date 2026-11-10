import { parseRetentionAdmission, RETENTION_CAPABILITY, type RetentionUploadAdmissionV1 } from "@/protocol/attachment-retention";
import { ensureGatewayAuthorization } from "./http";
import { ThreadRuntimeHandoffClient, THREAD_RUNTIME_HANDOFF_CAPABILITY } from '../../../shared/threadRuntimeHandoff.mjs';
import { isGatewayUnknownOutcome } from "../../../shared/gatewayRequestDeadline.js";
import { gatewayConnectionBudget } from '../../../shared/gatewayConnectionBudget';
import { Platform } from "react-native";
import { t } from "@/i18n";
import { getMobileClientVersion } from "@/runtime/mobile-client-version";
import type { GatewayProfile, KCoderServer } from "./types";
import { invalidateGatewayRoute, resolveGatewayRoute } from "./connection-routes";
import {
  createPeerSocket,
  isPeerTransportAlive,
  isPeerTransportUrl,
} from "./peer-transport";

export type JsonRecord = Record<string, unknown>;

export interface RpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: JsonRecord;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

type MessageListener = (message: RpcMessage) => void;

export interface GatewayConnectOptions {
  signal?: AbortSignal;
  priority?: "foreground" | "background";
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface InitializeResult {
  attachmentUploadAdmission?: unknown;
  protocolVersion?: string;
  sessionId?: string;
  capabilities?: GatewayServerCapabilities;
}

const KCODER_APP_SERVER_PROTOCOL_VERSION = "2026-07-27";

export interface GatewayServerCapabilities {
  readonly approvals?: boolean;
  readonly questions?: boolean;
  readonly threadResume?: boolean;
  readonly experimental?: Readonly<Record<string, boolean>>;
}

type NativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

export function buildGatewayRpcUrl(
  profile: GatewayProfile,
  server: KCoderServer,
  workspacePath?: string,
  channel: "runtime" | "browser" = "runtime",
  transportBaseUrl = profile.baseUrl,
): string {
  const url = new URL(transportBaseUrl);
  if (!isPeerTransportUrl(transportBaseUrl)) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/rpc`;
  url.search = "";
  url.searchParams.set("token", profile.rpcToken);
  url.searchParams.set("server", server.id);
  url.searchParams.set("channel", channel);
  if (workspacePath) url.searchParams.set("workspace", workspacePath);
  return url.toString();
}

export class MobileRpcError extends Error {
  constructor(
    message: string,
    readonly code = -1,
    readonly reason: "transport" | "remote" | "protocol" = "transport",
    readonly delivery: "not-sent" | "unknown" = "unknown",
  ) {
    super(message); this.name = 'MobileRpcError';
  }
}

function retainedConnectionOwner(profile: GatewayProfile, server: KCoderServer, workspacePath: string | undefined, channel: "runtime" | "browser"): string {
  return JSON.stringify([profile.id, profile.baseUrl, profile.authorizationGeneration ?? `legacy:${profile.id}`, profile.deviceId,
    server.id, server.runtime, server.transport, [server.workspacePath === undefined ? "absent" : "value", server.workspacePath ?? ""],
    server.host, server.user, server.port, server.command, server.profile, server.settingsFile, server.accountIdentity?.principalId, server.accountIdentity?.username, server.accountIdentity?.role,
    server.chromiumBin, server.chromiumNoSandbox, server.acceptNewHostKey,
    [workspacePath === undefined ? "absent" : "value", workspacePath ?? ""], channel]);
}

export class GatewayRpcClient {
  private socket: WebSocket | null = null;
  private selectedTransportUrl: string | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<MessageListener>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private cancelOpening: (() => void) | null = null;
  private experimentalCapabilities: Record<string, boolean> = {};
  private threadResumeCapability = false;
  private appServerId: string | null = null;
  private serverCapabilities: GatewayServerCapabilities | undefined;
  private attachmentAdmission: RetentionUploadAdmissionV1 | undefined;
  private readonly retainedOwner: string;

  private constructor(
    private readonly profile: GatewayProfile,
    private readonly server: KCoderServer,
    private readonly workspacePath?: string,
    private readonly channel: "runtime" | "browser" = "runtime",
  ) { this.retainedOwner = retainedConnectionOwner(profile, server, workspacePath, channel); }

  /** Exact local connection owner; no credential or private server scope is exposed. */
  matchesRetainedAttachmentOwner(profile: GatewayProfile, server: KCoderServer, workspacePath?: string): boolean {
    return !this.closed && this.socket?.readyState === 1 && this.channel === "runtime" &&
      this.retainedOwner === retainedConnectionOwner(profile, server, workspacePath, "runtime");
  }

  /** Generic current runtime owner for finite native controls. */
  matchesRuntimeOwner(profile: GatewayProfile, server: KCoderServer, workspacePath: string): boolean {
    return this.matchesRetainedAttachmentOwner(profile, server, workspacePath);
  }

  static connect(profile: GatewayProfile, server: KCoderServer, workspacePath?: string,
    channel: 'runtime' | 'browser' = 'runtime', options: GatewayConnectOptions = {}): Promise<GatewayRpcClient> {
    return gatewayConnectionBudget.run(async () => { await ensureGatewayAuthorization(profile); return GatewayRpcClient.connectAdmitted(profile, server, workspacePath, channel, options.signal); }, options.signal, options.priority);
  }

  private static async connectAdmitted(
    profile: GatewayProfile,
    server: KCoderServer,
    workspacePath?: string,
    channel: "runtime" | "browser" = "runtime",
    signal?: AbortSignal,
  ): Promise<GatewayRpcClient> {
    const client = new GatewayRpcClient(profile, server, workspacePath, channel);
    const cancel = () => client.close();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) throw new Error("Gateway connection cancelled");
      await client.open(signal);
      const initialized = await client.request<InitializeResult>("initialize", {
        protocolVersion: KCODER_APP_SERVER_PROTOCOL_VERSION,
        clientInfo: { name: "kcoder-studio-mobile", version: getMobileClientVersion().value ?? "unknown" },
        capabilities: { experimental: { webSearchStatusV1: true, webSearchProbeV1: true, gatewaySharedThreadsV1: true, integrationScopeV1: true, officeSettingsV1: true, officeWorkspaceV1: true, agentDefinitionsV1: true, agentTurnConfigurationV1: true, remoteOperationControlV1: true, threadTranscriptSnapshotV1: true, threadTranscriptObservationV1: true, threadRunSummaryV1: true, threadPresenceReadV1: true, [THREAD_RUNTIME_HANDOFF_CAPABILITY]: true, workspaceBinaryRevisionV1: true, workspaceOperationReceiptsV1: true, workspaceOperationReceiptsV2: true, interactionStatusReadV1: true, migrationHistoryWorkerStateClientV1: true, asyncUserQuestionsV1: true, [RETENTION_CAPABILITY]: true } },
      });
      if (initialized.protocolVersion !== KCODER_APP_SERVER_PROTOCOL_VERSION) {
        throw new Error(`KCoder app-server 协议不兼容：${initialized.protocolVersion ?? "unknown"}`);
      }
      client.appServerId = typeof initialized.sessionId === "string" && initialized.sessionId.length > 0
        ? `server-${initialized.sessionId}`
        : null;
      client.experimentalCapabilities = { ...(initialized.capabilities?.experimental ?? {}) };
      client.threadResumeCapability = initialized.capabilities?.threadResume === true;
      client.serverCapabilities = initialized.capabilities
        ? {
            ...initialized.capabilities,
            ...(initialized.capabilities.experimental
              ? { experimental: { ...initialized.capabilities.experimental } }
              : {}),
          }
        : undefined;
      if (client.supportsExperimental(RETENTION_CAPABILITY)) {
        try { client.attachmentAdmission = parseRetentionAdmission(initialized.attachmentUploadAdmission); }
        catch { /* Malformed optional admission never permits a retained upload. */ }
      }
      client.send({ jsonrpc: "2.0", method: "initialized" });
      return client;
    } catch (error) {
      client.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  supportsThreadResume(): boolean {
    return this.threadResumeCapability;
  }

  /** App-server identity from initialize; distinct from the Gateway target ID. */
  getAppServerId(): string | null {
    return this.appServerId;
  }

  supportsExperimental(capability: string): boolean {
    return this.experimentalCapabilities[capability] === true;
  }

  runtimeHandoff(): ThreadRuntimeHandoffClient {
    return new ThreadRuntimeHandoffClient({
      request: (method, params) => this.request(method, params),
      supported: () => !this.closed && this.socket?.readyState === 1
        && this.retainedOwner === retainedConnectionOwner(this.profile,this.server,this.workspacePath,this.channel)
        && this.supportsExperimental(THREAD_RUNTIME_HANDOFF_CAPABILITY),
      ownerStamp: () => this.socket,
    });
  }

  isTransportOpen(): boolean {
    return !this.closed && this.socket?.readyState === WebSocket.OPEN;
  }

  /** A read-only snapshot of the app-server initialize capabilities; credentials and owner data are excluded. */
  getCapabilities(): GatewayServerCapabilities | undefined {
    if (!this.serverCapabilities) return undefined;
    const snapshot = {
      ...this.serverCapabilities,
      ...(this.serverCapabilities.experimental
        ? { experimental: Object.freeze({ ...this.serverCapabilities.experimental }) }
        : {}),
    };
    return Object.freeze(snapshot);
  }

  getAttachmentUploadAdmission(): RetentionUploadAdmissionV1 | undefined {
    if (this.closed || this.socket?.readyState !== 1 || !this.supportsExperimental(RETENTION_CAPABILITY)) return undefined;
    return this.attachmentAdmission ? { ...this.attachmentAdmission } : undefined;
  }

  subscribe(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to an unexpected transport close. Owner-initiated close stays silent. */
  subscribeClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  request<T = unknown>(method: string, params: JsonRecord = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MobileRpcError(`RPC ${method} 等待 ${timeoutMs}ms 后超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  respond(id: number, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  close(): void {
    if (this.closed && !this.socket) return;
    this.closed = true;
    this.closeListeners.clear();
    this.serverCapabilities = undefined;
    this.attachmentAdmission = undefined;
    let closeError: unknown;
    let closeFailed = false;
    try {
      const socket = this.socket, cancelOpening = this.cancelOpening;
      if (cancelOpening) cancelOpening(); else socket?.close();
      this.socket = null;
    }
    catch (error) { closeFailed = true; closeError = error; }
    const error = new MobileRpcError("RPC 连接已关闭");
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
    if (closeFailed) throw closeError;
  }

  private async open(signal?: AbortSignal): Promise<void> {
    const selectedUrl = await resolveGatewayRoute(this.profile, { signal });
    if (signal?.aborted) throw new Error("Gateway connection cancelled");
    if (this.closed || this.retainedOwner !== retainedConnectionOwner(this.profile, this.server, this.workspacePath, this.channel))
      throw new Error("Gateway connection scope changed before connect");
    this.selectedTransportUrl = selectedUrl;
    const url = buildGatewayRpcUrl(this.profile, this.server, this.workspacePath, this.channel, selectedUrl);
    const Socket = WebSocket as unknown as NativeWebSocketConstructor;
    const protocols = Platform.OS === "web"
      ? ["kcoder-studio", `kcoder-session.${this.profile.accessToken}`]
      : undefined;
    const headers = Platform.OS === "web"
      ? undefined
      : { Authorization: `Bearer ${this.profile.accessToken}` };
    let socket: WebSocket;
    try {
      socket = isPeerTransportUrl(selectedUrl)
        ? createPeerSocket(url, protocols, headers) as unknown as WebSocket
        : Platform.OS === "web"
          ? new Socket(url, protocols)
          : new Socket(url, null, { headers: headers! });
    } catch (error) {
      if (!isPeerTransportUrl(selectedUrl) || !isPeerTransportAlive(selectedUrl))
        invalidateGatewayRoute(this.profile, selectedUrl);
      this.selectedTransportUrl = undefined;
      throw error;
    }
    this.socket = socket;
    try {
      await new Promise<void>((resolve, reject) => {
        let opened = false;
        const clearOpening = () => { this.cancelOpening = null; clearTimeout(timer); };
        const timer = setTimeout(() => {
          this.cancelOpening = null;
          socket.close();
          reject(new Error("连接 KCoder app-server 超时"));
        }, 12_000);
        this.cancelOpening = () => {
          this.cancelOpening = null;
          reject(new Error("Gateway connection cancelled"));
          if (Platform.OS === "web" && !isPeerTransportUrl(selectedUrl) && socket.readyState === 0) {
            // Browsers warn when close() aborts an HTTP Upgrade. Release the RPC
            // owner immediately, then close on open/error within the original budget.
            socket.onmessage = null;
            socket.onopen = () => { clearOpening(); socket.onopen = null; socket.close(); };
            socket.onerror = () => { clearOpening(); };
            socket.onclose = () => { clearOpening(); };
          } else { clearOpening(); socket.close(); }
        };
        socket.onopen = () => {
          opened = true;
          clearOpening();
          resolve();
        };
        socket.onerror = () => {
          clearOpening();
          reject(new Error("无法连接 KCoder app-server"));
        };
        socket.onclose = () => {
          clearOpening();
          if (!opened) reject(new Error("无法连接 KCoder app-server"));
          this.handleClose();
        };
        socket.onmessage = (event) => this.handleMessage(String(event.data));
      });
    } catch (error) {
      if (!this.closed && !signal?.aborted && (!isPeerTransportUrl(selectedUrl) || !isPeerTransportAlive(selectedUrl)))
        invalidateGatewayRoute(this.profile, selectedUrl);
      this.selectedTransportUrl = undefined;
      throw error;
    }
  }

  private send(message: RpcMessage): void {
    if (this.closed) throw new MobileRpcError("RPC 连接已关闭", -1, "transport", "not-sent");
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new MobileRpcError(
        "RPC 连接尚未就绪",
        -1,
        "transport",
        "not-sent",
      );
    }
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      throw new MobileRpcError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private handleMessage(raw: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(raw) as RpcMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number" && !message.method) {
      const request = this.pending.get(message.id);
      if (request) {
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) {
          const shared = message.error.data as { gatewaySharedThreadsV1?: { kind?: string } } | undefined;
          const messageText = shared?.gatewaySharedThreadsV1?.kind === 'turn_busy'
            ? t('task.shared_turn_busy') : message.error.message || "RPC 请求失败";
          request.reject(new MobileRpcError(messageText, isGatewayUnknownOutcome(message.error.data) ? -1 : message.error.code ?? -1, isGatewayUnknownOutcome(message.error.data) ? "transport" : "remote"));
        }
        else request.resolve(message.result);
      }
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.selectedTransportUrl &&
        (!isPeerTransportUrl(this.selectedTransportUrl) || !isPeerTransportAlive(this.selectedTransportUrl)))
      invalidateGatewayRoute(this.profile, this.selectedTransportUrl);
    this.selectedTransportUrl = undefined;
    this.socket = null;
    this.serverCapabilities = undefined;
    const error = new MobileRpcError("与 KCoder app-server 的连接已断开");
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
    for (const listener of [...this.closeListeners]) {
      try {
        listener();
      } catch {
        // A client lifecycle observer cannot interrupt transport cleanup.
      }
    }
    this.closeListeners.clear();
    for (const listener of this.listeners) {
      listener({ method: "connection/closed", params: { reason: error.message } });
    }
  }
}
