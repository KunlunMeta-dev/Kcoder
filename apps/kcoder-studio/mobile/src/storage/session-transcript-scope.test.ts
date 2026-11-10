import { expect, it } from "vitest";
import type { SessionTranscriptScope } from "./session-transcript-scope";
import { captureSessionTranscriptScope, decodeSessionTranscriptScope, sessionTranscriptWorkspaceScopeKey } from "./session-transcript-scope";

const profile = { id: "p", baseUrl: "https://gateway.example", label: "", authMode: "device" as const, authorizationGeneration: "g", deviceId: "d", accessToken: "secret", rpcToken: "secret", expiresAt: 1 };
const server = { id: "s", label: "", description: "", runtime: "kcoder" as const, transport: "local" as const, workspacePath: "/workspace" };

it("defines one workspace prefix across threads but includes every display owner dimension", () => {
  const first = captureSessionTranscriptScope(profile, server, "/workspace", "thread-a");
  const second = captureSessionTranscriptScope(profile, server, "/workspace", "thread-b");
  const key = sessionTranscriptWorkspaceScopeKey(first);
  expect(sessionTranscriptWorkspaceScopeKey(second)).toBe(key);

  const variants: SessionTranscriptScope[] = [
    { ...first, profile: { ...first.profile, id: "other-profile" } },
    { ...first, profile: { ...first.profile, baseUrl: "https://elsewhere.example" } },
    { ...first, profile: { ...first.profile, authorizationGeneration: "new-generation" } },
    { ...first, profile: { ...first.profile, deviceId: "other-device" } },
    { ...first, profile: { ...first.profile, authMode: "legacy" } },
    { ...first, target: { ...first.target, id: "other-target" } },
    { ...first, target: { ...first.target, transport: "ssh", principalId: "alice", role: "owner" } },
    { ...first, target: { ...first.target, connectionFingerprint: "f".repeat(64) } },
    { ...first, target: { ...first.target, principalId: "alice", role: "owner" } },
    { ...first, target: { ...first.target, workspacePath: "/another-workspace" } },
    { ...first, cwd: "/workspace/subdir" },
  ];
  for (const variant of variants) expect(sessionTranscriptWorkspaceScopeKey(variant)).not.toBe(key);
});

it.each(["C:\\Users\\me\\workspace", "C:\\"])("captures an actual Windows cwd and target workspace without changing exact spelling (%s)", cwd => {
  const captured = captureSessionTranscriptScope(profile, { ...server, workspacePath: cwd }, cwd, "windows-thread");
  expect(captured.cwd).toBe(cwd); expect(captured.target.workspacePath).toBe(cwd);
  expect(decodeSessionTranscriptScope(captured)).toEqual(captured);
  expect(sessionTranscriptWorkspaceScopeKey(captured)).not.toContain("windows-thread");
});

it("keeps a POSIX filename backslash distinct from a path separator", () => {
  const literal = captureSessionTranscriptScope(profile, server, "/workspace/part\\name", "t");
  const separated = captureSessionTranscriptScope(profile, server, "/workspace/part/name", "t");
  expect(sessionTranscriptWorkspaceScopeKey(literal)).not.toBe(sessionTranscriptWorkspaceScopeKey(separated));
});
