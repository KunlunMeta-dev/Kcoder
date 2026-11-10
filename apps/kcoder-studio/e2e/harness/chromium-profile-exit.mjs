import { processTreeAlive } from "./owned-process.mjs";
import { waitFor } from "./run-context.mjs";

const DEFAULT_EXIT_TIMEOUT_MS = 10_000;
const DEFAULT_TREE_CLEAR_TIMEOUT_MS = 10_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;
const TREE_CLEAR_POLL_INTERVAL_MS = 50;
const BROWSER_DISCONNECT_WAIT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;

function positiveTimeout(value, fallback, name) {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new RangeError(`${name} must be an integer from 1 through ${MAX_TIMEOUT_MS}`);
  }
  return timeout;
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function exactOwnerRecord(runContext, child) {
  if (!(runContext?.processes instanceof Map) || !child || !Number.isSafeInteger(child.pid) || child.pid < 1) {
    return { verified: false, reason: "invalid-owner-input" };
  }
  const matches = [...runContext.processes.entries()].filter(([, record]) => record?.child === child);
  if (matches.length !== 1) return { verified: false, reason: "owner-record-not-unique" };

  const [[label, record]] = matches;
  const { identity } = record;
  const pgidMatches = record.pgid === null && identity?.pgid === null
    ? true
    : Number.isSafeInteger(record.pgid) && record.pgid > 0 && identity?.pgid === record.pgid;
  if (
    typeof label !== "string" ||
    record.label !== label ||
    record.pid !== child.pid ||
    identity?.pid !== child.pid ||
    !pgidMatches
  ) {
    return { verified: false, reason: "owner-identity-mismatch" };
  }
  return { verified: true, label, record };
}

function raceWithTimeout(entries, timeoutMs) {
  let timer;
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    for (const [kind, promise] of entries) {
      Promise.resolve(promise).then(
        value => finish({ kind, value }),
        () => finish({ kind, rejected: true }),
      );
    }
  });
}

async function waitForOwnedProcessTreeClear(child, identity, isAlive, timeoutMs) {
  let lastAlive = null;
  let probeFailed = false;
  try {
    await waitFor(async () => {
      let alive;
      try {
        alive = await isAlive(child, identity);
      } catch (error) {
        probeFailed = true;
        throw error;
      }
      if (typeof alive !== "boolean") {
        probeFailed = true;
        throw new TypeError("owned process tree probe must return a boolean");
      }
      lastAlive = alive;
      return !alive;
    }, timeoutMs, "owned Chromium process tree clear", TREE_CLEAR_POLL_INTERVAL_MS);
    return { kind: "clear", lastAlive: false };
  } catch {
    return { kind: probeFailed ? "probe-error" : "timeout", lastAlive };
  }
}

async function detachSession(session, timeoutMs) {
  if (typeof session?.detach !== "function") return "unsupported";
  let timer;
  try {
    const detachPromise = session.detach();
    await Promise.race([
      Promise.resolve(detachPromise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("detach-timeout")), timeoutMs);
      }),
    ]);
    return "detached";
  } catch {
    return "failed-or-timed-out";
  } finally {
    clearTimeout(timer);
  }
}

function watchSessionClose(session) {
  const removeListener = typeof session?.removeListener === "function"
    ? listener => session.removeListener("close", listener)
    : typeof session?.off === "function"
      ? listener => session.off("close", listener)
      : null;
  if (typeof session?.once !== "function" || !removeListener) return null;

  let observed = false;
  let resolveClose;
  const promise = new Promise(resolve => { resolveClose = resolve; });
  const listener = () => {
    observed = true;
    resolveClose();
  };
  try {
    session.once("close", listener);
  } catch {
    return null;
  }
  return {
    promise,
    observed: () => observed,
    remove: () => {
      try {
        removeListener(listener);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function watchBrowserDisconnect(browser) {
  const removeListener = typeof browser?.removeListener === "function"
    ? listener => browser.removeListener("disconnected", listener)
    : typeof browser?.off === "function"
      ? listener => browser.off("disconnected", listener)
      : null;
  if (typeof browser?.once !== "function" || !removeListener) return null;

  let observed = false;
  let resolveDisconnect;
  const promise = new Promise(resolve => { resolveDisconnect = resolve; });
  const listener = () => {
    observed = true;
    resolveDisconnect();
  };
  try {
    browser.once("disconnected", listener);
  } catch {
    return null;
  }
  return {
    promise,
    observed: () => observed,
    remove: () => {
      try {
        removeListener(listener);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function readBrowserDisconnectEvidence(browser, watcher) {
  const eventObserved = watcher?.observed() ?? false;
  let isConnected = null;
  try {
    if (typeof browser?.isConnected === "function") {
      const value = browser.isConnected();
      if (typeof value === "boolean") isConnected = value;
    }
  } catch {
    // A throwing public query is unknown evidence, never a disconnect proof.
  }
  return {
    eventObserved,
    isConnected,
    disconnected: eventObserved || isConnected === false,
  };
}

async function waitForBrowserDisconnect(browser, watcher, timeoutMs) {
  let evidence = readBrowserDisconnectEvidence(browser, watcher);
  if (evidence.disconnected || !watcher) return evidence;
  await raceWithTimeout([
    ["browser-disconnected", watcher.promise],
  ], Math.min(timeoutMs, BROWSER_DISCONNECT_WAIT_MS));
  evidence = readBrowserDisconnectEvidence(browser, watcher);
  return evidence;
}

/**
 * Ask the owned Chromium process to close through its browser-target CDP session,
 * then wait for that exact child process to exit before releasing its RunContext
 * profile owner through the existing handle.close lifecycle.
 *
 * The result contains lifecycle categories only; it intentionally omits process
 * identifiers, profile paths, argv, and low-level error text.
 */
export async function closeChromiumProfileAndWaitForExit(runContext, chromiumHandle, options = {}) {
  const exitTimeoutMs = positiveTimeout(options.exitTimeoutMs, DEFAULT_EXIT_TIMEOUT_MS, "exitTimeoutMs");
  const treeClearTimeoutMs = positiveTimeout(options.treeClearTimeoutMs, DEFAULT_TREE_CLEAR_TIMEOUT_MS, "treeClearTimeoutMs");
  const cleanupTimeoutMs = positiveTimeout(options.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS, "cleanupTimeoutMs");
  const treeAliveProbe = options.treeAliveProbe ?? processTreeAlive;
  if (typeof treeAliveProbe !== "function") throw new TypeError("treeAliveProbe must be a function");
  const child = chromiumHandle?.child;
  const owner = exactOwnerRecord(runContext, child);
  const result = {
    outcome: "owner-rejected",
    reason: owner.reason,
    ownerVerified: owner.verified,
    requestState: "not-attempted",
    sendResponseState: "not-applicable",
    exitObserved: false,
    exitObservedAfterFallback: false,
    childExitCode: child?.exitCode ?? null,
    childSignalCode: child?.signalCode ?? null,
    processTreeClearBeforeRelease: null,
    fallbackUsed: false,
    handleCloseOutcome: "not-attempted",
    sessionCleanup: "not-created",
    sessionCloseObserved: false,
    browserDisconnectedEventObservedBeforeOwnerClose: false,
    browserIsConnectedBeforeOwnerClose: null,
    browserDisconnectEvidenceBeforeOwnerClose: false,
    browserDisconnectListenerCleanup: "not-registered",
  };
  if (!owner.verified) return result;

  const browser = chromiumHandle?.browser;
  if (!browser || typeof chromiumHandle.close !== "function") {
    result.reason = "invalid-chromium-handle";
    return result;
  }

  const record = owner.record;
  const browserDisconnectWatch = watchBrowserDisconnect(browser);
  let exitEvent = null;
  let fallbackCloseStarted = false;
  let exitObservedAfterFallback = false;
  let exitListenerInstalled = false;
  let exitListener;
  let session = null;
  let sessionCloseWatch = null;
  let acceptedSession = null;
  let creationRaceFinished = false;
  let fallbackNeeded = Boolean(record.stopped || record.stopPromise || !browserDisconnectWatch);
  let treeWasClear = false;
  let helperClosePromise = null;
  let helperCloseCompleted = false;
  let sendResponseState = "not-applicable";
  let sessionCleanup = "not-created";
  let browserDisconnectEvidence = {
    eventObserved: false,
    isConnected: null,
    disconnected: false,
  };
  let ownedTransportGone = false;
  let browserDisconnectListenerCleanup = browserDisconnectWatch ? "pending" : "not-registered";
  let requestState = "not-attempted";
  let reason = record.stopped || record.stopPromise
    ? "owner-already-stopping"
    : !browserDisconnectWatch ? "browser-disconnect-watcher-unavailable" : null;
  let exitPromiseResolve;
  const exitPromise = new Promise(resolve => { exitPromiseResolve = resolve; });

  if (typeof child.once === "function" && typeof child.removeListener === "function") {
    exitListener = (code, signal) => {
      exitEvent = { code: code ?? null, signal: signal ?? null };
      if (fallbackCloseStarted) exitObservedAfterFallback = true;
      exitPromiseResolve(exitEvent);
    };
    child.once("exit", exitListener);
    exitListenerInstalled = true;
  } else {
    fallbackNeeded = true;
    reason ??= "child-exit-events-unavailable";
  }

  try {
    if (fallbackNeeded) {
      requestState = "not-attempted";
    } else if (childHasExited(child)) {
      requestState = "exit-before-request";
      reason = "child-exited-before-request";
      fallbackNeeded = true;
    } else if (!exitListenerInstalled) {
      requestState = "not-attempted";
    } else if (typeof browser.newBrowserCDPSession !== "function") {
      requestState = "session-unavailable";
      reason = "browser-cdp-session-unavailable";
      fallbackNeeded = true;
    } else {
      let rawSessionPromise;
      try {
        rawSessionPromise = browser.newBrowserCDPSession();
      } catch {
        requestState = "session-create-failed";
        reason = "browser-cdp-session-create-failed";
        fallbackNeeded = true;
      }

      if (rawSessionPromise) {
        const taggedSessionPromise = Promise.resolve(rawSessionPromise).then(
          value => ({ kind: "session", value }),
          () => ({ kind: "session-error" }),
        );
        void taggedSessionPromise.then(async tagged => {
          if (creationRaceFinished && tagged.kind === "session" && tagged.value !== acceptedSession) {
            await detachSession(tagged.value, cleanupTimeoutMs);
          }
        });
        const first = await raceWithTimeout([
          ["session-result", taggedSessionPromise],
          ["child-exit", exitPromise],
        ], exitTimeoutMs);
        creationRaceFinished = true;

        if (first.kind === "child-exit") {
          requestState = "exit-before-request";
          reason = "child-exited-before-request";
          fallbackNeeded = true;
        } else if (first.kind === "timeout") {
          requestState = "session-create-timeout";
          reason = "browser-cdp-session-create-timeout";
          fallbackNeeded = true;
        } else if (first.kind === "session-result" && first.value?.kind === "session") {
          session = first.value.value;
          acceptedSession = session;
          sessionCloseWatch = watchSessionClose(session);
          if (exitEvent || childHasExited(child)) {
            requestState = "exit-before-request";
            reason = "child-exited-before-request";
            fallbackNeeded = true;
          } else if (typeof session?.send !== "function") {
            requestState = "session-send-unavailable";
            reason = "browser-cdp-session-send-unavailable";
            fallbackNeeded = true;
          } else {
            let sendPromise;
            try {
              // No await occurs between the final exit check and invoking send.
              sendPromise = session.send("Browser.close");
              requestState = "invoked";
              sendResponseState = "pending";
              Promise.resolve(sendPromise).then(
                () => { sendResponseState = "fulfilled"; },
                () => { sendResponseState = "rejected"; },
              );
            } catch {
              requestState = "invocation-failed";
              sendResponseState = "not-applicable";
              reason = "browser-close-command-invocation-failed";
              fallbackNeeded = true;
            }

            if (requestState === "invoked") {
              const exitResult = await raceWithTimeout([["child-exit", exitPromise]], exitTimeoutMs);
              if (exitResult.kind === "timeout") {
                reason = "child-exit-timeout";
                fallbackNeeded = true;
              } else {
                exitEvent = exitResult.value;
              }
            }
          }
        } else {
          requestState = "session-create-failed";
          reason = "browser-cdp-session-create-failed";
          fallbackNeeded = true;
        }
      } else if (requestState !== "session-create-failed") {
        requestState = "session-create-failed";
        reason = "browser-cdp-session-create-failed";
        fallbackNeeded = true;
      }
    }

    if (requestState === "invoked" && exitEvent) {
      if (exitEvent.code !== 0 || exitEvent.signal !== null || child.signalCode !== null) {
        reason = exitEvent.signal !== null || child.signalCode !== null
          ? "child-exited-by-signal"
          : "child-exited-with-nonzero-code";
      } else {
        const treeCheck = await waitForOwnedProcessTreeClear(
          child,
          record.identity,
          treeAliveProbe,
          treeClearTimeoutMs,
        );
        if (treeCheck.kind === "clear") {
          treeWasClear = true;
        } else {
          result.processTreeClearBeforeRelease = treeCheck.kind === "timeout" && treeCheck.lastAlive === true
            ? false
            : null;
          reason = treeCheck.kind === "timeout"
            ? "owned-process-tree-clear-timeout"
            : "owned-process-tree-check-failed";
          fallbackNeeded = true;
        }

        if (treeWasClear) {
          browserDisconnectEvidence = await waitForBrowserDisconnect(
            browser,
            browserDisconnectWatch,
            cleanupTimeoutMs,
          );
          ownedTransportGone = browserDisconnectEvidence.disconnected;
          if (!ownedTransportGone) {
            reason = "browser-disconnect-not-observed";
            fallbackNeeded = true;
          } else {
            reason = null;
          }
        }
      }
    }
  } finally {
    if (!treeWasClear) {
      browserDisconnectEvidence = readBrowserDisconnectEvidence(browser, browserDisconnectWatch);
    }

    if (session) {
      if (sessionCloseWatch?.observed()) {
        sessionCleanup = "session-already-closed";
      } else if (
        requestState === "invoked" &&
        exitEvent?.code === 0 &&
        exitEvent.signal === null &&
        child.signalCode === null &&
        treeWasClear &&
        ownedTransportGone
      ) {
        sessionCleanup = "session-transport-closed";
      } else {
        if (sessionCloseWatch && (exitEvent || childHasExited(child))) {
          const closeResult = await raceWithTimeout([
            ["session-close", sessionCloseWatch.promise],
          ], Math.min(cleanupTimeoutMs, 1_000));
          if (closeResult.kind === "session-close" || sessionCloseWatch.observed()) {
            sessionCleanup = "session-already-closed";
          }
        }
        if (sessionCleanup === "not-created") {
          sessionCleanup = await detachSession(session, cleanupTimeoutMs);
        }
      }
      if (sessionCloseWatch && !sessionCloseWatch.remove()) {
        sessionCleanup = "listener-cleanup-failed";
      }
    }

    if (fallbackNeeded) result.fallbackUsed = true;
    fallbackCloseStarted = fallbackNeeded;
    try {
      helperClosePromise = Promise.resolve().then(() => chromiumHandle.close());
      helperClosePromise.catch(() => {});
      const closeResult = await raceWithTimeout([["handle-close", helperClosePromise]], cleanupTimeoutMs);
      helperCloseCompleted = closeResult.kind === "handle-close" && !closeResult.rejected;
      result.handleCloseOutcome = helperCloseCompleted ? "completed" : "failed-or-timed-out";
    } catch {
      result.handleCloseOutcome = "failed-or-timed-out";
    }

    if (browserDisconnectWatch) {
      browserDisconnectListenerCleanup = browserDisconnectWatch.remove() ? "removed" : "failed";
    }

    if (exitListenerInstalled) child.removeListener("exit", exitListener);
    result.exitObserved = exitEvent !== null;
    result.exitObservedAfterFallback = exitObservedAfterFallback;
    result.childExitCode = child.exitCode ?? exitEvent?.code ?? null;
    result.childSignalCode = child.signalCode ?? exitEvent?.signal ?? null;
    result.requestState = requestState;
    result.sendResponseState = sendResponseState;
    result.processTreeClearBeforeRelease = treeWasClear
      ? true
      : result.processTreeClearBeforeRelease;
    result.sessionCleanup = sessionCleanup;
    result.sessionCloseObserved = sessionCloseWatch?.observed() ?? false;
    const cdpSessionCleanupCompleted = session === null ||
      sessionCleanup === "detached" ||
      (sessionCleanup === "session-already-closed" && result.sessionCloseObserved) ||
      (sessionCleanup === "session-transport-closed" && ownedTransportGone);
    result.browserDisconnectedEventObservedBeforeOwnerClose = browserDisconnectEvidence.eventObserved;
    result.browserIsConnectedBeforeOwnerClose = browserDisconnectEvidence.isConnected;
    result.browserDisconnectEvidenceBeforeOwnerClose = browserDisconnectEvidence.disconnected;
    result.browserDisconnectListenerCleanup = browserDisconnectListenerCleanup;
    const browserDisconnectCleanupCompleted = browserDisconnectWatch !== null &&
      browserDisconnectListenerCleanup === "removed";
    result.reason = !helperCloseCompleted
      ? "owned-handle-close-failed-or-timed-out"
      : !cdpSessionCleanupCompleted ? "browser-cdp-session-cleanup-failed-or-unavailable"
        : !browserDisconnectCleanupCompleted ? "browser-disconnect-listener-cleanup-failed"
          : reason;

    if (
      requestState === "invoked" &&
      result.exitObserved &&
      result.childExitCode === 0 &&
      result.childSignalCode === null &&
      treeWasClear &&
      browserDisconnectEvidence.disconnected &&
      !result.fallbackUsed &&
      helperCloseCompleted &&
      cdpSessionCleanupCompleted &&
      browserDisconnectCleanupCompleted
    ) {
      result.outcome = "graceful-exit-observed";
    } else if (!helperCloseCompleted) {
      result.outcome = "owner-release-incomplete";
    } else if (!cdpSessionCleanupCompleted || !browserDisconnectCleanupCompleted) {
      result.outcome = "cleanup-incomplete";
    } else if (result.fallbackUsed) {
      result.outcome = "owned-close-fallback";
    } else if (result.exitObserved) {
      result.outcome = "non-graceful-exit-observed";
    } else {
      result.outcome = "owned-close-fallback";
    }
  }

  return result;
}
