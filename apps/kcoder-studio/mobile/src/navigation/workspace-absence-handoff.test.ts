import { afterEach, expect, it, vi } from "vitest";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import type { WorkspacePresenceObservation } from "@/runtime/task-runtime/workspace-presence";
import { captureSessionTranscriptScope } from "@/storage/session-transcript-scope";
import { claimWorkspaceAbsenceHandoff, createWorkspaceAbsenceHandoff, forwardWorkspaceAbsenceHandoff, peekWorkspaceAbsenceHandoff,
  revokeWorkspaceAbsenceHandoff, WORKSPACE_ABSENCE_HANDOFF_TTL_MS, workspaceAbsenceHandoffParent, workspaceAbsenceHandoffServerId } from "./workspace-absence-handoff";

const profile: GatewayProfile = { id: "handoff", label: "Test", baseUrl: "https://handoff.invalid", authMode: "device", authorizationGeneration: "family-A",
  deviceId: "device-A", accessToken: "test-only", rpcToken: "test-only", expiresAt: Number.MAX_SAFE_INTEGER };
const server: KCoderServer = { id: "local", label: "Local", description: "Test", runtime: "kcoder", transport: "local", workspacePath: "/workspace", observationTargetIdentity: "a".repeat(64) };
const owner = () => ({ current: true, isCurrent() { return this.current; } });
let lastToken: string | undefined;
function proof(cwd = "/workspace/deleted", target = server): WorkspacePresenceObservation {
  return { result: { version: 1, status: "absent", targetId: target.id, targetSignature: target.observationTargetIdentity!, workspacePath: cwd,
    loginGeneration: 3, observedAt: Date.now() }, scope: captureSessionTranscriptScope(profile, target, cwd, "thread-A"), witness: null, isCurrent: () => true };
}
function mint(observation = proof(), target = server): string {
  const token = createWorkspaceAbsenceHandoff({ profile, server: target, cwd: observation.scope.cwd, threadId: observation.scope.threadId,
    observation, isCurrent: () => true });
  expect(token).toEqual(expect.any(String)); lastToken = token!; return token!;
}
afterEach(() => { revokeWorkspaceAbsenceHandoff(lastToken); lastToken = undefined; vi.useRealTimers(); });

it("pure peeks from abandoned Home and form renders never consume the committed receiver's handoff", () => {
  const token = mint(), abandoned = owner(), home = owner(), form = owner();
  expect(peekWorkspaceAbsenceHandoff(token, "home", abandoned, profile, server)).not.toBeNull();
  abandoned.current = false;
  expect(peekWorkspaceAbsenceHandoff(token, "home", home, profile, server)).not.toBeNull();
  expect(forwardWorkspaceAbsenceHandoff(token, home, profile, server)).toBe(token);
  expect(peekWorkspaceAbsenceHandoff(token, "form", owner(), profile, server)).not.toBeNull();
  revokeWorkspaceAbsenceHandoff(token, home);
  const accepted = claimWorkspaceAbsenceHandoff(token, "form", form, profile, server);
  expect(accepted?.absentCwd).toBe("/workspace/deleted");
  expect(claimWorkspaceAbsenceHandoff(token, "form", form, profile, server)).toBe(accepted);
  expect(claimWorkspaceAbsenceHandoff(token, "form", owner(), profile, server)).toBeNull();
  expect(forwardWorkspaceAbsenceHandoff(token, home, profile, server)).toBeUndefined();
});

it("a committed receiver's A to B to A ownership cannot reactivate its old handoff", () => {
  const token = mint(), first = owner();
  expect(claimWorkspaceAbsenceHandoff(token, "home", first, profile, server)).not.toBeNull();
  first.current = false;
  expect(claimWorkspaceAbsenceHandoff(token, "home", owner(), profile, server)).toBeNull();
  expect(forwardWorkspaceAbsenceHandoff(token, first, profile, server)).toBeUndefined();
});

it.each(["authorization", "device", "endpoint", "opaque", "connection", "root"] as const)("%s drift rejects and burns a claim without touching preferences", change => {
  const token = mint(), home = owner();
  const nextProfile = { ...profile }, nextServer = { ...server };
  if (change === "authorization") nextProfile.authorizationGeneration = "family-B";
  if (change === "device") nextProfile.deviceId = "device-B";
  if (change === "endpoint") nextProfile.baseUrl = "https://other.invalid";
  if (change === "opaque") nextServer.observationTargetIdentity = "b".repeat(64);
  if (change === "connection") nextServer.command = "other-runtime";
  if (change === "root") nextServer.workspacePath = "/other";
  expect(claimWorkspaceAbsenceHandoff(token, "home", home, nextProfile, nextServer)).toBeNull();
  expect(claimWorkspaceAbsenceHandoff(token, "home", home, profile, server)).toBeNull();
});

it.each(["cancelled", "unknown", "path", "thread", "target"] as const)("%s observation cannot mint a handoff", change => {
  const observation = proof();
  if (change === "cancelled") observation.isCurrent = () => false;
  if (change === "unknown") observation.result.status = "unknown" as "absent";
  if (change === "path") observation.result.workspacePath = "/workspace/peer";
  if (change === "thread") observation.scope.threadId = "peer-thread";
  if (change === "target") observation.result.targetSignature = "b".repeat(64);
  expect(createWorkspaceAbsenceHandoff({ profile, server, cwd: "/workspace/deleted", threadId: "thread-A", observation, isCurrent: () => true })).toBeNull();
});

it("uses a local mint TTL, permits remote clock skew, and retains at most one pending hint", () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const observation = proof(); observation.result.observedAt = Date.now() + 86_400_000;
  const first = mint(observation), second = mint();
  expect(workspaceAbsenceHandoffServerId(first)).toBeUndefined();
  expect(workspaceAbsenceHandoffServerId(second)).toBe(server.id);
  vi.advanceTimersByTime(WORKSPACE_ABSENCE_HANDOFF_TTL_MS);
  expect(peekWorkspaceAbsenceHandoff(second, "home", owner(), profile, server)).toBeNull();
  expect(forwardWorkspaceAbsenceHandoff(second, owner(), profile, server)).toBeUndefined();
});

it("selects only the closest current catalog ancestor on a path segment boundary", () => {
  const token = mint(), value = peekWorkspaceAbsenceHandoff(token, "home", owner(), profile, server)!;
  expect(workspaceAbsenceHandoffParent(value, [{ path: "/work" }, { path: "/" }, { path: "/workspace" }, { path: "/workspace/deleted" }])).toBe("/workspace");
  expect(workspaceAbsenceHandoffParent(value, [{ path: "/work" }, { path: "/workspace/peer" }])).toBeUndefined();
  expect(workspaceAbsenceHandoffParent(value, [])).toBeUndefined();
});

it("normalizes drive separators while preserving POSIX literal backslashes", () => {
  const windows = { ...server, workspacePath: "C:\\workspace" };
  const token = mint(proof("C:\\workspace\\deleted", windows), windows);
  const value = peekWorkspaceAbsenceHandoff(token, "home", owner(), profile, windows)!;
  expect(value.absentCwd).toBe("C:/workspace/deleted");
  expect(workspaceAbsenceHandoffParent(value, [{ path: "C:/" }, { path: "C:\\workspace" }])).toBe("C:\\workspace");
  const posix = proof("/workspace\\literal/deleted");
  const posixToken = mint(posix);
  const posixValue = peekWorkspaceAbsenceHandoff(posixToken, "home", owner(), profile, server)!;
  expect(workspaceAbsenceHandoffParent(posixValue, [{ path: "/workspace" }])).toBeUndefined();
  expect(workspaceAbsenceHandoffParent(posixValue, [{ path: "/workspace\\literal" }])).toBe("/workspace\\literal");
});
