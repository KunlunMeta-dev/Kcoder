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

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface InitializeResult {
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
  url.pathname = "/rpc";
  url.search = "";
  url.searchParams.set("token", profile.rpcToken);
  url.searchParams.set("server", server.id);
  url.searchParams.set("channel", channel);
  if (workspacePath) url.searchParams.set("workspace", workspacePath);
  return url.toString();
}

export class GatewayRpcClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<MessageListener>();
  private closed = false;
  private experimentalCapabilities: Record<string, boolean> = {};
  private threadResumeCapability = false;

  private constructor(
    private readonly profile: GatewayProfile,
    private readonly server: KCoderServer,
    private readonly workspacePath?: string,
    private readonly channel: "runtime" | "browser" = "runtime",
  ) {}

  static async connect(
    profile: GatewayProfile,
    server: KCoderServer,
    workspacePath?: string,
    channel: "runtime" | "browser" = "runtime",
  ): Promise<GatewayRpcClient> {
    const client = new GatewayRpcClient(profile, server, workspacePath, channel);
    try {
      await client.open();
      const initialized = await client.request<InitializeResult>("initialize", {
        protocolVersion: KCODER_APP_SERVER_PROTOCOL_VERSION,
        clientInfo: { name: "kcoder-studio-mobile", version: "0.1.0" },
      });
      if (initialized.protocolVersion !== KCODER_APP_SERVER_PROTOCOL_VERSION) {
        throw new Error(`KCoder app-server 协议不兼容：${initialized.protocolVersion ?? "unknown"}`);
      }
      client.experimentalCapabilities = initialized.capabilities?.experimental ?? {};
      client.threadResumeCapability = initialized.capabilities?.threadResume === true;
      client.send({ jsonrpc: "2.0", method: "initialized" });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  supportsThreadResume(): boolean {
    return this.threadResumeCapability;
  }

  supportsExperimental(capability: string): boolean {
    return this.experimentalCapabilities[capability] === true;
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
        reject(new Error(`RPC ${method} 等待 ${timeoutMs}ms 后超时`));
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
    if (this.closed) return;
    this.closed = true;
    this.socket?.close();
    this.socket = null;
    const error = new Error("RPC 连接已关闭");
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("RPC 连接尚未就绪");
    }
    this.socket.send(JSON.stringify(message));
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
        if (message.error) request.reject(new Error(message.error.message || "RPC 请求失败"));
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
    const error = new Error("与 KCoder app-server 的连接已断开");
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
