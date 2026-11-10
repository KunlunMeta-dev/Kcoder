import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { dispatchTrustedTouchDrag } from "./browser-touch-input.mjs";

function touchFixture({ failSend, failDetach = false, autoAnimationFrame = true } = {}) {
  const events = [];
  const pendingFrames = new Map();
  const browserTimers = new Map();
  let nextFrame = 0;
  let nextTimer = 0;
  let page;

  const window = {
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      browserTimers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      browserTimers.delete(id);
    },
  };
  const browserContext = createContext({
    window,
    clearTimeout: window.clearTimeout,
    requestAnimationFrame(callback) {
      const id = ++nextFrame;
      pendingFrames.set(id, callback);
      if (autoAnimationFrame) {
        queueMicrotask(() => {
          const frame = pendingFrames.get(id);
          if (!frame) return;
          pendingFrames.delete(id);
          frame(16);
        });
      }
      return id;
    },
    cancelAnimationFrame(id) {
      pendingFrames.delete(id);
    },
  });

  const cdp = {
    async send(method, params) {
      events.push({ kind: "send", method, params });
      const failure = failSend?.(method, params, events.length);
      if (failure) throw failure;
    },
    async detach() {
      events.push({ kind: "detach" });
      if (failDetach) throw failDetach;
    },
  };

  page = {
    context() {
      return { async newCDPSession(receivedPage) {
        assert.equal(receivedPage, page);
        events.push({ kind: "attach" });
        return cdp;
      } };
    },
    async evaluate(callback, args) {
      browserContext.__evaluateArgs = args;
      return runInContext(`(${callback.toString()})(__evaluateArgs)`, browserContext);
    },
    async waitForTimeout() {},
  };

  return { page, events, window, pendingFrames, browserTimers };
}

const gesture = overrides => ({
  start: { x: 10, y: 20 },
  end: { x: 30, y: 40 },
  moves: 2,
  waitForAnimationFrame: false,
  moveDelayMs: 0,
  id: 9,
  ...overrides,
});

test("dispatches a trusted touch drag in start, interpolated move, end, detach order", async () => {
  const fixture = touchFixture();
  const result = await dispatchTrustedTouchDrag(fixture.page, gesture({ force: null }));

  assert.equal(result.status, "dispatched");
  assert.deepEqual(fixture.events.map(event => event.kind === "send" ? event.params.type : event.kind), [
    "attach", "touchStart", "touchMove", "touchMove", "touchEnd", "detach",
  ]);
  const sent = fixture.events.filter(event => event.kind === "send");
  assert.deepEqual(sent.map(event => event.params.type), ["touchStart", "touchMove", "touchMove", "touchEnd"]);
  assert.deepEqual(sent[0].params.touchPoints[0], { x: 10, y: 20, id: 9 });
  assert.deepEqual(sent[1].params.touchPoints[0], { x: 20, y: 30, id: 9 });
  assert.deepEqual(sent[2].params.touchPoints[0], { x: 30, y: 40, id: 9 });
  assert.deepEqual(sent[3].params, { type: "touchEnd", touchPoints: [] });
});

test("touchmove failure still sends touchEnd and detaches the owned CDP session", async () => {
  const moveError = new Error("injected touchmove failure");
  const fixture = touchFixture({
    failSend: (_method, params) => params.type === "touchMove" ? moveError : null,
  });

  await assert.rejects(dispatchTrustedTouchDrag(fixture.page, gesture()), error => error === moveError);
  assert.deepEqual(fixture.events.map(event => event.kind === "send" ? event.params.type : event.kind), [
    "attach", "touchStart", "touchMove", "touchEnd", "detach",
  ]);
});

test("abort observed between touchmoves ends the gesture and detaches", async () => {
  const controller = new AbortController();
  const abortReason = new Error("owned touch run aborted");
  const fixture = touchFixture({
    failSend(_method, params) {
      if (params.type === "touchMove") controller.abort(abortReason);
      return null;
    },
  });

  await assert.rejects(dispatchTrustedTouchDrag(fixture.page, gesture({ moves: 3 }), controller.signal),
    error => error === abortReason);
  assert.deepEqual(fixture.events.map(event => event.kind === "send" ? event.params.type : event.kind), [
    "attach", "touchStart", "touchMove", "touchEnd", "detach",
  ]);
});

test("host animation-frame timeout cancels the registered browser waiter", { timeout: 3_000 }, async () => {
  const fixture = touchFixture({ autoAnimationFrame: false });

  await assert.rejects(dispatchTrustedTouchDrag(fixture.page, gesture({
    waitForAnimationFrame: true,
    animationFrameTimeoutMs: 100,
  })), /Timed out after 100ms waiting for a browser animation frame/);

  assert.equal(Object.hasOwn(fixture.window, "__kcoderE2ePendingAnimationFrameWaits"), false,
    "the browser waiter registry should be deleted after cancellation");
  assert.equal(fixture.pendingFrames.size, 0, "the pending requestAnimationFrame callback should be cancelled");
  assert.equal(fixture.browserTimers.size, 0, "the browser-side timeout should be cleared");
  assert.deepEqual(fixture.events.map(event => event.kind === "send" ? event.params.type : event.kind), [
    "attach", "touchStart", "touchMove", "touchEnd", "detach",
  ]);
});

test("touchend and detach cleanup failures remain visible alongside the primary error", async () => {
  const moveError = new Error("primary touchmove failure");
  const touchEndError = new Error("touchend cleanup failure");
  const detachError = new Error("CDP detach cleanup failure");
  const fixture = touchFixture({
    failSend(_method, params) {
      if (params.type === "touchMove") return moveError;
      if (params.type === "touchEnd") return touchEndError;
      return null;
    },
    failDetach: detachError,
  });

  await assert.rejects(dispatchTrustedTouchDrag(fixture.page, gesture()), error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors[0] instanceof AggregateError);
    assert.deepEqual(error.errors[0].errors, [moveError, touchEndError]);
    assert.equal(error.errors[1], detachError);
    return true;
  });
  assert.deepEqual(fixture.events.map(event => event.kind === "send" ? event.params.type : event.kind), [
    "attach", "touchStart", "touchMove", "touchEnd", "detach",
  ]);
});
