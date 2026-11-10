import { gatewaySessionExpired } from "@/gateway/http";
import { getLocalePreference, setLocalePreference } from "@/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";

vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));
const originalLocale = getLocalePreference();
beforeEach(() => { vi.mocked(gatewaySessionExpired).mockResolvedValue(false); });
afterEach(() => {
  taskRuntimeTestHelpers.resetConnector();
  setLocalePreference(originalLocale);
  vi.restoreAllMocks();
});

it.each(["zh-CN", "en"] as const)("projects the trusted notice code in %s without changing unrelated notices", async locale => {
  setLocalePreference(locale);
  const client = new FakeClient([]);
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
  const context = { serverId: "app-server-1", threadId: "thread-1", turnId: "turn-owned" };
  try {
    client.emit({ method: "turn/started", params: { ...context, sequence: 0,
      turn: { id: "turn-owned", threadId: "thread-1", status: "running" } } });
    client.emit({ method: "item/event", params: { ...context, sequence: 1,
      event: { type: "system_notice", code: "kcoder.notice.imported_context_legacy_unobserved", text: "ENGLISH_FALLBACK" } } });
    client.emit({ method: "item/event", params: { ...context, sequence: 2,
      event: { type: "system_notice", code: "unknown.future.notice", text: "Unrelated notice" } } });
    const snapshot = runtime.getSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("ENGLISH_FALLBACK");
    expect(serialized).toContain(locale === "zh-CN" ? "此旧会话未保存" : "This older conversation");
    expect(serialized).toContain("Unrelated notice");
  } finally { runtime.close(); }
});
