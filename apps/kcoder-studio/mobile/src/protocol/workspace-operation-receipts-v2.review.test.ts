import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  workspaceMutationV2,
  workspaceParamsDigestV2,
  workspaceReadV2,
  workspaceScopeV2,
  sameWorkspaceScopeV2,
  type WorkspaceMutationMethodV2,
  type WorkspaceScopeV2,
} from "./workspace-operation-receipts-v2";

const scope: WorkspaceScopeV2 = {
  version: 2,
  rootId: "a".repeat(64),
  scopeId: "b".repeat(64),
  familyId: "d".repeat(64),
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("workspace receipt V2 protocol review", () => {
  it.each([
    {
      method: "runtime.workspaces.prepareV2" as const,
      params: {
        workspacePath: '/srv/雪/quote"and\\slash',
        clientRequestId: "req-雪-😀",
        action: "create",
        label: 'Workspace "雪" \\ west',
        projectId: 17,
        scopeId: scope.scopeId,
        runtime: "kcoder",
      },
      // Compact serde_json-compatible JSON for [method, recursively key-sorted params].
      canonicalTuple: String.raw`["runtime.workspaces.prepareV2",{"action":"create","clientRequestId":"req-雪-😀","label":"Workspace \"雪\" \\ west","projectId":17,"runtime":"kcoder","scopeId":"${scope.scopeId}","workspacePath":"/srv/雪/quote\"and\\slash"}]`,
      expected: "8289f21a9fbde203dcc40200dedbe864882e4837a54657552aaeab2c9476e80a",
    },
    {
      method: "runtime.worktrees.prepareV2" as const,
      params: {
        sourcePath: "/srv/é/🚀",
        worktreeId: "worktree-17",
        permanent: false,
        ref: 'feature/雪 "quoted"',
        clientRequestId: "req-🚀-18",
        scopeId: "c".repeat(64),
      },
      canonicalTuple: String.raw`["runtime.worktrees.prepareV2",{"clientRequestId":"req-🚀-18","permanent":false,"ref":"feature/雪 \"quoted\"","scopeId":"${"c".repeat(64)}","sourcePath":"/srv/é/🚀","worktreeId":"worktree-17"}]`,
      expected: "ee20497d856e5c5dcd36e7202260198b6341ee905aeb4c04b3244956be3ae244",
    },
  ])("matches the fixed canonical tuple digest for $method", ({ method, params, canonicalTuple, expected }) => {
    // Static contract vector for the documented Rust serde_json tuple shape; no Rust process is launched here.
    expect(JSON.parse(canonicalTuple)).toEqual([method, params]);
    expect(sha256(canonicalTuple)).toBe(expected);
    expect(workspaceParamsDigestV2(method, params)).toBe(expected);
    expect(workspaceParamsDigestV2(method, Object.fromEntries(Object.entries(params).reverse()))).toBe(expected);
  });

  it("requires exact scope, operation identity, digest and explicit unknown semantics", () => {
    const method: WorkspaceMutationMethodV2 = "runtime.workspaces.openV2";
    const params = { clientRequestId: "request-1", scopeId: scope.scopeId, workspacePath: "/srv/project" };
    const paramsDigest = workspaceParamsDigestV2(method, params);

    expect(workspaceScopeV2(scope)).toEqual(scope);
    expect(workspaceReadV2({ scope, receipt: null }, scope, "request-1", method, paramsDigest)).toBeNull();
    expect(workspaceReadV2({
      scope,
      receipt: {
        clientRequestId: "request-1",
        method,
        paramsDigest,
        status: "unknown",
        workspacePath: null,
      },
    }, scope, "request-1", method, paramsDigest)).toMatchObject({ status: "unknown", workspacePath: null });

    expect(() => workspaceReadV2({ scope: { ...scope, scopeId: "d".repeat(64) }, receipt: null }, scope, "request-1", method, paramsDigest)).toThrow();
    expect(() => workspaceReadV2({ scope, receipt: { clientRequestId: "other", method, paramsDigest, status: "unknown", workspacePath: null } }, scope, "request-1", method, paramsDigest)).toThrow();
    expect(() => workspaceReadV2({ scope, receipt: { clientRequestId: "request-1", method, paramsDigest, status: "unknown", workspacePath: "/srv/project" } }, scope, "request-1", method, paramsDigest)).toThrow();
    expect(() => workspaceScopeV2({ ...scope, deviceId: "caller-controlled" })).toThrow();
    expect(() => workspaceScopeV2({ ...scope, familyId: "not-a-namespace" })).toThrow();
    expect(sameWorkspaceScopeV2(scope, { ...scope, familyId: "e".repeat(64) })).toBe(false);
    expect(() => workspaceReadV2({ scope: { ...scope, familyId: "e".repeat(64) }, receipt: null }, scope, "request-1", method, paramsDigest)).toThrow();
    expect(() => workspaceReadV2({ scope: { ...scope, rootId: "f".repeat(64) }, receipt: null }, scope, "request-1", method, paramsDigest)).toThrow();
    expect(() => workspaceReadV2({ scope: { ...scope, scopeId: "e".repeat(64) }, receipt: null }, scope, "request-1", method, paramsDigest)).toThrow();
  });

  it("accepts a ready mutation only when result and receipt agree", () => {
    const method: WorkspaceMutationMethodV2 = "runtime.workspaces.prepareV2";
    const params = { clientRequestId: "request-ready", scopeId: scope.scopeId, workspacePath: "/srv/project", action: "create" };
    const paramsDigest = workspaceParamsDigestV2(method, params);
    const response = {
      scope,
      receipt: { clientRequestId: "request-ready", method, paramsDigest, status: "ready", workspacePath: "/srv/project" },
      result: { mapping: { workspacePath: "/srv/project" } },
    };

    expect(workspaceMutationV2(response, scope, "request-ready", method, paramsDigest)).toMatchObject({ status: "ready", workspacePath: "/srv/project" });
    expect(() => workspaceMutationV2({ ...response, result: { mapping: { workspacePath: "/srv/other" } } }, scope, "request-ready", method, paramsDigest)).toThrow();
  });

  it("rejects digest inputs above the bounded protocol size", () => {
    expect(() => workspaceParamsDigestV2("runtime.workspaces.openV2", {
      clientRequestId: "request-large",
      scopeId: scope.scopeId,
      workspacePath: "/srv/" + "x".repeat(17_000),
    })).toThrow("参数过大");
  });
});
