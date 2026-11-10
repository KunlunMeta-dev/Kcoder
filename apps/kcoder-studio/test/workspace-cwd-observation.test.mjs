import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createWorkspaceCwdObservationCoordinator,
  createWorkspaceCwdObservationHttpHandler,
  createWorkspaceCwdObservationService,
  normalizeWorkspaceCwdPath,
  observeWorkspaceCwd,
  workspaceCwdObservationTargetIdentity as targetIdentity,
  WORKSPACE_CWD_MAX_PATH_LENGTH,
  WORKSPACE_CWD_MAX_SEGMENTS,
} from "../src/workspace-cwd-observation.js";

async function temporaryDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "kcoder-cwd-observation-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function errorWithCode(code) {
  return Object.assign(new Error(code), { code });
}

function symlinkInfo() {
  return { isSymbolicLink: () => true, isDirectory: () => false };
}

function directoryInfo(isDirectory = true) {
  return { isSymbolicLink: () => false, isDirectory: () => isDirectory };
}

test("normalizes only bounded absolute workspace paths", () => {
  assert.equal(normalizeWorkspaceCwdPath("relative/workspace"), null);
  assert.equal(normalizeWorkspaceCwdPath(""), null);
  assert.equal(normalizeWorkspaceCwdPath("/tmp/\0workspace"), null);
  assert.equal(normalizeWorkspaceCwdPath("/".padEnd(WORKSPACE_CWD_MAX_PATH_LENGTH + 1, "x")), null);
  assert.equal(
    normalizeWorkspaceCwdPath(join("/", ...Array(WORKSPACE_CWD_MAX_SEGMENTS + 1).fill("segment"))),
    null,
  );
  assert.ok(normalizeWorkspaceCwdPath(tmpdir()));
});

test("reports present only for a real directory", async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, "workspace");
  await mkdir(directory);
  assert.deepEqual(await observeWorkspaceCwd("local", directory), { status: "present" });

  const file = join(root, "file");
  await writeFile(file, "x");
  assert.deepEqual(await observeWorkspaceCwd("local", file), {
    status: "unknown",
    reason: "not_directory",
  });
});

test("reports absent only when the exact path is missing under an observable directory", async (t) => {
  const root = await temporaryDirectory(t);
  const missing = join(root, "deleted-workspace");
  assert.deepEqual(await observeWorkspaceCwd("local", missing), { status: "absent" });

  const nestedMissing = join(root, "missing-parent", "deleted-workspace");
  assert.deepEqual(await observeWorkspaceCwd("local", nestedMissing), {
    status: "unknown",
    reason: "parent_missing",
  });
});

test("treats final and parent symlinks as unknown, including dangling parents", async (t) => {
  const root = await temporaryDirectory(t);
  const actual = join(root, "actual");
  await mkdir(actual);
  const finalLink = join(root, "workspace-link");
  await symlink(actual, finalLink);
  assert.deepEqual(await observeWorkspaceCwd("local", finalLink), {
    status: "unknown",
    reason: "symlink",
  });

  const danglingParent = join(root, "dangling-parent");
  await symlink(join(root, "does-not-exist"), danglingParent);
  assert.deepEqual(await observeWorkspaceCwd("local", join(danglingParent, "workspace")), {
    status: "unknown",
    reason: "parent_symlink",
  });
  assert.deepEqual(
    await observeWorkspaceCwd("local", join(danglingParent, "missing-child", "workspace")),
    { status: "unknown", reason: "parent_symlink" },
  );
});

test("treats missing descendants behind a higher valid symlink as unknown", async (t) => {
  const root = await temporaryDirectory(t);
  const actual = join(root, "actual");
  const existingParent = join(actual, "existing");
  await mkdir(existingParent, { recursive: true });
  const link = join(root, "link");
  await symlink(actual, link);
  assert.deepEqual(await observeWorkspaceCwd("local", join(link, "existing", "missing")), {
    status: "unknown",
    reason: "parent_symlink",
  });
});

test("treats existing directories reached through a higher symlink as unknown", async (t) => {
  const root = await temporaryDirectory(t);
  const actual = join(root, "actual");
  const existingParent = join(actual, "existing");
  await mkdir(existingParent, { recursive: true });
  const link = join(root, "link");
  await symlink(actual, link);
  assert.deepEqual(await observeWorkspaceCwd("local", join(link, "existing")), {
    status: "unknown",
    reason: "parent_symlink",
  });
});

test("keeps permission, I/O, ENOTDIR, and parent failures unknown", async () => {
  for (const [code, expectedReason] of [
    ["EACCES", "permission_denied"],
    ["EPERM", "permission_denied"],
    ["EIO", "io_error"],
    ["ENOTDIR", "not_directory"],
  ]) {
    const result = await observeWorkspaceCwd("local", "/observer-target", {
      lstat: async () => {
        throw errorWithCode(code);
      },
    });
    assert.deepEqual(result, { status: "unknown", reason: expectedReason }, code);
  }

  const parentDenied = await observeWorkspaceCwd("local", "/observer-parent/target", {
    lstat: async (path) => {
      if (path === "/") return directoryInfo();
      if (path === "/observer-parent") throw errorWithCode("EACCES");
      throw errorWithCode("EACCES");
    },
  });
  assert.deepEqual(parentDenied, { status: "unknown", reason: "permission_denied" });

  const parentIsLink = await observeWorkspaceCwd("local", "/observer-parent/target", {
    lstat: async (path) => {
      if (path === "/") return directoryInfo();
      if (path === "/observer-parent") return symlinkInfo();
      return symlinkInfo();
    },
  });
  assert.deepEqual(parentIsLink, { status: "unknown", reason: "parent_symlink" });

  const parentNotDirectory = await observeWorkspaceCwd("local", "/observer-parent/target", {
    lstat: async (path) => {
      if (path === "/") return directoryInfo();
      if (path === "/observer-parent") return directoryInfo(false);
      return { isSymbolicLink: () => false, isDirectory: () => false };
    },
  });
  assert.deepEqual(parentNotDirectory, { status: "unknown", reason: "not_directory" });
});

test("unsupported transports never invoke filesystem observation", async () => {
  let lstatCalled = false;
  assert.deepEqual(
    await observeWorkspaceCwd("ssh", "/tmp/workspace", {
      lstat: async () => {
        lstatCalled = true;
        throw new Error("must not touch local filesystem for SSH");
      },
    }),
    { status: "unknown", reason: "unsupported_transport" },
  );
  assert.equal(lstatCalled, false);
});

test("scope service returns a pinned result only when target and login generation remain stable", async () => {
  let target = { id: "local", transport: "local" };
  let generation = 4;
  const session = { allowedServerIds: new Set(["local"]) };
  const service = createWorkspaceCwdObservationService({
    getTarget: (id) => (id === "local" ? target : null),
    getSession: () => session,
    getLoginOwner: () => "private-owner",
    getLoginGeneration: () => generation,
    getTargetSignature: (value) => JSON.stringify(value),
    observe: async () => ({ status: "present" }),
    now: () => 123,
  });

  const stable = await service({ targetId: "local", workspacePath: "/tmp/workspace", expectedTargetIdentity: targetIdentity(JSON.stringify(target)) });
  assert.equal(stable.authorized, true);
  assert.equal(stable.status, "present");
  assert.equal(stable.loginGeneration, 4);
  assert.equal(stable.observedAt, 123);
  assert.equal(stable.targetSignature.length, 64);
  assert.equal("loginOwner" in stable, false);

  const generationRace = createWorkspaceCwdObservationService({
    getTarget: (id) => (id === "local" ? target : null),
    getSession: () => session,
    getLoginOwner: () => "private-owner",
    getLoginGeneration: () => generation,
    getTargetSignature: (value) => JSON.stringify(value),
    observe: async () => {
      generation += 1;
      return { status: "absent" };
    },
  });
  const racedGeneration = await generationRace({ targetId: "local", workspacePath: "/tmp/workspace", expectedTargetIdentity: targetIdentity(JSON.stringify(target)) });
  assert.deepEqual(
    { status: racedGeneration.status, reason: racedGeneration.reason },
    { status: "unknown", reason: "scope_changed" },
  );

  generation = 6;
  const targetRace = createWorkspaceCwdObservationService({
    getTarget: (id) => (id === "local" ? target : null),
    getSession: () => session,
    getLoginOwner: () => "private-owner",
    getLoginGeneration: () => generation,
    getTargetSignature: (value) => JSON.stringify(value),
    observe: async () => {
      target = { ...target, cwd: "/tmp/replaced" };
      return { status: "absent" };
    },
  });
  const racedTarget = await targetRace({ targetId: "local", workspacePath: "/tmp/workspace", expectedTargetIdentity: targetIdentity(JSON.stringify(target)) });
  assert.deepEqual(
    { status: racedTarget.status, reason: racedTarget.reason },
    { status: "unknown", reason: "scope_changed" },
  );
});

test("scope service awaits current target authorization before and after observation", async () => {
  let allowed = true;
  const session = { get allowedServerIds() { return new Set(allowed ? ["local"] : []); } };
  const service = createWorkspaceCwdObservationService({
    getTarget: () => ({ id: "local", transport: "local" }),
    getSession: async () => session,
    getLoginOwner: () => "owner",
    getLoginGeneration: () => 0,
    getTargetSignature: () => "target-signature",
    observe: async () => {
      allowed = false;
      return { status: "present" };
    },
  });
  assert.deepEqual(
    await service({ targetId: "local", workspacePath: "/tmp/workspace", expectedTargetIdentity: targetIdentity("target-signature") }),
    { authorized: false },
  );
});

test("scope service refuses a target outside the existing allowedServerIds set", async () => {
  let observed = false;
  const service = createWorkspaceCwdObservationService({
    getTarget: () => ({ id: "local", transport: "local" }),
    getSession: () => ({ allowedServerIds: new Set(["other"]) }),
    getLoginOwner: () => "owner",
    getLoginGeneration: () => 0,
    getTargetSignature: () => "target-signature",
    observe: async () => {
      observed = true;
      return { status: "present" };
    },
  });
  assert.deepEqual(
    await service({ targetId: "local", workspacePath: "/tmp/workspace" }),
    { authorized: false },
  );
  assert.equal(observed, false);
});

test("scope service fences a result when the login owner changes in flight", async () => {
  let loginOwner = "owner-before";
  const session = { allowedServerIds: new Set(["local"]) };
  const service = createWorkspaceCwdObservationService({
    getTarget: () => ({ id: "local", transport: "local" }),
    getSession: () => session,
    getLoginOwner: () => loginOwner,
    getLoginGeneration: () => 2,
    getTargetSignature: () => "target-signature",
    observe: async () => {
      loginOwner = "owner-after";
      return { status: "absent" };
    },
  });
  const result = await service({ targetId: "local", workspacePath: "/tmp/workspace", expectedTargetIdentity: targetIdentity("target-signature") });
  assert.deepEqual(
    { status: result.status, reason: result.reason },
    { status: "unknown", reason: "scope_changed" },
  );
  assert.equal("loginOwner" in result, false);
});

test("HTTP handler enforces the live target ACL and detects target replacement", async () => {
  let serversById = new Map([["local", { id: "local", transport: "local", revision: 1 }]]);
  const session = { allowedServerIds: new Set(["local"]) };
  let observationCalls = 0;
  const handler = createWorkspaceCwdObservationHttpHandler({
    gateway: {
      getTarget: (id) => serversById.get(id),
      authenticatedSession: () => session,
      requestLoginOwner: (_request, currentSession) => currentSession ? "owner" : null,
      loginContexts: { generation: () => 4 },
      serverHealthSignature: (target) => JSON.stringify(target),
      jsonResponse: (response, status, payload) => Object.assign(response, { status, payload }),
    },
    observe: async () => {
      observationCalls += 1;
      serversById = new Map([["local", { id: "local", transport: "local", revision: 2 }]]);
      return { status: "present" };
    },
  });
  const request = { method: "GET" };
  const requestUrl = new URL("http://gateway.test/api/servers/local/cwd-observation?workspace=%2Ftmp%2Fworkspace");
  requestUrl.searchParams.set("expectedTargetIdentity", targetIdentity(JSON.stringify(serversById.get("local"))));
  const deniedResponse = {};
  assert.equal(await handler({
    pathname: "/api/servers/local/cwd-observation",
    request,
    response: deniedResponse,
    requestUrl,
    authSession: { allowedServerIds: new Set(["other"]) },
  }), true);
  assert.equal(deniedResponse.status, 404);
  assert.equal(observationCalls, 0);

  const allowedResponse = {};
  assert.equal(await handler({
    pathname: "/api/servers/local/cwd-observation",
    request,
    response: allowedResponse,
    requestUrl,
    authSession: { allowedServerIds: new Set(["local"]) },
  }), true);
  assert.equal(allowedResponse.status, 200);
  assert.deepEqual(
    { status: allowedResponse.payload.status, reason: allowedResponse.payload.reason },
    { status: "unknown", reason: "scope_changed" },
  );
  assert.equal(observationCalls, 1);
  assert.equal(await handler({ pathname: "/api/servers/local", request, response: {}, requestUrl }), false);
});

test("bounds filesystem waits and keeps a timed-out target occupied until it settles", async () => {
  let releaseTargetObservation;
  let targetObservationStarted;
  const started = new Promise((resolve) => {
    targetObservationStarted = resolve;
  });
  const targetObservation = new Promise((resolve) => {
    releaseTargetObservation = resolve;
  });
  let targetCalls = 0;
  const coordinator = createWorkspaceCwdObservationCoordinator({ timeoutMs: 10 });
  const makeRequestService = (owner, generation) => {
    const session = { allowedServerIds: new Set(["local", "other"]) };
    return createWorkspaceCwdObservationService({
      getTarget: (id) => ({ id, transport: "local" }),
      getSession: () => session,
      getLoginOwner: () => owner,
      getLoginGeneration: () => generation,
      getTargetSignature: (target) => JSON.stringify(target),
      coordinator,
      observe: async (_transport, path) => {
        if (path === "/tmp/other") return { status: "present" };
        targetCalls += 1;
        targetObservationStarted();
        return targetObservation;
      },
    });
  };
  const firstRequestService = makeRequestService("owner-one", 1);
  const secondRequestService = makeRequestService("owner-two", 7);

  const localIdentity = targetIdentity(JSON.stringify({ id: "local", transport: "local" }));
  const timedRequest = firstRequestService({ targetId: "local", workspacePath: "/tmp/target", expectedTargetIdentity: localIdentity });
  await started;
  const timed = await timedRequest;
  assert.deepEqual(
    { status: timed.status, reason: timed.reason },
    { status: "unknown", reason: "timeout" },
  );

  const duplicate = await secondRequestService({ targetId: "local", workspacePath: "/tmp/target", expectedTargetIdentity: localIdentity });
  assert.deepEqual(
    { status: duplicate.status, reason: duplicate.reason },
    { status: "unknown", reason: "observation_in_progress" },
  );
  assert.equal(duplicate.loginGeneration, 7);
  assert.equal("loginOwner" in duplicate, false);
  assert.equal(targetCalls, 1);

  const other = await secondRequestService({ targetId: "other", workspacePath: "/tmp/other", expectedTargetIdentity: targetIdentity(JSON.stringify({ id: "other", transport: "local" })) });
  assert.equal(other.status, "present");

  releaseTargetObservation({ status: "absent" });
  await new Promise((resolve) => setImmediate(resolve));
  const afterSettle = await secondRequestService({ targetId: "local", workspacePath: "/tmp/target", expectedTargetIdentity: localIdentity });
  assert.equal(afterSettle.status, "absent");
  assert.equal(targetCalls, 2);
});

test("missing, malformed, stale, or duplicate inventory identity never starts observation", async () => {
  const target = { id: "local", transport: "local", revision: 2 };
  const identity = targetIdentity(JSON.stringify(target));
  let calls = 0;
  const session = { allowedServerIds: new Set(["local"]) };
  const gateway = {
    getTarget: () => target, authenticatedSession: () => session,
    requestLoginOwner: () => "owner", loginContexts: { generation: () => 1 },
    serverHealthSignature: value => JSON.stringify(value),
    jsonResponse: (response, status, payload) => Object.assign(response, { status, payload }),
  };
  const handler = createWorkspaceCwdObservationHttpHandler({ gateway, observe: async () => { calls += 1; return { status: "absent" }; } });
  for (const values of [[], ["bad"], [targetIdentity(JSON.stringify({ ...target, revision: 1 }))], [identity, identity]]) {
    const requestUrl = new URL("https://gateway.test/api/servers/local/cwd-observation?workspace=%2Ftmp%2Fabsent");
    for (const value of values) requestUrl.searchParams.append("expectedTargetIdentity", value);
    const response = {};
    await handler({ pathname: requestUrl.pathname, request: { method: "GET" }, response, requestUrl, authSession: session });
    assert.equal(response.status, 200);
    assert.equal(response.payload.status, "unknown");
    assert.equal(response.payload.reason, values.length === 1 && values[0] !== "bad" ? "target_changed" : "unbound_target");
    assert.equal(calls, 0);
  }
  const response = {}, requestUrl = new URL(`https://gateway.test/api/servers/local/cwd-observation?workspace=%2Ftmp%2Fabsent&expectedTargetIdentity=${identity}`);
  await handler({ pathname: requestUrl.pathname, request: { method: "GET" }, response, requestUrl, authSession: session });
  assert.equal(response.payload.status, "absent"); assert.equal(response.payload.targetSignature, identity); assert.equal(calls, 1);
});

test("a correctly bound SSH inventory identity cannot authorize local observation", async () => {
  const target = { id: "ssh", transport: "ssh", security: { identity: { mode: "kcoder-account" } } };
  let calls = 0;
  const service = createWorkspaceCwdObservationService({
    getTarget: () => target, getSession: () => ({ allowedServerIds: new Set(["ssh"]) }),
    getLoginOwner: () => "owner", getLoginGeneration: () => 1,
    getTargetSignature: value => JSON.stringify(value),
    observe: async () => { calls += 1; throw new Error("must not touch local paths"); },
  });
  const result = await service({ targetId: "ssh", workspacePath: "/private/workspace", expectedTargetIdentity: targetIdentity(JSON.stringify(target)) });
  assert.equal(result.status, "unknown"); assert.equal(result.reason, "unsupported_transport"); assert.equal(calls, 0);
});
