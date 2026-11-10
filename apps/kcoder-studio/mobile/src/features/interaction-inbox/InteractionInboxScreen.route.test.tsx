import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { InteractionInboxRow, PendingInteraction } from "@/runtime/task-runtime/types";

const fixture = vi.hoisted(() => ({
  slots: [] as Array<{ value?: unknown }>,
  cursor: 0,
  rows: [] as InteractionInboxRow[],
  entries: [] as Array<{ profileId: string; serverId: string; threadId: string; runtime: any }>,
  push: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const slot = fixture.slots[fixture.cursor++] ??= { value: typeof initial === "function" ? (initial as () => unknown)() : initial };
    return [slot.value, (next: unknown) => {
      slot.value = typeof next === "function" ? (next as (value: unknown) => unknown)(slot.value) : next;
    }];
  },
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => undefined,
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ profileId: "profile-a" }),
  useRouter: () => ({ push: fixture.push, back: vi.fn() }),
  useIsFocused: () => true,
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView", useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", ScrollView: "ScrollView",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }, Text: "Text", View: "View",
}));
vi.mock("lucide-react-native", () => ({ ChevronLeft: "ChevronLeft", Inbox: "Inbox" }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/state/profile-coordinator", () => ({ profileAuthorizationScopeKey: () => "scope-a" }));
vi.mock("@/runtime/task-runtime/threadDirectory", () => ({ interactionServerIdentity: () => "target-a" }));
vi.mock("@/state/AppContext", () => ({
  useApp: () => ({
    hydrated: true, activeProfile: profile,
    runtime: { serversReady: true, reauthorizationRequired: false, servers: [server] },
    demo: false, runtimeActivationEpoch: 3, isCurrentInteractionOwner: () => true,
  }),
}));
vi.mock("@/runtime/task-runtime", () => ({
  taskRuntimeRegistry: {
    subscribe: () => () => undefined,
    entries: () => fixture.entries,
    interactionInboxRows: () => fixture.rows,
    interactionInboxOverflow: () => ({ omittedRows: 0, mayContainUntrackedRows: false }),
  },
}));
vi.mock("@/theme", () => {
  const colors = new Proxy({}, { get: (_target, key) => String(key) });
  return {
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    useThemedStyles: (factory: (value: any) => unknown) => factory(colors),
  };
});

import { InteractionInboxScreen } from "./InteractionInboxScreen";

const profile = {
  id: "profile-a", label: "Current", baseUrl: "https://gateway.invalid",
  accessToken: "secret-token", refreshToken: "secret-refresh", authorizationGeneration: "auth-a",
};
const server = { id: "server-a", label: "Target A", observationTargetIdentity: "target-a", transport: "local" };
const row: InteractionInboxRow = {
  profileId: "profile-a", profileAuthorizationScopeKey: "scope-a", serverId: "server-a",
  appServerId: "server-engine-S",
  serverConfigIdentity: "target-a", threadId: "thread-a", title: "Visible task", cwd: "/private/workspace",
  kind: "approval", requestId: 17, interactionId: "approval-a", turnId: "turn-a", appServerEpoch: "epoch-a",
  runtimeInstanceNonce: 4, profileActivationEpoch: 3, originClientGeneration: 2,
  status: "pending", liveActionable: false,
};
const interaction: PendingInteraction = {
  kind: "approval", requestId: 17, approvalId: "approval-a", reason: "private request",
  action: { type: "command", command: "private" },
  owner: {
    profileId: row.profileId, profileAuthorizationScopeKey: row.profileAuthorizationScopeKey,
    serverId: row.serverId, appServerId: row.appServerId, serverConfigIdentity: row.serverConfigIdentity, threadId: row.threadId,
    turnId: row.turnId, appServerEpoch: row.appServerEpoch, runtimeInstanceNonce: row.runtimeInstanceNonce,
    profileActivationEpoch: row.profileActivationEpoch, originClientGeneration: row.originClientGeneration,
    status: "pending",
  },
};

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

beforeEach(() => {
  fixture.slots = [];
  fixture.cursor = 0;
  fixture.rows = [row];
  fixture.entries = [{
    profileId: row.profileId, serverId: row.serverId, threadId: row.threadId,
    runtime: {
      pendingInteractions: [interaction], disposed: false, reconnecting: true,
      reconnectContext: { profile, server }, clientGeneration: row.originClientGeneration,
      runtimeInstanceNonce: row.runtimeInstanceNonce, client: { isTransportOpen: () => false },
      getSnapshot: () => ({ connected: false }), isInteractionActionable: () => false,
    },
  }];
});

afterEach(() => fixture.push.mockClear());

describe("InteractionInboxScreen navigation", () => {
  it("revalidates and opens the exact task route with only the non-secret locator", () => {
    fixture.cursor = 0;
    const tree = elements(InteractionInboxScreen());
    const open = tree.find((element) => element.props.testID === "inbox-open-approval-17");
    expect(open).toBeDefined();
    (open!.props.onPress as () => void)();

    expect(fixture.push).toHaveBeenCalledTimes(1);
    const href = fixture.push.mock.calls[0]![0] as { pathname: string; params: Record<string, string> };
    expect(href.pathname).toBe("/h/[profileId]/task/[serverId]/[threadId]");
    expect(href.params).toEqual({
      profileId: "profile-a", serverId: "server-a", threadId: "thread-a",
      kind: "approval", requestId: "17", interactionId: "approval-a",
      turnId: "turn-a", appServerEpoch: "epoch-a",
    });
    expect(JSON.stringify(href)).not.toContain("secret-token");
    expect(JSON.stringify(href)).not.toContain("private request");
    expect(JSON.stringify(href)).not.toContain("target-a");
  });
});
