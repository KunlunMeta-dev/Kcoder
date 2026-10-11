import { parseRetentionAdmission, RETENTION_CAPABILITY, type RetentionUploadAdmissionV1 } from "@/protocol/attachment-retention";
import { ensureGatewayAuthorization } from "./http";
import { isGatewayUnknownOutcome } from "../../../shared/gatewayRequestDeadline.js";
import { gatewayConnectionBudget } from '../../../shared/gatewayConnectionBudget';
import { Platform } from "react-native";
import type { GatewayProfile, KCoderServer } from "./types";

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
  capabilities?: {
    threadResume?: boolean;
    experimental?: Record<string, boolean>;
  };
}

const KCODER_APP_SERVER_PROTOCOL_VERSION = "2026-07-27";

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
): string {
  const url = new URL(profile.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
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
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<MessageListener>();
  private closed = false;
  private experimentalCapabilities: Record<string, boolean> = {};
  private threadResumeCapability = false;
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
      await client.open();
      const initialized = await client.request<InitializeResult>("initialize", {
        protocolVersion: KCODER_APP_SERVER_PROTOCOL_VERSION,
        clientInfo: { name: "kcoder-studio-mobile", version: "0.1.0" },
        capabilities: { experimental: { threadRunSummaryV1: true, workspaceBinaryRevisionV1: true, workspaceOperationReceiptsV1: true, workspaceOperationReceiptsV2: true, [RETENTION_CAPABILITY]: true } },
      });
      if (initialized.protocolVersion !== KCODER_APP_SERVER_PROTOCOL_VERSION) {
        throw new Error(`KCoder app-server 协议不兼容：${initialized.protocolVersion ?? "unknown"}`);
      }
      client.experimentalCapabilities = initialized.capabilities?.experimental ?? {};
      client.threadResumeCapability = initialized.capabilities?.threadResume === true;
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

  supportsExperimental(capability: string): boolean {
    return this.experimentalCapabilities[capability] === true;
  }

  getAttachmentUploadAdmission(): RetentionUploadAdmissionV1 | undefined {
    if (this.closed || this.socket?.readyState !== 1 || !this.supportsExperimental(RETENTION_CAPABILITY)) return undefined;
    return this.attachmentAdmission ? { ...this.attachmentAdmission } : undefined;
  }

  subscribe(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    this.attachmentAdmission = undefined;
    let closeError: unknown;
    let closeFailed = false;
    try { this.socket?.close(); this.socket = null; }
    catch (error) { closeFailed = true; closeError = error; }
    const error = new MobileRpcError("RPC 连接已关闭");
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
    if (closeFailed) throw closeError;
  }

  private async open(): Promise<void> {
    const url = buildGatewayRpcUrl(this.profile, this.server, this.workspacePath, this.channel);
    const Socket = WebSocket as unknown as NativeWebSocketConstructor;
    const socket =
      Platform.OS === "web"
        ? new Socket(url, ["kcoder-studio", `kcoder-session.${this.profile.accessToken}`])
        : new Socket(url, null, {
            headers: { Authorization: `Bearer ${this.profile.accessToken}` },
          });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("连接 KCoder app-server 超时"));
      }, 12_000);
      socket.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("无法连接 KCoder app-server"));
      };
      socket.onclose = () => {
        clearTimeout(timer);
        if (!opened) reject(new Error("无法连接 KCoder app-server"));
        this.handleClose();
      };
      socket.onmessage = (event) => this.handleMessage(String(event.data));
    });
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
        if (message.error) request.reject(new MobileRpcError(message.error.message || "RPC 请求失败", isGatewayUnknownOutcome(message.error.data) ? -1 : message.error.code ?? -1, isGatewayUnknownOutcome(message.error.data) ? "transport" : "remote"));
        else request.resolve(message.result);
      }
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket = null;
    const error = new MobileRpcError("与 KCoder app-server 的连接已断开");
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
    for (const listener of this.listeners) {
      listener({ method: "connection/closed", params: { reason: error.message } });
    }
  }
}
