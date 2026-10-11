import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRequire } from "node:module";
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup(element: React.ReactNode): string;
};
vi.mock("./ui", () => ({
  Button: (props: { testID?: string; onPress?: () => unknown }) => {
    if (props.testID && props.onPress)
      (globalThis as any).__interactionCardHandlers[props.testID] = props.onPress;
    return null;
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  Pressable: "button",
  ScrollView: "div",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: "span",
  TextInput: "input",
  View: "div",
}));
vi.mock("@/theme", () => {
  const colors = new Proxy({}, { get: (_target, key) => String(key) });
  return {
    useTheme: () => ({ colors, mode: "dark" }),
    useThemedStyles: (factory: (value: any) => unknown) => factory(colors),
    radius: { sm: 4, md: 6, lg: 8, xl: 12, pill: 999 },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  };
});
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("lucide-react-native", () => ({
  CheckSquare: () => null,
  HelpCircle: () => null,
  ShieldCheck: () => null,
  Square: () => null,
}));
import {
  actionDescription,
  approvalActionPresentation,
} from "./approval-action";
import { ApprovalCard, QuestionCard } from "./interaction-cards";
import { GatewayRpcClient, MobileRpcError } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { TaskRuntime, taskRuntimeTestHelpers } from "@/runtime/task-runtime";
import { gatewaySessionExpired } from "@/gateway/http";

vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));

const getHandlers = () =>
  (globalThis as any).__interactionCardHandlers as Record<
    string,
    () => unknown
  >;

const profile: GatewayProfile = {
  id: "gateway-unit",
  label: "Unit Gateway",
  baseUrl: "https://gateway.invalid",
  accessToken: "unit-test-token",
  expiresAt: Number.MAX_SAFE_INTEGER,
  rpcToken: "unit-test-rpc-token",
};
const server: KCoderServer = {
  id: "local-unit",
  label: "Unit server",
  description: "transport fixture",
  runtime: "kcoder",
  transport: "local",
  workspacePath: "/workspace",
};

class FakeGatewaySocket {
  static OPEN = 1;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor() {
    fakeSocket = this;
    queueMicrotask(() => {
      this.readyState = FakeGatewaySocket.OPEN;
      this.onopen?.({});
    });
  }

  send(raw: string) {
    const request = JSON.parse(raw) as { id?: number; method?: string };
    if (typeof request.id !== "number") return;
    const thread = {
      id: "thread-interaction-test",
      title: "Interaction transport test",
      cwd: "/workspace",
      status: "idle",
    };
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2026-07-27",
            capabilities: { experimental: {} },
          }
        : request.method === "thread/resume"
          ? { thread }
          : request.method === "thread/read"
            ? { thread, messages: [] }
            : {};
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      }),
    );
  }

  close() {
    this.readyState = 3;
    this.onclose?.({});
  }

  deliver(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let fakeSocket: FakeGatewaySocket;
let activeRuntime: TaskRuntime | null = null;

beforeEach(() => {
  (globalThis as any).__interactionCardHandlers = {};
  vi.stubGlobal("WebSocket", FakeGatewaySocket);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});

afterEach(() => {
  activeRuntime?.close();
  activeRuntime = null;
  taskRuntimeTestHelpers.resetConnector();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function resumeRuntime(): Promise<TaskRuntime> {
  taskRuntimeTestHelpers.setConnector(GatewayRpcClient.connect);
  activeRuntime = await TaskRuntime.resume({
    profile,
    server,
    threadId: "thread-interaction-test",
  });
  return activeRuntime;
}

function deliverPendingInteraction(message: object) {
  fakeSocket.deliver(message);
}

describe("审批操作说明", () => {
  it("工具审批同时展示工具名和完整参数", () => {
    expect(
      actionDescription({
        type: "tool",
        name: "Write",
        input: { path: "/workspace/a.ts", content: "hello" },
      }),
    ).toContain('"path": "/workspace/a.ts"');
    expect(
      actionDescription({
        type: "tool",
        name: "Write",
        input: { path: "/workspace/a.ts" },
      }),
    ).toMatch(/^Tool: Write\nInput: /);
  });

  it("限制不受信任参数的展示长度", () => {
    const description = actionDescription({
      type: "tool",
      name: "Large",
      input: { data: "x".repeat(8_000) },
    });
    expect(description).toContain("input truncated");
    expect(description.length).toBeLessThan(4_200);
    expect(
      approvalActionPresentation({
        type: "tool",
        name: "Large",
        input: { data: "x".repeat(8_000) },
      }).safeToApprove,
    ).toBe(false);
  });

  it("缺少工具参数时明确告知用户", () => {
    expect(actionDescription({ type: "tool", name: "Unknown" })).toContain(
      "missing input",
    );
    expect(
      approvalActionPresentation({ type: "tool", name: "Unknown" })
        .safeToApprove,
    ).toBe(false);
  });

  it("approval RPC readiness races report the transport failure and retain retry state", async () => {
    const runtime = await resumeRuntime();
    deliverPendingInteraction({
      jsonrpc: "2.0",
      id: 7,
      method: "approval/request",
      params: {
        approvalId: "approval-7",
        reason: "需要批准",
        action: { type: "command", command: "ls" },
      },
    });
    const interaction = runtime.getSnapshot().interaction!;
    renderToStaticMarkup(
      <ApprovalCard
        interaction={interaction as Extract<typeof interaction, { kind: "approval" }>}
        onRespond={(decision) => runtime.respondApproval(decision)}
      />,
    );

    expect(getHandlers()["approval-accept"]).toBeTypeOf("function");
    fakeSocket.readyState = 3;
    expect(runtime.getSnapshot().connected).toBe(true);
    expect(getHandlers()["approval-accept"]()).toBe(
      "Approval response failed: RPC 连接尚未就绪. You can try again.",
    );
    expect(runtime.getSnapshot().interaction?.responding).toBe(false);
    expect(getHandlers()["approval-accept"]()).toBe(
      "Approval response failed: RPC 连接尚未就绪. You can try again.",
    );
    expect(runtime.getSnapshot().interaction?.responding).toBe(false);
  });

  it("question cancel RPC readiness races report the transport failure and retain retry state", async () => {
    const runtime = await resumeRuntime();
    deliverPendingInteraction({
      jsonrpc: "2.0",
      id: 8,
      method: "question/request",
      params: {
        questionId: "question-8",
        questions: [{ id: "choice", prompt: "选择一个选项", options: [] }],
      },
    });
    const interaction = runtime.getSnapshot().interaction!;
    renderToStaticMarkup(
      <QuestionCard
        interaction={interaction as Extract<typeof interaction, { kind: "question" }>}
        onSubmit={() => undefined}
        onCancel={() => runtime.cancelQuestions()}
      />,
    );

    expect(getHandlers()["question-cancel"]).toBeTypeOf("function");
    fakeSocket.readyState = 3;
    expect(runtime.getSnapshot().connected).toBe(true);
    expect(getHandlers()["question-cancel"]()).toBe(
      "Question cancellation failed: RPC 连接尚未就绪. You can try again.",
    );
    expect(runtime.getSnapshot().interaction?.responding).toBe(false);
    expect(getHandlers()["question-cancel"]()).toBe(
      "Question cancellation failed: RPC 连接尚未就绪. You can try again.",
    );
    expect(runtime.getSnapshot().interaction?.responding).toBe(false);
  });
});
