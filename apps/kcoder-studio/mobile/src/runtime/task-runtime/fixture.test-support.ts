import type { JsonRecord, RpcMessage } from "@/gateway/rpc";
import type {
  GatewayProfile,
  KCoderServer,
  ThreadMessage,
} from "@/gateway/types";
export const profile: GatewayProfile = {
  id: "gateway-a",
  label: "A",
  baseUrl: "http://127.0.0.1:4173",
  accessToken: "access",
  expiresAt: Number.MAX_SAFE_INTEGER,
  rpcToken: "rpc",
};

export const server: KCoderServer = {
  id: "local",
  label: "Local",
  description: "test",
  runtime: "kcoder",
  transport: "local",
  workspacePath: "/workspace",
};

export class FakeClient {
  listeners = new Set<(message: RpcMessage) => void>();
  closed = false;

  constructor(
    private readonly history: ThreadMessage[],
    private readonly duringRead: RpcMessage[] = [],
    private readonly historyPage: {
      hasMoreBefore?: boolean;
      beforeCursor?: string | null;
      rangeStart?: number;
      rangeEnd?: number;
    } = {},
  ) {}

  subscribe(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  supportsExperimental(capability: string): boolean {
    return capability === "agentSteering";
  }

  async request<T>(method: string, _params: JsonRecord = {}): Promise<T> {
    if (method === "thread/resume") {
      return {
        thread: {
          id: "thread-1",
          title: "恢复任务",
          cwd: "/workspace",
          status: "idle",
        },
      } as T;
    }
    if (method === "thread/read") {
      for (const message of this.duringRead.splice(0)) this.emit(message);
      return {
        thread: {
          id: "thread-1",
          title: "恢复任务",
          cwd: "/workspace",
          status: "idle",
        },
        messages: this.history,
        ...this.historyPage,
      } as T;
    }
    return {} as T;
  }

  respond(): void {}
  respondError(): void {}
  close(): void {
    this.closed = true;
  }
  emit(message: RpcMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}
