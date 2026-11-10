import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { closeChromiumProfileAndWaitForExit } from "./chromium-profile-exit.mjs";

const fakePid = 1_500_000_000;

function fixture({
  beforeRequestExit = false,
  browserClose = () => {},
  fallbackExit = null,
  rejectHandleClose = false,
  rejectSessionDetach = false,
} = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: fakePid,
    exitCode: beforeRequestExit ? 0 : null,
    signalCode: null,
  });
  let cdpSessionCalls = 0;
  let sendCalls = 0;
  let handleCloseCalls = 0;
  let detachCalls = 0;
  let sessionFactory = () => {
    const session = Object.assign(new EventEmitter(), {
      send(method) {
        sendCalls += 1;
        assert.equal(method, "Browser.close");
        return browserClose(child, session, browser);
      },
      async detach() {
        detachCalls += 1;
        if (rejectSessionDetach) throw new Error("CDP session detach rejected");
      },
    });
    return session;
  };
  const processRecord = {
    label: "profile-exit-probe",
    child,
    pid: fakePid,
    pgid: fakePid,
    identity: { pid: fakePid, pgid: fakePid },
    stopped: false,
    stopPromise: null,
  };
  const browser = Object.assign(new EventEmitter(), {
    connected: true,
    isConnected() {
      return this.connected;
    },
    disconnect({ emit = true } = {}) {
      this.connected = false;
      if (emit) this.emit("disconnected");
    },
    newBrowserCDPSession() {
      cdpSessionCalls += 1;
      return sessionFactory();
    },
  });
  const handle = {
    child,
    browser,
    async close() {
      handleCloseCalls += 1;
      if (rejectHandleClose) throw new Error("owned handle close rejected");
      if (fallbackExit && child.exitCode === null && child.signalCode === null) {
        fallbackExit(child);
      }
    },
  };
  const runContext = { processes: new Map([[processRecord.label, processRecord]]) };
  return {
    child,
    browser,
    handle,
    runContext,
    processRecord,
    counts: () => ({ cdpSessionCalls, sendCalls, handleCloseCalls }),
    detachCalls: () => detachCalls,
    setSessionFactory: factory => { sessionFactory = factory; },
  };
}

function emitExit(child, code, signal) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
}

test("a Playwright CDPSession close event proves release without a detached call", async () => {
  const f = fixture({
    browserClose: (child, session, browser) => new Promise(resolve => {
      setImmediate(() => {
        browser.disconnect();
        session.emit("close", session);
        emitExit(child, 0, null);
        resolve();
      });
    }),
  });

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle, {
    exitTimeoutMs: 500,
    cleanupTimeoutMs: 500,
  });

  assert.equal(result.outcome, "graceful-exit-observed");
  assert.equal(result.requestState, "invoked");
  assert.equal(result.exitObserved, true);
  assert.equal(result.childExitCode, 0);
  assert.equal(result.childSignalCode, null);
  assert.equal(result.processTreeClearBeforeRelease, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.handleCloseOutcome, "completed");
  assert.equal(result.sessionCleanup, "session-already-closed");
  assert.equal(result.sessionCloseObserved, true);
  assert.equal(result.browserDisconnectEvidenceBeforeOwnerClose, true);
  assert.equal(result.browserDisconnectedEventObservedBeforeOwnerClose, true);
  assert.equal(result.browserDisconnectListenerCleanup, "removed");
  assert.equal(f.detachCalls(), 0, "a Playwright close event must avoid detaching a closed session");
  assert.equal(f.browser.listenerCount("disconnected"), 0, "the public disconnect watcher must be removed");
  assert.deepEqual(f.counts(), { cdpSessionCalls: 1, sendCalls: 1, handleCloseCalls: 1 });
});

test("an exact owned process tree that clears after a short delay remains graceful", async () => {
  const f = fixture({
    browserClose: (child, _session, browser) => new Promise(resolve => {
      setImmediate(() => {
        browser.disconnect();
        emitExit(child, 0, null);
        resolve();
      });
    }),
  });
  let treeProbeCalls = 0;

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle, {
    exitTimeoutMs: 500,
    treeClearTimeoutMs: 500,
    cleanupTimeoutMs: 500,
    treeAliveProbe: async (child, identity) => {
      assert.equal(child, f.child);
      assert.equal(identity.pgid, f.processRecord.pgid);
      treeProbeCalls += 1;
      return treeProbeCalls < 3;
    },
  });

  assert.equal(treeProbeCalls, 3, "the exact owned process group must be polled until it clears");
  assert.equal(result.outcome, "graceful-exit-observed");
  assert.equal(result.processTreeClearBeforeRelease, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.browserDisconnectEvidenceBeforeOwnerClose, true);
});

test("an owned process tree that remains present times out and uses the owner fallback", async () => {
  const f = fixture({
    browserClose: (child, session, browser) => new Promise(resolve => {
      setImmediate(() => {
        browser.disconnect();
        session.emit("close", session);
        emitExit(child, 0, null);
        resolve();
      });
    }),
  });

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle, {
    exitTimeoutMs: 500,
    treeClearTimeoutMs: 70,
    cleanupTimeoutMs: 500,
    treeAliveProbe: () => true,
  });

  assert.equal(result.outcome, "owned-close-fallback");
  assert.equal(result.reason, "owned-process-tree-clear-timeout");
  assert.equal(result.processTreeClearBeforeRelease, false);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.sessionCleanup, "session-already-closed");
});

test("public transport disconnect permits release when CDPSession close is not emitted", async () => {
  const f = fixture({
    rejectSessionDetach: true,
    browserClose: (child, _session, browser) => new Promise(resolve => {
      setImmediate(() => {
        browser.disconnect({ emit: false });
        emitExit(child, 0, null);
        resolve();
      });
    }),
  });

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle, {
    exitTimeoutMs: 500,
    cleanupTimeoutMs: 500,
    treeAliveProbe: () => false,
  });

  assert.equal(result.outcome, "graceful-exit-observed");
  assert.equal(result.sessionCleanup, "session-transport-closed");
  assert.equal(result.sessionCloseObserved, false);
  assert.equal(result.browserDisconnectedEventObservedBeforeOwnerClose, false);
  assert.equal(result.browserIsConnectedBeforeOwnerClose, false);
  assert.equal(result.browserDisconnectEvidenceBeforeOwnerClose, true);
  assert.equal(f.detachCalls(), 0, "a dead public transport must not trigger detach on its dead CDP session");
});

test("a still-connected Browser and failed cleanup cannot be reported as graceful", async () => {
  const f = fixture({
    rejectHandleClose: true,
    rejectSessionDetach: true,
    browserClose: child => new Promise(resolve => {
      setImmediate(() => {
        emitExit(child, 0, null);
        resolve();
      });
    }),
  });

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle, {
    exitTimeoutMs: 500,
    cleanupTimeoutMs: 30,
    treeAliveProbe: () => false,
  });

  assert.equal(result.outcome, "owner-release-incomplete");
  assert.equal(result.reason, "owned-handle-close-failed-or-timed-out");
  assert.equal(result.processTreeClearBeforeRelease, true);
  assert.equal(result.browserDisconnectEvidenceBeforeOwnerClose, false);
  assert.equal(result.sessionCleanup, "failed-or-timed-out");
  assert.equal(result.handleCloseOutcome, "failed-or-timed-out");
  assert.equal(result.fallbackUsed, true);
  assert.equal(f.detachCalls(), 1, "an open session must attempt and preserve its failed detach");
});

test("a rejected handle close cannot be reported as graceful completion", async () => {
  const f = fixture({
    rejectHandleClose: true,
    browserClose: (child, session, browser) => new Promise(resolve => {
      setImmediate(() => {
        browser.disconnect();
        session.emit("close", session);
        emitExit(child, 0, null);
        resolve();
      });
    }),
  });

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle, {
    exitTimeoutMs: 500,
    cleanupTimeoutMs: 500,
  });

  assert.equal(result.outcome, "owner-release-incomplete");
  assert.equal(result.reason, "owned-handle-close-failed-or-timed-out");
  assert.equal(result.exitObserved, true);
  assert.equal(result.childExitCode, 0);
  assert.equal(result.processTreeClearBeforeRelease, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.handleCloseOutcome, "failed-or-timed-out");
  assert.equal(result.sessionCleanup, "session-already-closed");
  assert.deepEqual(f.counts(), { cdpSessionCalls: 1, sendCalls: 1, handleCloseCalls: 1 });
});

test("a rejected CDP session cleanup cannot be reported as graceful completion", async () => {
  const f = fixture({
    rejectSessionDetach: true,
    browserClose: child => new Promise(resolve => {
      setImmediate(() => {
        emitExit(child, 0, null);
        resolve();
      });
    }),
  });

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle, {
    exitTimeoutMs: 500,
    cleanupTimeoutMs: 30,
  });

  assert.equal(result.outcome, "cleanup-incomplete");
  assert.equal(result.reason, "browser-cdp-session-cleanup-failed-or-unavailable");
  assert.equal(result.exitObserved, true);
  assert.equal(result.childExitCode, 0);
  assert.equal(result.processTreeClearBeforeRelease, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.sessionCleanup, "failed-or-timed-out");
  assert.equal(result.handleCloseOutcome, "completed");
  assert.equal(f.detachCalls(), 1, "an open session must attempt detach and preserve its failure");
  assert.deepEqual(f.counts(), { cdpSessionCalls: 1, sendCalls: 1, handleCloseCalls: 1 });
});

test("a child that exited before the command is not attributed to the helper", async () => {
  const f = fixture({ beforeRequestExit: true });

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle, {
    exitTimeoutMs: 100,
    cleanupTimeoutMs: 500,
  });

  assert.equal(result.outcome, "owned-close-fallback");
  assert.equal(result.reason, "child-exited-before-request");
  assert.equal(result.requestState, "exit-before-request");
  assert.equal(result.exitObserved, false);
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(f.counts(), { cdpSessionCalls: 0, sendCalls: 0, handleCloseCalls: 1 });
});

test("an exit while the browser CDP session is being created fences Browser.close", async () => {
  const f = fixture();
  const session = {
    send() {
      throw new Error("must not send after the child exit event");
    },
    async detach() {},
  };
  f.setSessionFactory(() => Promise.resolve().then(() => {
    emitExit(f.child, 0, null);
    return session;
  }));

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle, {
    exitTimeoutMs: 500,
    cleanupTimeoutMs: 500,
  });

  assert.equal(result.outcome, "owned-close-fallback");
  assert.equal(result.reason, "child-exited-before-request");
  assert.equal(result.requestState, "exit-before-request");
  assert.equal(result.exitObserved, true);
  assert.equal(result.exitObservedAfterFallback, false);
  assert.equal(result.childExitCode, 0);
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(f.counts(), { cdpSessionCalls: 1, sendCalls: 0, handleCloseCalls: 1 });
});

test("a signal exit after Browser.close is recorded as non-graceful", async () => {
  const f = fixture({
    browserClose: (child, session, browser) => new Promise(resolve => {
      setImmediate(() => {
        browser.disconnect();
        session.emit("close", session);
        emitExit(child, null, "SIGTERM");
        resolve();
      });
    }),
  });

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle, {
    exitTimeoutMs: 500,
    cleanupTimeoutMs: 500,
  });

  assert.equal(result.outcome, "non-graceful-exit-observed");
  assert.equal(result.reason, "child-exited-by-signal");
  assert.equal(result.exitObserved, true);
  assert.equal(result.childSignalCode, "SIGTERM");
  assert.equal(result.fallbackUsed, false);
});

test("a close fallback exit cannot be reported as helper-graceful", async () => {
  const f = fixture({
    fallbackExit: child => emitExit(child, null, "SIGTERM"),
  });

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle, {
    exitTimeoutMs: 10,
    cleanupTimeoutMs: 500,
  });

  assert.equal(result.outcome, "owned-close-fallback");
  assert.equal(result.reason, "child-exit-timeout");
  assert.equal(result.requestState, "invoked");
  assert.equal(result.exitObservedAfterFallback, true);
  assert.equal(result.childSignalCode, "SIGTERM");
  assert.equal(result.fallbackUsed, true);
});

test("PID mismatch rejects the operation without sending or closing a non-owner", async () => {
  const f = fixture();
  f.processRecord.pid += 1;

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle);

  assert.equal(result.outcome, "owner-rejected");
  assert.equal(result.reason, "owner-identity-mismatch");
  assert.equal(result.ownerVerified, false);
  assert.deepEqual(f.counts(), { cdpSessionCalls: 0, sendCalls: 0, handleCloseCalls: 0 });
});

test("PGID mismatch rejects the operation without signaling or closing a non-owner", async () => {
  const f = fixture();
  f.processRecord.identity.pgid += 1;

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle);

  assert.equal(result.outcome, "owner-rejected");
  assert.equal(result.reason, "owner-identity-mismatch");
  assert.equal(result.ownerVerified, false);
  assert.deepEqual(f.counts(), { cdpSessionCalls: 0, sendCalls: 0, handleCloseCalls: 0 });
});

test("a different child object is rejected even when its PID fields look similar", async () => {
  const f = fixture();
  const otherProcessRecord = { ...f.processRecord, child: new EventEmitter() };
  f.runContext.processes = new Map([[otherProcessRecord.label, otherProcessRecord]]);

  const result = await closeChromiumProfileAndWaitForExit(f.runContext, f.handle);

  assert.equal(result.outcome, "owner-rejected");
  assert.equal(result.reason, "owner-record-not-unique");
  assert.equal(result.ownerVerified, false);
  assert.deepEqual(f.counts(), { cdpSessionCalls: 0, sendCalls: 0, handleCloseCalls: 0 });
});
