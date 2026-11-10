import { describe, expect, it, vi } from "vitest";
import type {
  AgentDefinitionRef,
  IntegrationRequest,
  IntegrationScope,
  OfficeAssistantDefinition,
  OfficeAssistantVersion,
} from "../../../../shared/generated/contracts";
import type { GatewayRpcClient } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import type { TaskRuntime } from "./core";
import {
  listExpertVersions,
  listExpertsPage,
  readExpert,
  selectExpert,
  supportsExperts,
} from "./experts";

function signalWithoutThrowIfAborted(): AbortController {
  const controller = new AbortController();
  Object.defineProperty(controller.signal, "throwIfAborted", { configurable: true, value: undefined });
  return controller;
}

const profile: GatewayProfile = {
  id: "profile-1",
  label: "Test Gateway",
  baseUrl: "https://gateway.example.test",
  accessToken: "test-access-token",
  expiresAt: 1,
  rpcToken: "test-rpc-token",
  authorizationGeneration: "4",
};
const server = { id: "target-1" } as KCoderServer;
const scope: IntegrationScope = {
  accountId: "account-1",
  identityGeneration: "identity-1",
  organizationId: null,
  targetId: "target-1",
  targetRevision: "target-revision-1",
  workspaceId: "workspace-1",
};
const settings = {
  connectionEnabled: true,
  effectiveEnabled: true,
  persistedEnabled: true,
  restartRequired: false,
  revision: "a".repeat(64),
};
const reference: AgentDefinitionRef = {
  id: "expert.writer",
  version: "2.1.0",
  definitionSha256: "b".repeat(64),
};

function definition(id: string, title: string, metadata: Record<string, unknown> = {}): OfficeAssistantDefinition {
  return {
    acceptanceCriteria: [],
    description: `${title} description`,
    externalSend: "deny",
    id,
    inputSchema: { type: "object", "x-kcoder-expert": metadata },
    instructions: "Follow the saved definition.",
    language: "en",
    modelSelection: { kind: "inherit_current" },
    outputKinds: [],
    schemaVersion: 1,
    scope: "personal",
    title,
  };
}

function version(
  expertDefinition: OfficeAssistantDefinition,
  options: { version?: string; archived?: boolean; owner?: OfficeAssistantVersion["owner"] } = {},
): OfficeAssistantVersion {
  return {
    archived: options.archived ?? false,
    createdAtMs: 1,
    definition: expertDefinition,
    definitionSha256: "b".repeat(64),
    owner: options.owner ?? {
      accountId: scope.accountId,
      organizationId: null,
      targetId: scope.targetId,
      workspaceId: scope.workspaceId,
    },
    version: options.version ?? "2.1.0",
  };
}

function reply(request: IntegrationRequest, result: Record<string, unknown>) {
  return {
    contractVersion: "parallel-v1",
    entityRevision: null,
    error: null,
    observedAt: new Date(0).toISOString(),
    operationId: null,
    requestId: request.requestId,
    result,
    status: "completed",
  };
}

function catalogClient(overrides: {
  settings?: unknown;
  scope?: unknown;
  assistantPage?: Record<string, unknown>;
  versionsPage?: Record<string, unknown>;
  wrongReplyRequestId?: boolean;
} = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = {
    supportsExperimental: vi.fn((capability: string) =>
      ["integrationScopeV1", "officeSettingsV1", "officeWorkspaceV1"].includes(capability)),
    matchesRuntimeOwner: vi.fn(() => true),
    request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push([method, params]);
      if (method === "settings/integrations/office/read") return overrides.settings ?? settings;
      if (method === "integrations/scope/read") return overrides.scope ?? scope;
      if (method === "integrations/assistant/list" || method === "integrations/assistant/versions") {
        const result = method === "integrations/assistant/list"
          ? overrides.assistantPage ?? { items: [], total: 0, nextCursor: null }
          : overrides.versionsPage ?? { items: [], total: 0, nextCursor: null };
        const response = reply(params as unknown as IntegrationRequest, result);
        return overrides.wrongReplyRequestId ? { ...response, requestId: "another-request" } : response;
      }
      throw new Error(`unexpected RPC ${method}`);
    }),
  };
  return { client: client as unknown as GatewayRpcClient, calls };
}

function runtimeFixture(
  capabilities: string[] = ["agentDefinitionsV1", "agentTurnConfigurationV1"],
  response?: unknown,
) {
  const client = {
    supportsExperimental: vi.fn((capability: string) => capabilities.includes(capability)),
    matchesRuntimeOwner: vi.fn(() => true),
    request: vi.fn(async (_method: string, _params: Record<string, unknown> = {}): Promise<unknown> =>
      response ?? { threadId: "thread-original", revision: 3, expert: null, turns: [] }),
  };
  const runtime = {
    runtimeInstanceNonce: 7,
    clientGeneration: 4,
    client: client as unknown as GatewayRpcClient,
    reconnectContext: { profile, server },
    disposed: false,
    snapshot: { threadId: "thread-original", cwd: "/workspace/original", connected: true },
  } as unknown as TaskRuntime;
  return { runtime, client };
}

describe("Mobile task expert runtime", () => {
  it("reads saved expert directories and versions when AbortSignal lacks throwIfAborted", async () => {
    const controller = signalWithoutThrowIfAborted();
    expect(controller.signal.throwIfAborted).toBeUndefined();
    const saved = version(definition(reference.id, "Writer"));
    const { client: directoryClient } = catalogClient({
      assistantPage: {
        items: [{ definition: definition(reference.id, "Writer"), builtin: false }],
        total: 1,
        nextCursor: null,
      },
    });
    const { client: versionClient } = catalogClient({
      versionsPage: { items: [saved], total: 1, nextCursor: null },
    });

    await expect(listExpertsPage(
      directoryClient,
      "en",
      undefined,
      controller.signal,
    )).resolves.toMatchObject({ items: [{ id: reference.id }] });
    await expect(listExpertVersions(
      versionClient,
      reference.id,
      undefined,
      controller.signal,
    )).resolves.toMatchObject({ items: [{ reference }] });
  });

  it("stops catalog reads after cancellation and avoids a pre-cancelled expert write", async () => {
    const controller = signalWithoutThrowIfAborted();
    const { client, calls } = catalogClient();
    const pendingSettings = Promise.withResolvers<unknown>();
    vi.mocked(client.request).mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push([method, params]);
      if (method === "settings/integrations/office/read") return pendingSettings.promise;
      if (method === "integrations/scope/read") return scope;
      throw new Error(`unexpected RPC ${method}`);
    });

    const pending = listExpertsPage(client, "en", undefined, controller.signal);
    const cancelledRead = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.map(([method]) => method)).toEqual(["settings/integrations/office/read"]);
    controller.abort();
    pendingSettings.resolve(settings);
    await cancelledRead;
    expect(calls.map(([method]) => method)).toEqual(["settings/integrations/office/read"]);

    const cancelled = signalWithoutThrowIfAborted();
    cancelled.abort();
    const { runtime, client: taskClient } = runtimeFixture();
    await expect(selectExpert.call(runtime, reference, 3, cancelled.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(taskClient.request).not.toHaveBeenCalled();

    const preCancelled = signalWithoutThrowIfAborted();
    preCancelled.abort();
    const untouched = catalogClient();
    await expect(listExpertsPage(
      untouched.client,
      "en",
      undefined,
      preCancelled.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(untouched.calls).toEqual([]);
  });

  it("gates existing-task controls on task configuration capabilities alone", async () => {
    const taskOnly = runtimeFixture(["agentDefinitionsV1", "agentTurnConfigurationV1"]);
    expect(supportsExperts.call(taskOnly.runtime)).toBe(true);
    expect((await readExpert.call(taskOnly.runtime)).threadId).toBe("thread-original");
    const oldTarget = runtimeFixture(["agentDefinitionsV1"]);
    expect(supportsExperts.call(oldTarget.runtime)).toBe(false);
    await expect(readExpert.call(oldTarget.runtime)).rejects.toThrow("AGENT_TURN_CONFIGURATION_UNSUPPORTED");
  });

  it("reads and CAS-updates only the original thread with its exact reference", async () => {
    const selected = {
      threadId: "thread-original",
      revision: 10,
      expert: {
        definition: reference,
        owner: { accountId: "account-1", organizationId: null, targetId: "target-1", workspaceId: "workspace-1" },
        source: "expert",
        sourceId: null,
        title: "Writer",
      },
      turns: [],
    };
    const { runtime, client } = runtimeFixture(undefined, selected);
    const before = await readExpert.call(runtime);
    expect(before.threadId).toBe("thread-original");
    const result = await selectExpert.call(runtime, reference, 9);
    expect(result).toEqual(selected);
    expect(client.request).toHaveBeenNthCalledWith(1, "thread/expert", { threadId: "thread-original" });
    expect(client.request).toHaveBeenNthCalledWith(2, "thread/expert", {
      threadId: "thread-original",
      change: { expectedRevision: 9, expert: reference },
    });
    expect(client.request.mock.calls.map(([method]) => method)).not.toContain("thread/start");
    expect(client.request.mock.calls.map(([method]) => method)).not.toContain("turn/start");
  });

  it("does not replay a lost CAS acknowledgement or read through a stale owner", async () => {
    const { runtime, client } = runtimeFixture();
    client.request.mockRejectedValueOnce(new Error("ACK_UNKNOWN"));
    await expect(selectExpert.call(runtime, reference, 3)).rejects.toThrow("ACK_UNKNOWN");
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith("thread/expert", {
      threadId: "thread-original",
      change: { expectedRevision: 3, expert: reference },
    });

    client.request.mockClear();
    client.matchesRuntimeOwner.mockReturnValue(false);
    await expect(readExpert.call(runtime)).rejects.toThrow("AGENT_ORIGINAL_TASK_CHANGED");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("drops a late read receipt after the original client generation changes", async () => {
    const { runtime, client } = runtimeFixture();
    let resolve!: (value: unknown) => void;
    client.request.mockImplementationOnce(() => new Promise<unknown>(done => { resolve = done; }));
    const pending = readExpert.call(runtime);
    runtime.clientGeneration += 1;
    resolve({ threadId: "thread-original", revision: 3, expert: null, turns: [] });
    await expect(pending).rejects.toThrow("AGENT_ORIGINAL_TASK_CHANGED");
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong-thread and stale-revision receipts", async () => {
    const wrongThread = runtimeFixture(undefined, { threadId: "thread-other", revision: 4, expert: null, turns: [] });
    await expect(readExpert.call(wrongThread.runtime)).rejects.toThrow("AGENT_ORIGINAL_RESPONSE_REQUIRED");
    const staleRevision = runtimeFixture(undefined, { threadId: "thread-original", revision: 7, expert: null, turns: [] });
    await expect(selectExpert.call(staleRevision.runtime, null, 5)).rejects.toThrow("AGENT_CONFIGURATION_STALE_REPLY");
    expect(staleRevision.client.request).toHaveBeenCalledTimes(1);
  });

  it("filters valid disabled, team, and builtin entries while preserving bounded pagination", async () => {
    const enabled = definition("expert.writer", "Writer", { enabled: true, kind: "expert" });
    const disabled = definition("expert.disabled", "Disabled", { enabled: false, kind: "expert" });
    const team = definition("expert.team", "Team", { enabled: true, kind: "team" });
    const { client, calls } = catalogClient({
      assistantPage: {
        items: [
          { definition: enabled, builtin: false },
          { definition: disabled, builtin: false },
          { definition: team, builtin: false },
          { definition: definition("builtin.helper", "Builtin"), builtin: true },
        ],
        total: 4,
        nextCursor: "assistant-cursor-2",
      },
    });
    const result = await listExpertsPage(client, "en");
    expect(result).toEqual({ items: [{ id: "expert.writer", title: "Writer", description: "Writer description" }], nextCursor: "assistant-cursor-2" });
    const officeCall = calls.find(([method]) => method === "integrations/assistant/list");
    expect(officeCall?.[1]).toMatchObject({
      contractVersion: "parallel-v1",
      scope,
      payload: { limit: 10, language: "en", personalOnly: true },
    });
    expect(calls.map(([method]) => method)).toEqual([
      "settings/integrations/office/read", "integrations/scope/read",
      "integrations/assistant/list",
    ]);
  });

  it("does not read a directory when Office is disabled or catalog capability is missing", async () => {
    const disabled = catalogClient({ settings: { ...settings, effectiveEnabled: false, connectionEnabled: false } });
    await expect(listExpertsPage(disabled.client, "en")).rejects.toThrow("AGENT_EXPERTS_OFFICE_DISABLED");
    expect(disabled.calls.map(([method]) => method)).toEqual(["settings/integrations/office/read"]);

    const unsupported = catalogClient();
    unsupported.client.supportsExperimental = vi.fn((capability: string) => capability !== "officeWorkspaceV1");
    await expect(listExpertsPage(unsupported.client, "en")).rejects.toThrow("AGENT_EXPERTS_UNSUPPORTED");
    expect(unsupported.calls.map(([method]) => method)).toEqual(["settings/integrations/office/read"]);
  });

  it("rejects an IntegrationReply for a different request", async () => {
    const { client, calls } = catalogClient({ wrongReplyRequestId: true });
    await expect(listExpertsPage(client, "en")).rejects.toThrow("AGENT_EXPERTS_REPLY_INVALID");
    expect(calls.map(([method]) => method)).toEqual([
      "settings/integrations/office/read", "integrations/scope/read",
      "integrations/assistant/list",
    ]);
  });

  it("returns only exact saved, unarchived versions owned by the current scope", async () => {
    const saved = version(definition(reference.id, "Writer"));
    const archived = version(definition(reference.id, "Writer"), { version: "1.0.0", archived: true });
    const otherWorkspace = version(definition(reference.id, "Writer"), {
      version: "1.5.0",
      owner: { accountId: "account-1", organizationId: null, targetId: "target-1", workspaceId: "elsewhere" },
    });
    const { client, calls } = catalogClient({
      versionsPage: { items: [saved, archived, otherWorkspace], total: 3, nextCursor: null },
    });
    const result = await listExpertVersions(client, reference.id, "versions-cursor");
    expect(result).toEqual({ items: [{ reference, title: "Writer · 2.1.0", description: "Writer description" }], nextCursor: null });
    const officeCall = calls.find(([method]) => method === "integrations/assistant/versions");
    expect(officeCall?.[1]).toMatchObject({
      scope,
      payload: { id: reference.id, limit: 10, cursor: "versions-cursor" },
    });
    expect(calls.map(([method]) => method)).toEqual([
      "settings/integrations/office/read", "integrations/scope/read",
      "integrations/assistant/versions",
    ]);
  });

  it("validates saved expert references when TextEncoder is unavailable", async () => {
    const saved = version(definition(reference.id, "Writer"));
    const { client } = catalogClient({ versionsPage: { items: [saved], total: 1, nextCursor: null } });
    vi.stubGlobal("TextEncoder", undefined);
    try {
      await expect(listExpertVersions(client, reference.id)).resolves.toEqual({
        items: [{ reference, title: "Writer · 2.1.0", description: "Writer description" }],
        nextCursor: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
