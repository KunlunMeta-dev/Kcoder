import { expect, it, vi } from "vitest";
import { captureSessionTranscriptScope, decodeSessionTranscriptScope, sessionTranscriptScopeKey } from "./session-transcript-scope";
import { projectConfirmedTranscript, decodeConfirmedTranscript, transcriptUtf8Size } from "./session-transcript-projection";
import type { ThreadMessage } from "@/gateway/types";

const profile = { id: "p", baseUrl: "https://gateway.example/g/id", label: "Gateway", authMode: "device" as const,
  authorizationGeneration: "generation", deviceId: "device", accessToken: "NEVER_CACHE_ACCESS", rpcToken: "NEVER_CACHE_RPC", expiresAt: 1 };
const server = { id: "s", runtime: "kcoder" as const, transport: "ssh" as const, host: "host", user: "u", port: 22,
  label: "Server", description: "", workspacePath: "/workspace", accountIdentity: { principalId: "principal", username: "u", role: "member" } };
const scope = captureSessionTranscriptScope(profile, server, "/workspace/", "t");
const row = (id: string, status?: string): ThreadMessage => ({ id, role: "assistant", content: id, timestampMs: 1, status });

it("captures complete display identity without credentials; short token rotation is immaterial", () => {
  expect(sessionTranscriptScopeKey(scope)).toBe(sessionTranscriptScopeKey(captureSessionTranscriptScope({ ...profile, accessToken: "new", expiresAt: 50 }, server, "/workspace", "t")));
  expect(JSON.stringify(scope)).not.toContain("NEVER_CACHE");
  const commandScope = captureSessionTranscriptScope(profile, { ...server, command: "/bin/command --token COMMAND_SECRET" }, "/workspace", "t");
  expect(JSON.stringify(commandScope)).not.toMatch(/COMMAND_SECRET|\/bin\/command/);
  expect(commandScope.target.connectionFingerprint).toMatch(/^[a-f0-9]{64}$/);
  for (const changed of [{ deviceId: "other" }, { authorizationGeneration: "other" }, { authMode: "legacy" as const }, { baseUrl: "https://other" }]) {
    expect(sessionTranscriptScopeKey(captureSessionTranscriptScope({ ...profile, ...changed }, server, "/workspace", "t"))).not.toBe(sessionTranscriptScopeKey(scope));
  }
  for (const changed of [{ command: "/new/bin" }, { accountIdentity: { ...server.accountIdentity, role: "admin" } }, { workspacePath: "/other" }]) {
    expect(sessionTranscriptScopeKey(captureSessionTranscriptScope(profile, { ...server, ...changed }, "/workspace", "t"))).not.toBe(sessionTranscriptScopeKey(scope));
  }
  expect(decodeSessionTranscriptScope(JSON.parse(JSON.stringify(scope)))).toEqual(scope);
  expect(decodeSessionTranscriptScope({ ...scope, extra: true })).toBeNull();
  expect(() => captureSessionTranscriptScope({ ...profile, deviceId: undefined }, server, "/workspace", "t")).toThrow();
  expect(() => captureSessionTranscriptScope(profile, { ...server, accountIdentity: undefined }, "/workspace", "t")).toThrow();
});

it("keeps only authoritative terminal rows and display block fields, reusing the existing normalizer", () => {
  const page = { messages: [row("old"), row("local-optimistic", "done"), row("pending", "accepted"), row("unknown", "unknown"),
    { ...row("active", "completed"), turnId: "live" }, { ...row("done", "completed"),
      blocks: [{ type: "text", id: "block", content: "original", chunkTail: { content: "unsafe" }, callback: "unsafe" }],
      accessToken: "unsafe", interaction: { requestId: "unsafe" } }], rangeStart: 10, rangeEnd: 16, hasMoreBefore: true, beforeCursor: "connection-only" };
  const result = projectConfirmedTranscript(scope, page, { title: "Title", activeTurnId: "live", updatedAt: 20 });
  expect(result.messages.map(message => message.id)).toEqual(["old", "done"]);
  expect(result.messages[1].blocks).toEqual([{ type: "text", id: "block", content: "original" }]);
  expect(JSON.stringify(result)).not.toMatch(/unsafe|connection-only|activeTurnId/);
  expect(decodeConfirmedTranscript(JSON.stringify(result), scope)?.view.messages[1].orderedBlocks?.[0]).toMatchObject({ kind: "text", content: "original" });
  expect(result.coverage).toMatchObject({ rangeStart: 10, rangeEnd: 16, complete: false });
});

it("bounds rows and UTF8 bytes by dropping whole rows; never truncates a message", () => {
  const result = projectConfirmedTranscript(scope, { messages: Array.from({ length: 220 }, (_, i) => row(`m${i}`)) }, { title: "Title", updatedAt: 20 });
  expect(result.messages).toHaveLength(200); expect(result.messages[0].id).toBe("m20");
  const huge = { ...row("huge"), content: "界".repeat(200_000) };
  const bounded = projectConfirmedTranscript(scope, { messages: [row("small"), huge] }, { title: "Title", updatedAt: 20 });
  expect(bounded.messages.map(message => message.id)).toEqual(["small"]);
  expect(transcriptUtf8Size(JSON.stringify(bounded))).toBeLessThanOrEqual(512 * 1024);
  expect(decodeConfirmedTranscript("x".repeat(512 * 1024 + 1), scope)).toBeNull();
  expect(decodeConfirmedTranscript("{", scope)).toBeNull();
});

it("rejects mismatched ownership and cached nonterminal or additional authority fields", () => {
  const result = projectConfirmedTranscript(scope, { messages: [row("done")] }, { title: "Title", updatedAt: 20 });
  expect(decodeConfirmedTranscript(JSON.stringify(result), { ...scope, threadId: "other" })).toBeNull();
  expect(decodeConfirmedTranscript(JSON.stringify({ ...result, running: true }), scope)).toBeNull();
  expect(decodeConfirmedTranscript(JSON.stringify({ ...result, messages: [row("bad", "streaming")] }), scope)).toBeNull();
});

it("rejects invalid runtime enums and noncanonical or credential-bearing Gateway URLs", () => {
  for (const authMode of ["other", 1, null]) expect(() => captureSessionTranscriptScope({ ...profile, authMode } as never, server, "/workspace", "t")).toThrow();
  for (const transport of ["http", 1, null]) expect(() => captureSessionTranscriptScope(profile, { ...server, transport } as never, "/workspace", "t")).toThrow();
  expect(() => captureSessionTranscriptScope(profile, { ...server, runtime: "other" } as never, "/workspace", "t")).toThrow();
  for (const baseUrl of ["https://u:password@gateway.example", "https://gateway.example/?token=secret", "https://gateway.example/#secret", "https://gateway.example/", "file:///private"]) {
    expect(() => captureSessionTranscriptScope({ ...profile, baseUrl }, server, "/workspace", "t")).toThrow();
  }
  expect(decodeSessionTranscriptScope({ ...scope, profile: { ...scope.profile, authMode: "other" } })).toBeNull();
  expect(decodeSessionTranscriptScope({ ...scope, target: { ...scope.target, transport: "http" } })).toBeNull();
});

it("sizes nonASCII and surrogate pairs without a native TextEncoder global", () => {
  expect(transcriptUtf8Size("a界😀\ud800")).toBe(11);
});

it("budgets a large page with only two full-envelope serializations", () => {
  const messages = Array.from({ length: 200 }, (_, index) => ({ ...row(`large-${index}`), content: "x".repeat(256 * 1024) }));
  const stringify = vi.spyOn(JSON, "stringify");
  const started = performance.now();
  const result = projectConfirmedTranscript(scope, { messages }, { title: "Title", updatedAt: 20 });
  const elapsedMs = performance.now() - started;
  const fullPageSerializations = stringify.mock.calls.filter(([value]) => value && typeof value === "object" && "scope" in value && "messages" in value).length;
  stringify.mockRestore();
  expect(fullPageSerializations).toBe(2);
  expect(result.messages.map(message => message.id)).toEqual(["large-199"]);
  process.stdout.write(`${JSON.stringify({ kind: "projection-cost-observation", inputRows: 200, inputContentBytes: 200 * 256 * 1024, cachedRows: result.messages.length, elapsedMs })}\n`);
});

it("persists visible user content and attachment descriptors without hidden context payload", () => {
  const content = '<relevant-memories>INTERNAL_SENTINEL</relevant-memories>\nUser body\n' +
    '<kcoder_client_context>INTERNAL_SENTINEL</kcoder_client_context>' +
    '<kcoder_client_attachments>INTERNAL_SENTINEL</kcoder_client_attachments>' +
    '<kcoder_attachments>{"filename":"visible.png","mimeType":"image/png","fileSize":12,"path":"/workspace/attachments/visible.png","context":"INTERNAL_SENTINEL"}</kcoder_attachments>';
  const result = projectConfirmedTranscript(scope, { messages: [{ ...row("user"), role: "user", content }] }, { title: "Title", updatedAt: 20 });
  const raw = JSON.stringify(result);
  expect(raw).not.toMatch(/INTERNAL_SENTINEL|kcoder_client|kcoder_attachments|relevant-memories/);
  const view = decodeConfirmedTranscript(raw, scope)?.view;
  expect(view?.messages[0].content).toBe("User body");
  expect(view?.messages[0].attachments).toEqual([{ filename: "visible.png", mimeType: "image/png", fileSize: 12, path: "/workspace/attachments/visible.png" }]);
});
