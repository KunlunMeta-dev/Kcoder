import { type JsonRecord, type RpcMessage } from "@/gateway/rpc";
import { TaskRuntime } from "./core";
import { TaskTerminalSession } from "./terminalLeases";

export function isDisposed(this: TaskRuntime): boolean {
  return this.disposed;
}

export function subscribeProtocol(
  this: TaskRuntime,
  listener: (message: RpcMessage) => void,
): () => void {
  this.protocolListeners.add(listener);
  return () => this.protocolListeners.delete(listener);
}

export function request<T = unknown>(
  this: TaskRuntime,
  method: string,
  params?: JsonRecord,
  timeoutMs?: number,
): Promise<T> {
  // Expo's native parameter transform counts a TypeScript-only `this` before erasure.
  // Body defaults preserve argument positions in the actual Hermes build.
  if (params === undefined) params = {};
  if (!this.client)
    return Promise.reject(new Error("Web 演示模式没有真实 app-server 连接"));
  if (!this.snapshot.connected)
    return Promise.reject(new Error("KCoder app-server 正在重新连接"));
  const requestParams = params === undefined ? {} : params;
  return this.client.request<T>(method, requestParams, timeoutMs);
}

export function terminalSession(
  this: TaskRuntime,
  panelId: string,
  initialSessionId?: string,
): TaskTerminalSession {
  const existing = this.terminalSessions.get(panelId);
  if (existing) return existing;
  const session = new TaskTerminalSession(
    this,
    panelId,
    this.snapshot.cwd,
    initialSessionId,
  );
  this.terminalSessions.set(panelId, session);
  return session;
}

export function closeTerminalSession(this: TaskRuntime, panelId: string): void {
  const session = this.terminalSessions.get(panelId);
  if (!session) return;
  this.terminalSessions.delete(panelId);
  session.dispose(true);
}

export function isLiveTerminalSession(
  this: TaskRuntime,
  panelId: string,
): boolean {
  const status = this.terminalSessions.get(panelId)?.getSnapshot().status;
  return (
    status === "starting" || status === "running" || status === "reconnecting"
  );
}

export function hasLiveTerminalSessions(this: TaskRuntime): boolean {
  return [...this.terminalSessions.values()].some((session) => {
    const status = session.getSnapshot().status;
    return (
      status === "starting" || status === "running" || status === "reconnecting"
    );
  });
}
