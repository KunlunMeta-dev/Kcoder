import { afterEach, expect, it, vi } from "vitest";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { claimNewTaskDraftHandoff, consumeNewTaskDraftHandoff, createNewTaskDraftHandoff,
  NEW_TASK_DRAFT_HANDOFF_TTL_MS, retainNewTaskDraftHandoffProfile, returnNewTaskDraftHandoff,
  revokeNewTaskDraftHandoff, type NewTaskDraftReturn, type NewTaskDraftState } from "./new-task-draft-handoff";

const profile: GatewayProfile = { id: "draft-profile", label: "Gateway", baseUrl: "https://gateway.invalid", accessToken: "test-access",
  rpcToken: "test-rpc", authMode: "device", authorizationGeneration: "auth-A", deviceId: "device-A", expiresAt: Date.now() + 60_000 };
const server: KCoderServer = { id: "target-A", label: "Target", description: "Test target", runtime: "kcoder", transport: "local", workspacePath: "/source" };
const draft: NewTaskDraftState = { prompt: "private unsent prompt", executionMode: "moa", model: "provider::chosen", modelExplicit: true,
  reasoningEffort: "high", isolation: "worktree", gitRef: "feature" };
const destination: NewTaskDraftReturn = { profileId: profile.id, serverId: server.id, cwd: "/project", operationReceiptId: "receipt-1",
  operationReceiptVersion: "2", operationKind: "open", operationSourcePath: "/project" };
const issued: string[] = [];
function issue() {
  const onConsumed = vi.fn();
  const token = createNewTaskDraftHandoff({ profile, server, draft, sourceIntent: "source-route-intent", isCurrent: () => true, onConsumed })!;
  issued.push(token);
  return { token, onConsumed };
}
afterEach(() => { issued.splice(0).forEach(revokeNewTaskDraftHandoff); vi.restoreAllMocks(); });

it("keeps text out of the nonce, binds the original intent and exact ACK locator, and consumes once", () => {
  const { token, onConsumed } = issue();
  expect(token).not.toContain(draft.prompt);
  const handle = claimNewTaskDraftHandoff(token, profile, server)!;
  expect(handle.sourceIntent).toBe("source-route-intent");
  expect(returnNewTaskDraftHandoff(handle, profile, server, destination)).toBe(token);
  expect(onConsumed).not.toHaveBeenCalled();
  expect(consumeNewTaskDraftHandoff(token, profile, server, destination)).toEqual(draft);
  expect(onConsumed).toHaveBeenCalledOnce();
  expect(consumeNewTaskDraftHandoff(token, profile, server, destination)).toBeUndefined();
});

it("rejects a different original intent without consuming or clearing the source draft", () => {
  const { token, onConsumed } = issue();
  expect(returnNewTaskDraftHandoff({ token, sourceIntent: "unrelated-new-intent" }, profile, server, destination)).toBeUndefined();
  expect(onConsumed).not.toHaveBeenCalled();
  expect(claimNewTaskDraftHandoff(token, profile, server)).toBeUndefined();
});

it.each(["cwd", "operationReceiptId", "operationSourcePath"] as const)("rejects a different returned %s and burns the nonce", field => {
  const { token, onConsumed } = issue();
  returnNewTaskDraftHandoff(claimNewTaskDraftHandoff(token, profile, server), profile, server, destination);
  expect(consumeNewTaskDraftHandoff(token, profile, server, { ...destination, [field]: "/different" })).toBeUndefined();
  expect(consumeNewTaskDraftHandoff(token, profile, server, destination)).toBeUndefined();
  expect(onConsumed).not.toHaveBeenCalled();
});

it.each([
  { ...profile, authMode: "legacy" as const },
  { ...profile, authorizationGeneration: "auth-B" },
  { ...profile, deviceId: "device-B" },
  { ...profile, id: "profile-B" },
])("burns a nonce when the authorization family changes", changed => {
  const { token, onConsumed } = issue();
  expect(retainNewTaskDraftHandoffProfile(token, changed)).toBe(false);
  expect(claimNewTaskDraftHandoff(token, profile, server)).toBeUndefined();
  expect(onConsumed).not.toHaveBeenCalled();
});

it("rejects changed target identity and explicit cancellation", () => {
  const first = issue();
  expect(claimNewTaskDraftHandoff(first.token, profile, { ...server, id: "target-B" })).toBeUndefined();
  const second = issue();
  revokeNewTaskDraftHandoff(second.token);
  expect(claimNewTaskDraftHandoff(second.token, profile, server)).toBeUndefined();
  expect(first.onConsumed).not.toHaveBeenCalled();
  expect(second.onConsumed).not.toHaveBeenCalled();
});

it("expires at the TTL and evicts the oldest entry at the bounded capacity", () => {
  const first = issue();
  for (let index = 0; index < 8; index++) issue();
  expect(claimNewTaskDraftHandoff(first.token, profile, server)).toBeUndefined();
  const fresh = issue();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + NEW_TASK_DRAFT_HANDOFF_TTL_MS);
  expect(claimNewTaskDraftHandoff(fresh.token, profile, server)).toBeUndefined();
  expect(fresh.onConsumed).not.toHaveBeenCalled();
});
