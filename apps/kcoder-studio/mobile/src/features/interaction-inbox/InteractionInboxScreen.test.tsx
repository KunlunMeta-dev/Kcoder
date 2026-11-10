import React from "react";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InteractionInboxRow, PendingInteraction } from "@/runtime/task-runtime/types";

const fixture = vi.hoisted(() => ({
  rows: [] as InteractionInboxRow[],
  entries: [] as Array<{ profileId: string; serverId: string; threadId: string; runtime: any }>,
  overflow: { omittedRows: 0, mayContainUntrackedRows: true },
  push: vi.fn(),
}));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ profileId: "profile-a" }),
  useRouter: () => ({ push: fixture.push, back: vi.fn() }),
  useIsFocused: () => true,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: "SafeAreaView",
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: "Text",
  View: "View",
}));
vi.mock("lucide-react-native", () => ({ ChevronLeft: () => null, Inbox: () => null }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/state/AppContext", () => ({
  useApp: () => ({
    hydrated: true,
    activeProfile: {
      id: "profile-a", label: "Current", baseUrl: "https://gateway.invalid",
      accessToken: "secret-token", refreshToken: "secret-refresh", authorizationGeneration: "auth-a",
    },
    runtime: {
      serversReady: true,
      reauthorizationRequired: false,
      servers: [{ id: "server-a", label: "Target A", observationTargetIdentity: "target-a", transport: "local" }],
    },
    demo: false,
    runtimeActivationEpoch: 3,
    isCurrentInteractionOwner: () => true,
  }),
}));
vi.mock("@/state/profile-coordinator", () => ({
  profileAuthorizationScopeKey: () => "scope-a",
}));
vi.mock("@/runtime/task-runtime/threadDirectory", () => ({
  interactionServerIdentity: (server: { observationTargetIdentity: string }) => server.observationTargetIdentity,
}));
vi.mock("@/runtime/task-runtime", () => ({
  taskRuntimeRegistry: {
    subscribe: () => () => undefined,
    entries: () => fixture.entries,
    interactionInboxRows: () => fixture.rows,
    interactionInboxOverflow: () => fixture.overflow,
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

const require = createRequire(import.meta.url);
const renderToStaticMarkup = require("react-dom/server").renderToStaticMarkup as (element: React.ReactNode) => string;

const profile = {
  id: "profile-a", label: "Current", baseUrl: "https://gateway.invalid", accessToken: "secret-token",
  refreshToken: "secret-refresh", authorizationGeneration: "auth-a",
};
const server = { id: "server-a", label: "Target A", observationTargetIdentity: "target-a", transport: "local" };
const owner = {
  profileId: "profile-a", profileAuthorizationScopeKey: "scope-a", serverId: "server-a",
  appServerId: "server-engine-S",
  serverConfigIdentity: "target-a", threadId: "thread-a", turnId: "turn-a", appServerEpoch: "epoch-a",
  runtimeInstanceNonce: 4, profileActivationEpoch: 3, originClientGeneration: 2, status: "pending" as const,
};
const approval: PendingInteraction = {
  kind: "approval", requestId: 17, approvalId: "approval-a", reason: "PRIVATE REQUEST BODY",
  action: { type: "command", command: "private-command" }, owner,
};
const row = (serverConfigIdentity = "target-a"): InteractionInboxRow => ({
  profileId: "profile-a", profileAuthorizationScopeKey: "scope-a", serverId: "server-a",
  appServerId: "server-engine-S",
  serverConfigIdentity, threadId: "thread-a", title: "Visible task", cwd: "/private/workspace",
  kind: "approval", requestId: 17, interactionId: "approval-a", turnId: "turn-a", appServerEpoch: "epoch-a",
  runtimeInstanceNonce: 4, profileActivationEpoch: 3, originClientGeneration: 2,
  status: "pending", liveActionable: false,
});

afterEach(() => {
  fixture.rows = [];
  fixture.entries = [];
  fixture.overflow = { omittedRows: 0, mayContainUntrackedRows: true };
  fixture.push.mockClear();
});

describe("InteractionInboxScreen", () => {
  it("renders only the active profile's current target rows and never renders request bodies", () => {
    fixture.rows = [row(), row("stale-target")];
    fixture.entries = [{
      profileId: "profile-a", serverId: "server-a", threadId: "thread-a",
      runtime: {
        runtimeInstanceNonce: 4, clientGeneration: 2, reconnecting: false, disposed: false,
        reconnectContext: { profile, server }, pendingInteractions: [approval],
        client: { isTransportOpen: () => true },
        getSnapshot: () => ({ connected: true }), isInteractionActionable: () => false,
      },
    }];
    const html = renderToStaticMarkup(<InteractionInboxScreen />);
    expect(html).toContain("inbox.pending_approval");
    expect(html).toContain("inbox.overflow");
    expect(html).not.toContain("PRIVATE REQUEST BODY");
    expect(html).not.toContain("private-command");
    expect(html.match(/inbox-row-approval-17/g)).toHaveLength(1);
  });

  it("shows uncertainty instead of a contradictory empty state when rows overflow", () => {
    fixture.overflow = { omittedRows: 0, mayContainUntrackedRows: true };
    const uncertainHtml = renderToStaticMarkup(<InteractionInboxScreen />);
    expect(uncertainHtml).toContain("inbox-overflow");
    expect(uncertainHtml).not.toContain("inbox.empty");

    fixture.overflow = { omittedRows: 0, mayContainUntrackedRows: false };
    const emptyHtml = renderToStaticMarkup(<InteractionInboxScreen />);
    expect(emptyHtml).toContain("inbox.empty");
    expect(emptyHtml).not.toContain("inbox-overflow");
  });
});
