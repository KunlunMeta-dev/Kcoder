import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RunContext, repoRoot } from "../../harness/run-context.mjs";
import {
  connectMobileWithGatewayAuth,
  expandReadResult,
  isMobileNewWorkspaceRoute,
  isMobileProfileHomeRoute,
  isMobileSessionsRoute,
  parseMobileProfileHomeRoute,
  parseMobileTaskRoute,
  returnHomeAndReenterTaskFromSessions,
  safeMobileProfileHomeRoute,
  safeTaskRoute,
  summarizeMobileDomProjection,
  writeProviderBudgetFinalLedger,
} from "./real-provider-history-assertions.mjs";

test("Gateway Mobile connect submits both owned login and direct-connect tokens", async () => {
  const calls = [];
  const stages = [];
  const page = {
    async goto(url, options) {
      calls.push(["goto", url, options.waitUntil]);
    },
    locator(selector) {
      return {
        async fill(value) {
          calls.push(["fill", selector, value]);
        },
        async click() {
          calls.push(["click", selector]);
        },
      };
    },
    async waitForSelector(selector, options) {
      calls.push(["wait", selector, options.timeout]);
    },
    getByTestId(testId) {
      return {
        async click() {
          calls.push(["click-testid", testId]);
        },
        async fill(value) {
          calls.push(["fill-testid", testId, value]);
        },
        async waitFor(options) {
          calls.push(["wait-testid", testId, options.state, options.timeout]);
        },
      };
    },
  };
  await connectMobileWithGatewayAuth(
    page,
    { baseUrl: "http://127.0.0.1:43121", authToken: "run-owned-auth-token" },
    { onStage: (stage) => stages.push(stage) },
  );
  assert.deepEqual(stages, [
    "open-gateway-login",
    "submit-gateway-login",
    "open-direct-connection",
    "fill-direct-connection",
    "connect-mobile-to-gateway",
  ]);
  assert.deepEqual(calls, [
    ["goto", "http://127.0.0.1:43121", "domcontentloaded"],
    ["fill", 'input[name="token"]', "run-owned-auth-token"],
    ["wait", '[data-testid="welcome-direct-connection"]', 30_000],
    ["click", 'button[type="submit"]'],
    ["click-testid", "welcome-direct-connection"],
    ["fill-testid", "gateway-endpoint", "http://127.0.0.1:43121"],
    ["fill-testid", "gateway-token", "run-owned-auth-token"],
    ["click-testid", "gateway-connect"],
    ["wait-testid", "new-workspace", "visible", 30_000],
  ]);
});

test("expands the ordered transcript read card through its direct toggle", async () => {
  const fixture = createExpansionFixture({ ordered: true });
  await expandReadResult(fixture.page, "tool-call-read%3A1");
  assert.deepEqual(fixture.calls, [
    "count:tool-call-toggle-read%3A1",
    "wait-visible:tool-call-toggle-read%3A1",
    "click:tool-call-toggle-read%3A1",
    "wait-visible:tool-call-read%3A1",
  ]);
  assert.equal(fixture.expanded, true);
});

test("expands the legacy read result nested behind the processing toggle", async () => {
  const fixture = createExpansionFixture({ ordered: false });
  await expandReadResult(fixture.page, "tool-call-read%3A2");
  assert.deepEqual(fixture.calls, [
    "count:tool-call-toggle-read%3A2",
    "count:message-processing-toggle",
    "wait-visible:message-processing-toggle",
    "click:message-processing-toggle",
    "wait-visible:tool-call-read%3A2",
    "count:tool-call-toggle-read%3A2",
    "wait-visible:tool-call-toggle-read%3A2",
    "click:tool-call-toggle-read%3A2",
  ]);
  assert.equal(fixture.expanded, true);
});

test("strictly recognizes and redacts the direct and profile-hosted Mobile routes", () => {
  assert.equal(isMobileNewWorkspaceRoute("/new"), true);
  assert.equal(isMobileNewWorkspaceRoute("/h/profile-a/new"), true);
  assert.equal(isMobileProfileHomeRoute("/h/profile-a"), true);
  assert.deepEqual(parseMobileProfileHomeRoute("/h/profile-a"), {
    profileId: "profile-a",
  });
  assert.equal(isMobileSessionsRoute("/sessions"), true);
  assert.deepEqual(parseMobileTaskRoute("/task/local/thread-a"), {
    routeKind: "direct",
    profileId: null,
    serverId: "local",
    threadId: "thread-a",
  });
  assert.deepEqual(parseMobileTaskRoute("/h/profile-a/task/local/thread-b"), {
    routeKind: "profile-hosted",
    profileId: "profile-a",
    serverId: "local",
    threadId: "thread-b",
  });
  assert.equal(parseMobileProfileHomeRoute("/h/a%2Fb"), null);
  assert.equal(isMobileProfileHomeRoute("/h/profile-a/task/local/thread-b"), false);
  assert.equal(parseMobileTaskRoute("/other/task/local/thread-a"), null);
  assert.equal(parseMobileTaskRoute("/task/local"), null);
  assert.equal(parseMobileTaskRoute("/task/local/a%2Fb"), null);
  assert.equal(isMobileNewWorkspaceRoute("/h/a%2Fb/new"), false);
  assert.equal(
    safeTaskRoute("/h/private-profile/task/local/private-thread"),
    "/task/local/:thread",
  );
  assert.equal(safeMobileProfileHomeRoute("/h/private-profile"), "/h/:profile");
});

test("task back returns through Sessions before Home reopens the same history row", async () => {
  const { result, actions, profileId, threadId, taskPath } =
    await runNavigationHelperFixture("/sessions");
  assert.deepEqual(actions, [`back:${taskPath}`, "back:/sessions", "click:sessions", `click:session-${threadId}`]);
  assert.deepEqual(result, {
    taskBackActivation: "click",
    taskBackRoute: "/sessions",
    homeRoute: "/h/:profile",
    sessionsBackToHome: true,
    sessionsRoute: "/sessions",
    rowCount: 1,
    reentryTaskRoute: "/task/local/:thread",
    taskRouteRestored: true,
  });
});

test("task back can land directly on Home after New Workspace replaced its route", async () => {
  const { result, actions, profileId, threadId, taskPath } =
    await runNavigationHelperFixture(`/h/profile-route-fixture`);
  assert.deepEqual(actions, [
    `back:${taskPath}`,
    "click:sessions",
    `click:session-${threadId}`,
  ]);
  assert.deepEqual(result, {
    taskBackActivation: "click",
    taskBackRoute: "/h/:profile",
    homeRoute: "/h/:profile",
    sessionsBackToHome: false,
    sessionsRoute: "/sessions",
    rowCount: 1,
    reentryTaskRoute: "/task/local/:thread",
    taskRouteRestored: true,
  });
  assert.equal(profileId, "profile-route-fixture");
});

test("Space activates the role-based Task back control before history re-entry", async () => {
  const { result, actions, threadId, taskPath } =
    await runNavigationHelperFixture("/sessions", { backActivation: "space" });
  assert.deepEqual(actions, [
    `space:${taskPath}`,
    "back:/sessions",
    "click:sessions",
    `click:session-${threadId}`,
  ]);
  assert.equal(result.taskBackActivation, "space");
  assert.equal(result.taskBackRoute, "/sessions");
  assert.equal(result.sessionsBackToHome, true);
  assert.equal(result.rowCount, 1);
  assert.equal(result.taskRouteRestored, true);
});

test("failure DOM projection hashes structure while dropping text and dynamic IDs", () => {
  const projection = summarizeMobileDomProjection({
    routeClass: "sessions",
    profileId: "private-profile",
    pathname: "/h/private-profile/sessions?token=private-token",
    elements: [
      { tag: "BUTTON", role: "button", testId: "sessions", visible: true },
      { tag: "BUTTON", role: "button", testId: "session-private-thread", visible: true },
      { tag: "DIV", role: null, testId: "tool-call-private-tool", visible: false },
      { tag: "INPUT", role: "textbox", testId: "session-search", visible: true },
    ],
  });
  assert.deepEqual(projection.visibleTestIds, [
    "sessions",
    "session-:id",
    "session-search",
  ]);
  assert.equal(projection.nodeCount, 4);
  assert.doesNotMatch(JSON.stringify(projection), /private-profile|private-thread|private-token/);
  assert.match(projection.structureSha256, /^[a-f0-9]{64}$/);
});

test("writes the final proxy ledger from RunContext cleanup after finishing begins", async () => {
  const testSource = fileURLToPath(import.meta.url);
  const testRelative = relative(repoRoot, testSource);
  const sourceRoot = resolve(
    repoRoot,
    "target/test/apps/kcoder-studio/e2e/suites/mobile",
  );
  await mkdir(sourceRoot, { recursive: true });
  const runRoot = await mkdtemp(resolve(sourceRoot, ".real-history-ledger-"));
  const context = new RunContext(testSource, testRelative, runRoot, {
    testId: "mobile-real-provider-history-ledger-cleanup-smoke",
    retainSuccessLogs: true,
  });
  try {
    await context.initialize();
    const expectedCounters = {
      forwardedRequests: 2,
      forwardedPostRequests: 2,
      locallyRejectedRequests: 0,
      blockedRedirectResponses: 0,
      inFlightRequests: 0,
    };
    const expectedAttempts = [
      {
        protocol: "anthropic",
        outcome: "completed",
        status: 200,
        elapsedUs: 10,
        inputTokens: 16,
        outputTokens: 8,
      },
      {
        protocol: "anthropic",
        outcome: "completed",
        status: 200,
        elapsedUs: 12,
        inputTokens: 20,
        outputTokens: 7,
      },
    ];
    context.addCleanup("write final budget ledger", async () => {
      assert.equal(context.finishing, true);
      await writeProviderBudgetFinalLedger(context, {
        previousRunIds: ["prior-fixture-run-a", "prior-fixture-run-b"],
        previousRunCumulativeUpperBound: 4,
        previousRunProxyCounterPersisted: false,
        previousRunObservedTransportAttempts: 3,
        currentRunMaxForwardedRequests: 3,
        cumulativeMaximum: 7,
        counters: expectedCounters,
        observedAttempts: expectedAttempts,
      });
    });

    await context.finish("passed", { localCleanupProbe: true }, null);
    const ledgerPath = resolve(
      context.artifactsDir,
      "provider-budget-proxy-final-stats.json",
    );
    assert.equal((await lstat(ledgerPath)).isFile(), true);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.deepEqual(ledger.previousRun.runIds, [
      "prior-fixture-run-a",
      "prior-fixture-run-b",
    ]);
    assert.equal(ledger.previousRun.cumulativeUpstreamUpperBound, 4);
    assert.equal(ledger.previousRun.observedTransportAttempts, 3);
    assert.equal(ledger.previousRun.exactProxyForwardCounterPersisted, false);
    assert.equal(ledger.currentRun.maxForwardedRequests, 3);
    assert.equal(ledger.cumulativeAccounting.upstreamRequestUpperBound, 6);
    assert.equal(ledger.cumulativeAccounting.maximum, 7);
    assert.equal(ledger.cumulativeAccounting.withinBudget, true);
    assert.equal(ledger.currentRun.observedAttempts.length, 2);
    assert.equal(context.cleanupSteps[0].status, "completed");
  } finally {
    if (!context.finished) await context.finish("failed", null, new Error("local ledger probe failed")).catch(() => {});
    await rm(runRoot, { recursive: true, force: true });
  }
});

async function runNavigationHelperFixture(taskBackTarget, { backActivation = "click" } = {}) {
  const profileId = "profile-route-fixture";
  const threadId = "thread-route-fixture";
  const taskPath = `/h/${profileId}/task/local/${threadId}`;
  let pathname = taskPath;
  const actions = [];
  const page = {
    url() {
      return `http://127.0.0.1:43121${pathname}`;
    },
    async waitForURL(predicate) {
      assert.equal(predicate(new URL(this.url())), true);
    },
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.deepEqual(options, { name: "返回", exact: true });
      return {
        async waitFor({ state }) {
          assert.equal(state, "visible");
        },
        async click() {
          actions.push(`back:${pathname}`);
          if (pathname === taskPath) pathname = taskBackTarget;
          else if (pathname === "/sessions") pathname = `/h/${profileId}`;
          else assert.fail(`unexpected back route ${pathname}`);
        },
        async press(key) {
          assert.equal(key, "Space");
          actions.push(`space:${pathname}`);
          if (pathname === taskPath) pathname = taskBackTarget;
          else assert.fail(`unexpected Space activation on ${pathname}`);
        },
      };
    },
    getByTestId(testId) {
      return {
        async click() {
          actions.push(`click:${testId}`);
          if (testId === "sessions" && pathname === `/h/${profileId}`)
            pathname = "/sessions";
          else if (testId === `session-${threadId}` && pathname === "/sessions")
            pathname = taskPath;
          else assert.fail(`unexpected ${testId} click on ${pathname}`);
        },
        async count() {
          assert.equal(testId, `session-${threadId}`);
          assert.equal(pathname, "/sessions");
          return 1;
        },
        async waitFor({ state }) {
          assert.equal(state, "visible");
          if (testId === "sessions-list") assert.equal(pathname, "/sessions");
        },
      };
    },
    locator(selector) {
      assert.equal(selector, '[data-testid="message-input-root"]:visible');
      assert.equal(parseMobileTaskRoute(pathname)?.threadId, threadId);
      return {
        async waitFor({ state }) {
          assert.equal(state, "visible");
        },
      };
    },
  };
  const result = await returnHomeAndReenterTaskFromSessions(page, {
    profileId,
    threadId,
    expectedTaskPath: taskPath,
    backActivation,
  });
  return { result, actions, profileId, threadId, taskPath };
}

function createExpansionFixture({ ordered }) {
  const calls = [];
  let expanded = false;
  let processingExpanded = false;
  const toggleId = ordered ? "tool-call-toggle-read%3A1" : "tool-call-toggle-read%3A2";
  const toolId = ordered ? "tool-call-read%3A1" : "tool-call-read%3A2";
  const locator = (id) => ({
    first() {
      return this;
    },
    async count() {
      calls.push(`count:${id}`);
      if (id === "message-processing-toggle") return ordered ? 0 : 1;
      if (id === toggleId) return ordered || processingExpanded ? 1 : 0;
      return 1;
    },
    async waitFor({ state }) {
      calls.push(`wait-${state}:${id}`);
      if (id === toolId && !ordered && !processingExpanded)
        throw new Error("legacy read result is still collapsed");
    },
    async getAttribute(name) {
      assert.equal(name, "aria-expanded");
      return id === "message-processing-toggle"
        ? String(processingExpanded)
        : String(expanded);
    },
    async click() {
      calls.push(`click:${id}`);
      if (id === "message-processing-toggle") processingExpanded = true;
      if (id === toggleId) expanded = true;
    },
    getByRole(role) {
      assert.equal(role, "button");
      return this;
    },
  });
  return {
    calls,
    get expanded() {
      return expanded;
    },
    page: { getByTestId: locator },
  };
}
