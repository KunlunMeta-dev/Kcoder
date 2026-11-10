// Owned static controls for the historical after339 diagnostic.
// The entrypoint supplies its original pins and helper references; import starts no resources.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { repoRoot } from "./run-context.mjs";

export function createMobilePrivateTouchControls({
  MOBILE_PAGE_OPTIONS, NESTED_TOUCH_CONTROL_SOURCE, NESTED_TOUCH_SCROLL_CONTROL_PATH,
  TOUCH_SCROLL_CONTROL_PATH, dispatchTrustedTouchGesture, hashBytes, safeErrorName,
}) {
const TOUCH_SCROLL_CONTROL_HTML = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>html,body{margin:0;padding:0;overflow:hidden}#touch-scrollport{width:100vw;height:360px;overflow:auto;touch-action:auto;-webkit-overflow-scrolling:touch}#touch-scroll-content{height:1800px;width:100%;background:linear-gradient(#fff,#ddd)}</style>
</head><body><div id="touch-scrollport" data-testid="touch-scroll-control"><div id="touch-scroll-content"></div></div>
<script>
(() => {
  const port = document.getElementById("touch-scrollport");
  const state = { nextTouchOrdinal: 0, touchEvents: [], droppedTouchEvents: 0, nextScrollOrdinal: 0, scrollEvents: [], droppedScrollEvents: 0 };
  const ordinals = new WeakMap();
  const save = (list, droppedKey, limit, value) => {
    if (list.length >= limit) { state[droppedKey] += 1; return; }
    list.push(value);
  };
  const targetId = event => event.target instanceof Element ? event.target.closest("[data-testid]")?.getAttribute("data-testid") ?? null : null;
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
    window.addEventListener(type, event => {
      const ordinal = ++state.nextTouchOrdinal;
      ordinals.set(event, ordinal);
      save(state.touchEvents, "droppedTouchEvents", 512, { ordinal, type, phase: "capture", trusted: event.isTrusted, defaultPrevented: event.defaultPrevented, targetTestId: targetId(event), targetWithinScrollport: port.contains(event.target) });
    }, { capture: true, passive: true });
    window.addEventListener(type, event => {
      const ordinal = ordinals.get(event);
      if (ordinal === undefined) return;
      save(state.touchEvents, "droppedTouchEvents", 512, { ordinal, type, phase: "bubble", trusted: event.isTrusted, defaultPrevented: event.defaultPrevented, targetTestId: targetId(event), targetWithinScrollport: port.contains(event.target) });
    }, { passive: true });
  }
  port.addEventListener("scroll", event => {
    const ordinal = ++state.nextScrollOrdinal;
    save(state.scrollEvents, "droppedScrollEvents", 256, { ordinal, trusted: event.isTrusted, scrollTop: port.scrollTop, scrollHeight: port.scrollHeight, clientHeight: port.clientHeight });
  }, { passive: true });
  Object.defineProperty(window, "__kcoderTouchControl", { value: state });
})();
</script></body></html>`;

const NESTED_TOUCH_SCROLL_CONTROL_HTML = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>
*{box-sizing:border-box}html,body{width:390px;height:844px;margin:0;padding:0;overflow:hidden}
#scene{position:relative;width:390px;height:844px;overflow:hidden}
#outer-auto{position:absolute;left:0;top:470px;width:390px;height:374px;overflow-x:hidden;overflow-y:auto;touch-action:auto;pointer-events:auto}
#sessions-list{position:relative;width:390px;height:374px;overflow-x:hidden;overflow-y:auto;touch-action:auto;pointer-events:auto;-webkit-overflow-scrolling:touch}
#list-content{position:relative;width:390px;height:1336px;overflow:visible;touch-action:auto;pointer-events:auto}
.virtual-row{position:relative;left:0;width:390px;height:82px;overflow:visible;touch-action:auto;pointer-events:auto}
.pressable-row{position:relative;left:16px;display:flex;align-items:center;gap:12px;width:358px;height:81px;overflow:visible;touch-action:manipulation;pointer-events:auto}
.row-icon{flex:0 0 38px;width:38px;height:38px;pointer-events:auto}
.row-copy{flex:1 1 0;height:51px;overflow:visible;touch-action:auto;pointer-events:auto}
.title-line{height:17px;overflow:hidden;white-space:nowrap;font:600 14px/17px sans-serif}
.meta-line{height:13px;margin-top:5px;overflow:hidden;white-space:nowrap;font:11px/13px sans-serif}
.text-clip-11{height:11px;margin-top:4px;overflow:hidden;white-space:nowrap;touch-action:auto;pointer-events:auto;font:10px/11px monospace}
.row-action{flex:0 0 44px;width:44px;height:44px;pointer-events:auto}
</style></head><body><div id="scene"><div id="outer-auto"><div id="sessions-list" data-testid="sessions-list"><div id="list-content"></div></div></div></div>
<script>
(() => {
  const content = document.getElementById("list-content");
  const list = document.getElementById("sessions-list");
  const state = { nextOrdinal: 0, events: [], droppedEvents: 0, scrollEvents: [], droppedScrollEvents: 0, inputPhase: "raw-cdp-touch" };
  const ordinals = new WeakMap();
  const scrollTargets = [
    ["sessions-list", list],
    ["outer-auto", document.getElementById("outer-auto")],
    ["scene", document.getElementById("scene")],
    ["documentElement", document.documentElement],
    ["body", document.body],
  ];
  const describeScrollTarget = (name, target) => {
    const style = target instanceof Element ? getComputedStyle(target) : null;
    return {
      name,
      scrollTop: target instanceof Element ? target.scrollTop : null,
      scrollLeft: target instanceof Element ? target.scrollLeft : null,
      scrollWidth: target instanceof Element ? target.scrollWidth : null,
      scrollHeight: target instanceof Element ? target.scrollHeight : null,
      clientWidth: target instanceof Element ? target.clientWidth : null,
      clientHeight: target instanceof Element ? target.clientHeight : null,
      overflowX: style?.overflowX ?? null,
      overflowY: style?.overflowY ?? null,
      touchAction: style?.touchAction ?? null,
      pointerEvents: style?.pointerEvents ?? null,
    };
  };
  const snapshotScrollTargets = () => scrollTargets.map(([name, target]) => describeScrollTarget(name, target));
  const save = (name, droppedName, value) => {
    if (state[name].length >= 512) { state[droppedName] += 1; return; }
    state[name].push(value);
  };
  const targetInfo = event => {
    const target = event.target instanceof Element ? event.target : null;
    const testId = target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
    return { targetTag: target?.tagName ?? null, targetTestId: testId, targetWithinList: Boolean(target && list.contains(target)),
      pointerType: typeof event.pointerType === "string" ? event.pointerType : null,
      pointerId: Number.isSafeInteger(event.pointerId) ? event.pointerId : null,
      isPrimary: typeof event.isPrimary === "boolean" ? event.isPrimary : null };
  };
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointermove", "pointerup", "pointercancel", "click"]) {
    window.addEventListener(type, event => {
      const ordinal = ++state.nextOrdinal;
      ordinals.set(event, ordinal);
      save("events", "droppedEvents", { ordinal, type, phase: "capture", trusted: event.isTrusted, cancelable: event.cancelable,
        defaultPrevented: event.defaultPrevented, inputPhase: state.inputPhase, atPageMs: performance.now(), ...targetInfo(event) });
    }, { capture: true, passive: true });
    window.addEventListener(type, event => {
      const ordinal = ordinals.get(event);
      if (ordinal === undefined) return;
      save("events", "droppedEvents", { ordinal, type, phase: "bubble", trusted: event.isTrusted, cancelable: event.cancelable,
        defaultPrevented: event.defaultPrevented, inputPhase: state.inputPhase, atPageMs: performance.now(), ...targetInfo(event) });
    }, { passive: true });
  }
  for (const [name, target] of scrollTargets) {
    target.addEventListener("scroll", event => save("scrollEvents", "droppedScrollEvents", {
      name, trusted: event.isTrusted, inputPhase: state.inputPhase, atPageMs: performance.now(),
      ...describeScrollTarget(name, target),
    }), { passive: true });
  }
  window.addEventListener("scroll", event => save("scrollEvents", "droppedScrollEvents", {
    name: "window", trusted: event.isTrusted, inputPhase: state.inputPhase, atPageMs: performance.now(), scrollX, scrollY,
  }), { passive: true });
  window.visualViewport?.addEventListener("scroll", event => save("scrollEvents", "droppedScrollEvents", {
    name: "visualViewport", trusted: event.isTrusted, inputPhase: state.inputPhase, atPageMs: performance.now(),
    offsetLeft: window.visualViewport.offsetLeft, offsetTop: window.visualViewport.offsetTop,
    pageLeft: window.visualViewport.pageLeft, pageTop: window.visualViewport.pageTop,
  }), { passive: true });
  state.snapshotScrollTargets = snapshotScrollTargets;
  for (let index = 0; index < 16; index += 1) {
    const id = "A_SESSIONS_FAST_" + index;
    const item = document.createElement("div");
    item.className = "virtual-row";
    item.dataset.rowIndex = String(index);
    const pressable = document.createElement("div");
    pressable.className = "pressable-row";
    pressable.dataset.testid = "session-" + id;
    const icon = document.createElement("div"); icon.className = "row-icon";
    const copy = document.createElement("div"); copy.className = "row-copy";
    const title = document.createElement("div"); title.className = "title-line"; title.textContent = "A Sessions first";
    const meta = document.createElement("div"); meta.className = "meta-line"; meta.textContent = "A-fast · KCoder · recent";
    const clipped = document.createElement("div"); clipped.className = "text-clip-11"; clipped.textContent = "/fixture/workspace";
    copy.append(title, meta, clipped);
    const action = document.createElement("div"); action.className = "row-action";
    pressable.append(icon, copy, action);
    item.append(pressable);
    content.append(item);
  }
  Object.defineProperty(window, "__kcoderNestedTouchControl", { value: state });
})();
</script></body></html>`;

async function proveOwnedTouchScrollControl(context, chromium, gatewayA) {
  const page = await chromium.newPage(MOBILE_PAGE_OPTIONS);
  context.addCleanup("close home-sessions owned touch-scroll control page", async () => {
    if (!page.isClosed()) await page.close();
  });
  const gatewayAOrigin = new URL(gatewayA.baseUrl).origin;
  const touchControlUrl = new URL(TOUCH_SCROLL_CONTROL_PATH, gatewayAOrigin).toString();
  let fulfilledCount = 0;
  let abortedOtherRequestCount = 0;
  let credentialHeaderPresent = false;
  await page.context().clearCookies();
  await page.route("**/*", async route => {
    const request = route.request();
    let isExpectedOrigin = false;
    try { isExpectedOrigin = new URL(request.url()).origin === gatewayAOrigin; } catch { /* abort malformed or foreign request */ }
    const headers = request.headers();
    const hasCredentialHeader = Boolean(headers.cookie || headers.authorization);
    credentialHeaderPresent ||= hasCredentialHeader;
    if (request.url() !== touchControlUrl || request.method() !== "GET" || !isExpectedOrigin || hasCredentialHeader) {
      abortedOtherRequestCount += 1;
      await route.abort("blockedbyclient");
      return;
    }
    fulfilledCount += 1;
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: TOUCH_SCROLL_CONTROL_HTML });
  });
  await page.goto(touchControlUrl, { waitUntil: "domcontentloaded" });
  const initial = await page.evaluate(() => {
    const port = document.getElementById("touch-scrollport");
    const style = getComputedStyle(port);
    const box = port.getBoundingClientRect();
    return {
      isAboutBlank: location.protocol === "about:",
      readyState: document.readyState,
      maxTouchPoints: Number(navigator.maxTouchPoints) || 0,
      ontouchstart: "ontouchstart" in window,
      scrollport: {
        scrollTop: port.scrollTop, scrollHeight: port.scrollHeight, clientHeight: port.clientHeight,
        overflowY: style.overflowY, touchAction: style.touchAction,
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
      },
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  await context.writeArtifactJson("mobile-home-sessions-lease3-touch-scroll-control-before.json", {
    schemaVersion: 1,
    source: "one exact GET page.route-fulfilled static document on the owned Gateway A origin; no backend request and no product bundle",
    routePath: TOUCH_SCROLL_CONTROL_PATH,
    exactOwnedOriginMatch: fulfilledCount === 1 && abortedOtherRequestCount === 0,
    configuredMobileOptions: MOBILE_PAGE_OPTIONS,
    fulfilledCount,
    abortedOtherRequestCount,
    credentialHeaderPresent,
    observed: initial,
  });
  const portBox = initial.scrollport.box;
  const x = Math.round(portBox.x + portBox.width / 2);
  const startY = Math.round(portBox.y + portBox.height * 0.82);
  const endY = Math.round(portBox.y + portBox.height * 0.18);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x, y: startY, id: 73 }],
    });
    let touchEnded = false;
    try {
      for (let move = 1; move <= 12; move += 1) {
        const y = startY + ((endY - startY) * move) / 12;
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove", touchPoints: [{ x, y, id: 73 }],
        });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      touchEnded = true;
    } finally {
      if (!touchEnded) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }).catch(() => {});
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const port = document.getElementById("touch-scrollport");
    const state = window.__kcoderTouchControl;
    return {
      scrollport: { scrollTop: port.scrollTop, scrollHeight: port.scrollHeight, clientHeight: port.clientHeight },
      trustedEventCounts: Object.fromEntries(["touchstart", "touchmove", "touchend", "touchcancel"].map(type => [
        type, state.touchEvents.filter(event => event.type === type && event.trusted).length,
      ])),
      preventedAtCapture: state.touchEvents.filter(event => event.phase === "capture" && event.defaultPrevented).length,
      preventedAtBubble: state.touchEvents.filter(event => event.phase === "bubble" && event.defaultPrevented).length,
      touchEvents: state.touchEvents,
      droppedTouchEvents: state.droppedTouchEvents,
      scrollEvents: state.scrollEvents,
      droppedScrollEvents: state.droppedScrollEvents,
    };
  });
  const gates = {
    oneOwnedRoute: fulfilledCount === 1,
    noUnexpectedRoute: abortedOtherRequestCount === 0,
    noCredentialHeaders: !credentialHeaderPresent,
    navigatedDocument: !initial.isAboutBlank,
    mobileTouchCapability: initial.maxTouchPoints > 0,
    realOverflow: initial.scrollport.scrollHeight > initial.scrollport.clientHeight,
    trustedTouchSequence: after.trustedEventCounts.touchstart > 0 && after.trustedEventCounts.touchmove > 0 && after.trustedEventCounts.touchend > 0,
    actualScroll: after.scrollport.scrollTop > initial.scrollport.scrollTop && after.scrollEvents.length > 0,
    collectorNotTruncated: after.droppedTouchEvents === 0 && after.droppedScrollEvents === 0,
  };
  const observation = {
    schemaVersion: 1,
    source: "one exact GET page.route-fulfilled static document on the owned Gateway A origin; no backend request and no product bundle",
    routePath: TOUCH_SCROLL_CONTROL_PATH,
    exactOwnedOriginMatch: fulfilledCount === 1 && abortedOtherRequestCount === 0,
    configuredMobileOptions: MOBILE_PAGE_OPTIONS,
    fulfilledCount,
    abortedOtherRequestCount,
    credentialHeaderPresent,
    initial,
    after,
    input: "same CDP Input.dispatchTouchEvent touchStart + 12 touchMove + touchEnd sequence used by the Sessions test",
    gates,
  };
  await context.writeArtifactJson("mobile-home-sessions-lease3-touch-scroll-control.json", observation);
  await page.close();
  return {
    passed: Object.values(gates).every(Boolean),
    gates,
    routeFulfilledExactlyOnce: fulfilledCount === 1,
    maxTouchPoints: initial.maxTouchPoints,
    ontouchstart: initial.ontouchstart,
    scrollTopDelta: after.scrollport.scrollTop - initial.scrollport.scrollTop,
    trustedEventCounts: after.trustedEventCounts,
    defaultPreventedAtCapture: after.preventedAtCapture,
    defaultPreventedAtBubble: after.preventedAtBubble,
  };
}

async function proveOwnedNestedTouchScrollControl(context, chromium, gatewayA) {
  const page = await chromium.newPage(MOBILE_PAGE_OPTIONS);
  context.addCleanup("close home-sessions owned nested touch-scroll control page", async () => {
    if (!page.isClosed()) await page.close();
  });
  const gatewayAOrigin = new URL(gatewayA.baseUrl).origin;
  const controlUrl = new URL(NESTED_TOUCH_SCROLL_CONTROL_PATH, gatewayAOrigin).toString();
  let fulfilledCount = 0;
  let abortedOtherRequestCount = 0;
  let credentialHeaderPresent = false;
  await page.context().clearCookies();
  await page.route("**/*", async route => {
    const request = route.request();
    let isExpectedOrigin = false;
    try { isExpectedOrigin = new URL(request.url()).origin === gatewayAOrigin; } catch { /* abort malformed or foreign request */ }
    const headers = request.headers();
    const hasCredentialHeader = Boolean(headers.cookie || headers.authorization);
    credentialHeaderPresent ||= hasCredentialHeader;
    if (request.url() !== controlUrl || request.method() !== "GET" || !isExpectedOrigin || hasCredentialHeader) {
      abortedOtherRequestCount += 1;
      await route.abort("blockedbyclient");
      return;
    }
    fulfilledCount += 1;
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: NESTED_TOUCH_SCROLL_CONTROL_HTML });
  });
  await page.goto(controlUrl, { waitUntil: "domcontentloaded" });
  const before = await page.evaluate(({ profile }) => {
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const describe = element => {
      if (!(element instanceof Element)) return null;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className : null,
        testId: element.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        box: box(element),
        display: style.display,
        position: style.position,
        heightCss: style.height,
        minHeightCss: style.minHeight,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        pointerEvents: style.pointerEvents,
        touchAction: style.touchAction,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
      };
    };
    const list = document.getElementById("sessions-list");
    const outer = document.getElementById("outer-auto");
    const content = document.getElementById("list-content");
    const start = document.elementFromPoint(profile.gesture.start.x, profile.gesture.start.y);
    const end = document.elementFromPoint(profile.gesture.end.x, profile.gesture.end.y);
    const chain = [];
    for (let node = start; node && chain.length < 12; node = node.parentElement) {
      chain.push(describe(node));
      if (node === list) break;
    }
    return {
      isAboutBlank: location.protocol === "about:",
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, maxTouchPoints: Number(navigator.maxTouchPoints) || 0 },
      outer: describe(outer),
      scene: describe(document.getElementById("scene")),
      scrollport: describe(list),
      content: describe(content),
      documentElement: describe(document.documentElement),
      body: describe(document.body),
      pageScroll: { scrollX, scrollY, visualViewport: window.visualViewport ? {
        offsetLeft: window.visualViewport.offsetLeft, offsetTop: window.visualViewport.offsetTop,
        pageLeft: window.visualViewport.pageLeft, pageTop: window.visualViewport.pageTop,
      } : null },
      startPoint: { point: profile.gesture.start, target: describe(start), withinScrollport: Boolean(start && list.contains(start)) },
      endPoint: { point: profile.gesture.end, target: describe(end), withinScrollport: Boolean(end && list.contains(end)) },
      targetAncestorChain: chain,
      pressableSemantics: (() => {
        const pressable = start instanceof Element ? start.closest(".pressable-row") : null;
        return pressable ? {
          tag: pressable.tagName,
          role: pressable.getAttribute("role"),
          tabIndexAttribute: pressable.getAttribute("tabindex"),
          inlineOnClickProperty: typeof pressable.onclick === "function",
        } : null;
      })(),
      scrollTargets: window.__kcoderNestedTouchControl.snapshotScrollTargets(),
      sourceProfile: profile,
    };
  }, { profile: NESTED_TOUCH_CONTROL_SOURCE });
  await context.writeArtifactJson("mobile-home-sessions-lease3-nested-touch-scroll-control-before.json", {
    schemaVersion: 1,
    source: "one exact GET page.route-fulfilled static document on the owned Gateway A origin; no backend request and no product bundle",
    routePath: NESTED_TOUCH_SCROLL_CONTROL_PATH,
    exactOwnedOriginMatch: fulfilledCount === 1 && abortedOtherRequestCount === 0,
    configuredMobileOptions: MOBILE_PAGE_OPTIONS,
    fulfilledCount,
    abortedOtherRequestCount,
    credentialHeaderPresent,
    measured: before,
  });

  const dispatchTouchGesture = async (gesture, id) => {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: gesture.start.x, y: gesture.start.y, id }],
      });
      let touchEnded = false;
      try {
        for (let move = 1; move <= gesture.moves; move += 1) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: gesture.start.x + ((gesture.end.x - gesture.start.x) * move) / gesture.moves,
              y: gesture.start.y + ((gesture.end.y - gesture.start.y) * move) / gesture.moves, id }],
          });
          await page.waitForTimeout(16);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        touchEnded = true;
      } finally {
        if (!touchEnded) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }).catch(() => {});
      }
    } finally {
      await cdp.detach().catch(() => {});
    }
    await page.waitForTimeout(200);
  };
  const readTouchState = async () => page.evaluate(() => {
    const list = document.getElementById("sessions-list");
    const state = window.__kcoderNestedTouchControl;
    const eventCounts = Object.fromEntries(
      ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointermove", "pointerup", "pointercancel", "click"]
        .map(type => [type, state.events.filter(event => event.type === type && event.trusted).length]),
    );
    return {
      scrollport: { scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight },
      scrollTargets: state.snapshotScrollTargets(),
      pageScroll: { scrollX, scrollY, visualViewport: window.visualViewport ? {
        offsetLeft: window.visualViewport.offsetLeft, offsetTop: window.visualViewport.offsetTop,
        pageLeft: window.visualViewport.pageLeft, pageTop: window.visualViewport.pageTop,
      } : null },
      trustedEventCounts: eventCounts,
      cancelableEventCount: state.events.filter(event => event.cancelable).length,
      nonCancelableEventCount: state.events.filter(event => !event.cancelable).length,
      defaultPreventedAtCapture: state.events.filter(event => event.phase === "capture" && event.defaultPrevented).length,
      defaultPreventedAtBubble: state.events.filter(event => event.phase === "bubble" && event.defaultPrevented).length,
      pointerCancellationCount: state.events.filter(event => event.type === "pointercancel" && event.trusted).length,
      touchCancellationCount: state.events.filter(event => event.type === "touchcancel" && event.trusted).length,
      listScrollEvents: state.scrollEvents.filter(event => event.name === "sessions-list"),
      events: state.events,
      droppedEvents: state.droppedEvents,
      scrollEvents: state.scrollEvents,
      droppedScrollEvents: state.droppedScrollEvents,
    };
  });
  await dispatchTouchGesture(NESTED_TOUCH_CONTROL_SOURCE.gesture, 74);
  const after = await readTouchState();
  const observation = {
    schemaVersion: 1,
    source: "one exact GET page.route-fulfilled static document on the owned Gateway A origin; no backend request and no product bundle",
    routePath: NESTED_TOUCH_SCROLL_CONTROL_PATH,
    exactOwnedOriginMatch: fulfilledCount === 1 && abortedOtherRequestCount === 0,
    configuredMobileOptions: MOBILE_PAGE_OPTIONS,
    input: "primary trusted CDP touchStart + 12 touchMove + touchEnd path at the actual clipped-text target x195 y777 to y537; a second same-row flex-gap target comparison follows after a fresh route reload",
    fulfilledCount,
    abortedOtherRequestCount,
    credentialHeaderPresent,
    before,
    after,
    controlPressableSemantics: before.pressableSemantics,
    interpretation: "geometry and CSS are measured, but this control uses a generic DIV without role, tabindex, or onPress behavior; it is not a full React Native Web Pressable clone",
  };
  await context.writeArtifactJson("mobile-home-sessions-lease3-nested-touch-scroll-control.json", observation);

  const rowBackgroundGesture = Object.freeze({
    start: Object.freeze({ x: 60, y: 777 }),
    end: Object.freeze({ x: 60, y: 537 }),
    moves: NESTED_TOUCH_CONTROL_SOURCE.gesture.moves,
  });
  await page.goto(controlUrl, { waitUntil: "domcontentloaded" });
  const rowBackgroundBefore = await page.evaluate(({ point }) => {
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const describe = element => {
      if (!(element instanceof Element)) return null;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className : null,
        testId: element.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        box: box(element),
        heightCss: style.height,
        pointerEvents: style.pointerEvents,
        touchAction: style.touchAction,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        scrollTop: element.scrollTop,
        scrollLeft: element.scrollLeft,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
      };
    };
    const list = document.getElementById("sessions-list");
    const target = document.elementFromPoint(point.x, point.y);
    const chain = [];
    for (let node = target; node && chain.length < 12; node = node.parentElement) {
      chain.push(describe(node));
      if (node === list) break;
    }
    const pressable = target instanceof Element ? target.closest(".pressable-row") : null;
    return {
      viewport: { width: innerWidth, height: innerHeight, maxTouchPoints: Number(navigator.maxTouchPoints) || 0 },
      point,
      target: describe(target),
      targetWithinScrollport: Boolean(target && list.contains(target)),
      scrollport: describe(list),
      targetAncestorChain: chain,
      pressableSemantics: pressable ? {
        tag: pressable.tagName,
        role: pressable.getAttribute("role"),
        tabIndexAttribute: pressable.getAttribute("tabindex"),
        inlineOnClickProperty: typeof pressable.onclick === "function",
      } : null,
      documentScroll: { scrollX, scrollY, scrollHeight: document.scrollingElement?.scrollHeight ?? null,
        clientHeight: document.scrollingElement?.clientHeight ?? null },
    };
  }, { point: rowBackgroundGesture.start });
  await context.writeArtifactJson("mobile-home-sessions-lease3-nested-touch-row-background-before.json", {
    schemaVersion: 1,
    source: "same exact route-fulfilled control and row geometry; x60 is the 12px flex gap between the 38px icon and 252px copy, within the row Pressable",
    routePath: NESTED_TOUCH_SCROLL_CONTROL_PATH,
    routeFulfilledCount: fulfilledCount,
    expectedRouteFulfilledCount: 2,
    abortedOtherRequestCount,
    credentialHeaderPresent,
    configuredMobileOptions: MOBILE_PAGE_OPTIONS,
    measured: rowBackgroundBefore,
  });
  await dispatchTouchGesture(rowBackgroundGesture, 75);
  const rowBackgroundAfter = await readTouchState();
  await context.writeArtifactJson("mobile-home-sessions-lease3-nested-touch-row-background.json", {
    schemaVersion: 1,
    routePath: NESTED_TOUCH_SCROLL_CONTROL_PATH,
    routeFulfilledCount: fulfilledCount,
    expectedRouteFulfilledCount: 2,
    abortedOtherRequestCount,
    credentialHeaderPresent,
    input: "same 12-move trusted CDP touch path and y coordinates as the clipped-target case; only x changes from 195 to 60",
    before: rowBackgroundBefore,
    after: rowBackgroundAfter,
    interpretation: "diagnostic hit-target comparison only; same generic DIV control, same row, same scroll chain and pressable touch-action, with the start moved from the 11px clipped child to the 12px flex gap",
  });
  const gates = {
    twoExactOwnedRouteRequests: fulfilledCount === 2,
    noUnexpectedRequests: abortedOtherRequestCount === 0,
    noCredentialHeaders: !credentialHeaderPresent,
    navigatedDocument: !before.isAboutBlank,
    fixedMobileViewport: before.viewport.width === 390 && before.viewport.height === 844,
    mobileTouchCapability: before.viewport.maxTouchPoints > 0,
    exactObservedScrollport: before.scrollport.box.x === 0 && before.scrollport.box.y === 470 &&
      before.scrollport.box.width === 390 && before.scrollport.box.height === 374,
    exactObservedScrollRange: before.scrollport.scrollHeight === 1336 && before.scrollport.clientHeight === 374,
    outerAncestorHasNoScrollRange: before.outer.scrollHeight === 374 && before.outer.clientHeight === 374,
    clippedStartHitsMeasuredText: Boolean(before.startPoint.withinScrollport && before.startPoint.target?.className === "text-clip-11" &&
      before.startPoint.target.box.top <= NESTED_TOUCH_CONTROL_SOURCE.gesture.start.y &&
      before.startPoint.target.box.bottom > NESTED_TOUCH_CONTROL_SOURCE.gesture.start.y &&
      before.startPoint.target.scrollHeight === 11 && before.startPoint.target.clientHeight === 11 &&
      before.startPoint.target.overflowY === "hidden" &&
      before.startPoint.target.box.x === 66 && before.startPoint.target.box.y === 770 &&
      before.startPoint.target.box.width === 252 && before.startPoint.target.box.height === 11),
    clippedPathStaysInsideScrollport: before.endPoint.withinScrollport,
    clippedPathPressableSemantics: before.targetAncestorChain.find(node => node.className === "pressable-row")?.touchAction === "manipulation" &&
      before.targetAncestorChain.find(node => node.className === "row-copy")?.heightCss === "51px",
    gapStartHitsSameRowPressable: Boolean(rowBackgroundBefore.targetWithinScrollport && rowBackgroundBefore.target?.className === "pressable-row" &&
      rowBackgroundBefore.targetAncestorChain.find(node => node.className === "pressable-row")?.touchAction === "manipulation"),
    equivalentScrollportGeometry: rowBackgroundBefore.scrollport.box.x === before.scrollport.box.x &&
      rowBackgroundBefore.scrollport.box.y === before.scrollport.box.y &&
      rowBackgroundBefore.scrollport.box.width === before.scrollport.box.width &&
      rowBackgroundBefore.scrollport.box.height === before.scrollport.box.height,
    clippedTargetTrustedTouch: after.trustedEventCounts.touchstart > 0 && after.trustedEventCounts.touchmove > 0 && after.trustedEventCounts.touchend > 0,
    sameRowGapTrustedTouch: rowBackgroundAfter.trustedEventCounts.touchstart > 0 && rowBackgroundAfter.trustedEventCounts.touchmove > 0 && rowBackgroundAfter.trustedEventCounts.touchend > 0,
    originalClippedTargetRawTouchScrollGate: after.scrollport.scrollTop > before.scrollport.scrollTop && after.listScrollEvents.length > 0,
    collectorsNotTruncated: after.droppedEvents === 0 && after.droppedScrollEvents === 0 &&
      rowBackgroundAfter.droppedEvents === 0 && rowBackgroundAfter.droppedScrollEvents === 0,
  };
  await context.writeArtifactJson("mobile-home-sessions-lease3-nested-touch-target-comparison.json", {
    schemaVersion: 1,
    routePath: NESTED_TOUCH_SCROLL_CONTROL_PATH,
    exactOwnedRequests: fulfilledCount === 2 && abortedOtherRequestCount === 0 && !credentialHeaderPresent,
    cases: [
      { name: "clipped-text", start: NESTED_TOUCH_CONTROL_SOURCE.gesture.start, before, after },
      { name: "same-row-flex-gap", start: rowBackgroundGesture.start, before: rowBackgroundBefore, after: rowBackgroundAfter },
    ],
    gates,
  });
  await page.close();
  return {
    passed: Object.values(gates).every(Boolean),
    gates,
    routeFulfilledExactlyTwice: fulfilledCount === 2,
    scrollTopDelta: after.scrollport.scrollTop - before.scrollport.scrollTop,
    rowBackgroundScrollTopDelta: rowBackgroundAfter.scrollport.scrollTop - rowBackgroundBefore.scrollport.scrollTop,
    rowBackgroundScrollEvents: rowBackgroundAfter.listScrollEvents.length,
    trustedEventCounts: after.trustedEventCounts,
    cancelableEventCount: after.cancelableEventCount,
    nonCancelableEventCount: after.nonCancelableEventCount,
    defaultPreventedAtCapture: after.defaultPreventedAtCapture,
    defaultPreventedAtBubble: after.defaultPreventedAtBubble,
    pointerCancellationCount: after.pointerCancellationCount,
    touchCancellationCount: after.touchCancellationCount,
  };
}

async function buildSamePageRnwTouchControl(context) {
  const mobileRoot = resolve(repoRoot, "apps/kcoder-studio/mobile");
  const mobilePackagePath = resolve(mobileRoot, "package.json");
  const mobileLockPath = resolve(mobileRoot, "package-lock.json");
  const mobileNodeModules = resolve(mobileRoot, "node_modules");
  const mobileNodeModulesReal = await realpath(mobileNodeModules);
  const mobilePackageBytes = await readFile(mobilePackagePath);
  const mobileLockBytes = await readFile(mobileLockPath);
  const mobilePackage = JSON.parse(mobilePackageBytes.toString("utf8"));
  const mobileLock = JSON.parse(mobileLockBytes.toString("utf8"));
  const pinnedModules = [
    ["react", "19.1.0"],
    ["react-dom", "19.1.0"],
    ["react-native-web", "0.21.2"],
    ["esbuild", "0.28.1"],
  ];
  const modules = [];
  for (const [name, expectedVersion] of pinnedModules) {
    const packagePath = resolve(mobileNodeModules, name, "package.json");
    const packageRealPath = await realpath(packagePath);
    const packageRelativeToNodeModules = relative(mobileNodeModulesReal, packageRealPath);
    assert.ok(packageRelativeToNodeModules && packageRelativeToNodeModules !== ".." &&
      !packageRelativeToNodeModules.startsWith(`..${sep}`) && !isAbsolute(packageRelativeToNodeModules),
    `${name} package must remain inside the pinned Mobile node_modules tree`);
    const packageBytes = await readFile(packageRealPath);
    const packageInfo = JSON.parse(packageBytes.toString("utf8"));
    const lockedVersion = mobileLock.packages?.[`node_modules/${name}`]?.version ?? null;
    assert.equal(packageInfo.version, expectedVersion, `${name} runtime version changed`);
    assert.equal(lockedVersion, expectedVersion, `${name} package-lock resolution changed`);
    modules.push({ name, version: packageInfo.version, packageSha256: hashBytes(packageBytes) });
  }
  assert.equal(mobilePackage.dependencies?.react, "19.1.0");
  assert.equal(mobilePackage.dependencies?.["react-dom"], "19.1.0");
  assert.equal(mobilePackage.dependencies?.["react-native-web"], "~0.21.0");
  assert.equal(mobilePackage.devDependencies?.esbuild, "^0.28.1");

  const fixtureRelativePath = "apps/kcoder-studio/e2e/private/fixtures/rnw-sessions-touch-control.jsx";
  const fixturePath = resolve(repoRoot, fixtureRelativePath);
  const fixtureBytes = await readFile(fixturePath);
  const mobileRequire = createRequire(mobilePackagePath);
  const esbuild = mobileRequire("esbuild");
  assert.equal(esbuild.version, "0.28.1");
  const output = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: [fixturePath],
    outfile: "same-page-rnw-sessions-touch-control.js",
    bundle: true,
    write: false,
    metafile: true,
    format: "iife",
    globalName: "KCoderRnwSessionsTouchControlBundle",
    platform: "browser",
    target: ["chrome120"],
    jsx: "automatic",
    alias: { "react-native": "react-native-web" },
    nodePaths: [mobileNodeModules],
    define: { "process.env.NODE_ENV": '"production"' },
    sourcemap: false,
    logLevel: "silent",
  });
  assert.equal(output.outputFiles.length, 1, "RNW control must build to one in-memory browser bundle");
  const bundleBytes = Buffer.from(output.outputFiles[0].contents);
  const bundlePath = context.pathInState("same-page-rnw-sessions-touch-control.js");
  await writeFile(bundlePath, bundleBytes, { flag: "wx", mode: 0o600 });
  const evidence = {
    schemaVersion: 1,
    classification: "test-only same-page RNW control fixture; not part of the app export and not a product edit",
    fixtureRelativePath,
    fixtureSha256: hashBytes(fixtureBytes),
    mobilePackageSha256: hashBytes(mobilePackageBytes),
    mobilePackageLockSha256: hashBytes(mobileLockBytes),
    modulePins: modules,
    esbuildVersion: esbuild.version,
    mobileNodeModulesLink: {
      isSymbolicLink: (await lstat(mobileNodeModules)).isSymbolicLink(),
      resolvedTargetWithinRepo: relative(repoRoot, mobileNodeModulesReal),
    },
    mobileNodeModulesRealPathRelation: relative(repoRoot, mobileNodeModulesReal),
    bundleSha256: hashBytes(bundleBytes),
    bundleBytes: bundleBytes.byteLength,
    bundleInputCount: Object.keys(output.metafile.inputs).length,
    outputFileCount: output.outputFiles.length,
    importAlias: { "react-native": "react-native-web" },
    execution: "one generated test bundle is injected into the already-open actual Sessions page; it creates/removes a separate RNW root overlay at the actual list viewport",
  };
  context.addCleanup("verify same-page RNW fixture and package pins unchanged", async () => {
    assert.equal(hashBytes(await readFile(fixturePath)), evidence.fixtureSha256, "RNW control fixture changed during the run");
    assert.equal(hashBytes(await readFile(mobilePackagePath)), evidence.mobilePackageSha256, "Mobile package manifest changed during the run");
    assert.equal(hashBytes(await readFile(mobileLockPath)), evidence.mobilePackageLockSha256, "Mobile lockfile changed during the run");
    const currentNodeModulesReal = await realpath(mobileNodeModules);
    assert.equal(currentNodeModulesReal, mobileNodeModulesReal, "Mobile node_modules link target changed during the run");
    for (const module of modules) {
      const packageBytes = await readFile(resolve(mobileNodeModules, module.name, "package.json"));
      assert.equal(hashBytes(packageBytes), module.packageSha256, `${module.name} package changed during the run`);
    }
  });
  return { bundlePath, evidence };
}

async function measureSamePageRnwTouchControl(context, page, bundle, actualListBefore, clippedPoint, endPoint, ownedGatewayBaseUrl) {
  let fixtureScriptUrl = null;
  let fixtureRouteHandler = null;
  const result = {
    schemaVersion: 1,
    status: "starting",
    pageIdentity: { pathname: null, originMatchesOwnedGateway: false, samePageAsActualSessionsSample: true },
    bundle: bundle.evidence,
    fixtureScriptRoute: {
      classification: "test-only exact-origin script fixture; not a Gateway product asset or public export",
      status: "not-started",
      bundleSha256: bundle.evidence.bundleSha256,
      requestCount: 0,
      fulfilledCount: 0,
      rejectedRequestCount: 0,
      duplicateRequestCount: 0,
      unrouteCompleted: false,
    },
    cases: [],
    responderComparison: {
      classification: "test-only same-RNW-ScrollView diagnostic; replaces only row 3 Pressable with a View retaining touchAction: manipulation",
      status: "not-run",
    },
    cleanupErrors: [],
  };
  try {
    const currentUrl = new URL(page.url());
    const expectedOrigin = new URL(ownedGatewayBaseUrl).origin;
    const evaluatedOrigin = await page.evaluate(() => location.origin);
    result.pageIdentity = {
      pathname: currentUrl.pathname,
      origin: currentUrl.origin,
      evaluatedOrigin,
      expectedOwnedOrigin: expectedOrigin,
      originMatchesOwnedGateway: currentUrl.origin === expectedOrigin && evaluatedOrigin === expectedOrigin,
      samePageAsActualSessionsSample: true,
    };
    assert.equal(result.pageIdentity.originMatchesOwnedGateway, true,
      "RNW control script may only be routed on the exact owned Gateway page origin");
    const fixtureBytes = await readFile(bundle.bundlePath);
    const fixtureSha256 = hashBytes(fixtureBytes);
    assert.equal(fixtureSha256, bundle.evidence.bundleSha256, "RNW control bundle bytes changed before same-origin serving");
    const fixturePath = `/__e2e_rnw_sessions_touch_control_${fixtureSha256}.js`;
    fixtureScriptUrl = new URL(fixturePath, expectedOrigin).toString();
    assert.equal(new URL(fixtureScriptUrl).origin, expectedOrigin, "RNW control fixture URL escaped its owned Gateway origin");
    result.fixtureScriptRoute.path = fixturePath;
    result.fixtureScriptRoute.bodyBytes = fixtureBytes.byteLength;
    result.fixtureScriptRoute.bodySha256 = fixtureSha256;
    fixtureRouteHandler = async route => {
      const request = route.request();
      const exactRequest = request.url() === fixtureScriptUrl && request.method() === "GET" && request.resourceType() === "script";
      if (!exactRequest) {
        result.fixtureScriptRoute.rejectedRequestCount += 1;
        await route.abort("blockedbyclient");
        return;
      }
      result.fixtureScriptRoute.requestCount += 1;
      if (result.fixtureScriptRoute.requestCount !== 1) {
        result.fixtureScriptRoute.duplicateRequestCount += 1;
        await route.abort("blockedbyclient");
        return;
      }
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/javascript; charset=utf-8",
          headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
          body: fixtureBytes,
        });
        result.fixtureScriptRoute.fulfilledCount += 1;
        result.fixtureScriptRoute.responseStatus = 200;
        result.fixtureScriptRoute.contentType = "application/javascript; charset=utf-8";
        result.fixtureScriptRoute.fulfilledBodySha256 = fixtureSha256;
        result.fixtureScriptRoute.status = "fulfilled-exact-owned-get";
      } catch (error) {
        result.fixtureScriptRoute.status = "fulfill-error";
        result.fixtureScriptRoute.fulfillErrorName = safeErrorName(error);
        throw error;
      }
    };
    result.fixtureScriptRoute.status = "route-armed";
    await page.route(fixtureScriptUrl, fixtureRouteHandler);
    await page.addScriptTag({ url: fixtureScriptUrl });
    assert.equal(result.fixtureScriptRoute.requestCount, 1, "RNW control script must be requested exactly once");
    assert.equal(result.fixtureScriptRoute.fulfilledCount, 1, "RNW control script must be fulfilled exactly once");
    assert.equal(result.fixtureScriptRoute.rejectedRequestCount, 0, "no non-exact request may use the RNW control route");
    assert.equal(result.fixtureScriptRoute.duplicateRequestCount, 0, "RNW control script route must not fulfill duplicate requests");
    result.fixtureScriptRoute.bundleExportAvailable = await page.evaluate(() =>
      typeof window.KCoderRnwSessionsTouchControlBundle?.mountRnwTouchControl === "function");
    assert.equal(result.fixtureScriptRoute.bundleExportAvailable, true,
      "same-origin RNW control script must execute and expose its test-only mount function");
    result.fixtureScriptRoute.status = "loaded-and-export-verified-by-same-origin-url";
    for (const mode of ["clipped-text", "same-row-row-gap", "non-pressable-same-action"]) {
      const start = mode === "same-row-row-gap" ? { x: 60, y: clippedPoint.y } : clippedPoint;
      const touchEnd = { x: start.x, y: endPoint.y };
      await page.evaluate(modeValue => {
        const fixture = window.KCoderRnwSessionsTouchControlBundle;
        if (!fixture || typeof fixture.mountRnwTouchControl !== "function") throw new Error("RNW fixture mount export is unavailable");
        fixture.mountRnwTouchControl(modeValue);
      }, mode);
      await page.waitForFunction(() => {
        const overlay = document.querySelector('[data-testid="rnw-control-overlay"]');
        const list = document.querySelector('[data-testid="rnw-control-scrollport"]');
        const target = document.querySelector('[data-testid="rnw-control-clipped-text"]');
        return Boolean(overlay && list && target && overlay.getBoundingClientRect().width > 0 && list.clientHeight > 0 && target.getBoundingClientRect().height > 0);
      }, null, { timeout: 5_000 });
      const before = await page.evaluate(({ modeValue, startPoint, endPoint, expectedOriginValue }) => {
        const rect = element => {
          if (!(element instanceof Element)) return null;
          const value = element.getBoundingClientRect();
          return { x: value.x, y: value.y, left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
        };
        const describe = element => {
          if (!(element instanceof Element)) return null;
          const style = getComputedStyle(element);
          return {
            tag: element.tagName,
            testId: element.getAttribute("data-testid"),
            role: element.getAttribute("role"),
            tabIndex: element.tabIndex,
            box: rect(element),
            touchAction: style.touchAction,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            pointerEvents: style.pointerEvents,
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          };
        };
        const overlay = document.querySelector('[data-testid="rnw-control-overlay"]');
        const outer = document.querySelector('[data-testid="rnw-control-outer"]');
        const list = document.querySelector('[data-testid="rnw-control-scrollport"]');
        const target = document.querySelector('[data-testid="rnw-control-clipped-text"]');
        const rowWrapper = target?.closest('[data-testid="rnw-control-row-3"]');
        const pressable = modeValue === "non-pressable-same-action" ? null : rowWrapper;
        const homeList = document.querySelector('[data-testid="sessions-list"]');
        const startHit = document.elementFromPoint(startPoint.x, startPoint.y);
        const endHit = document.elementFromPoint(endPoint.x, endPoint.y);
        const describeAncestorPath = (element, limit = 16) => {
          const path = [];
          for (let node = element; node instanceof Element && path.length < limit; node = node.parentElement) {
            const described = describe(node);
            if (!described) continue;
            path.push({
              ...described,
              verticallyScrollable: node.scrollHeight > node.clientHeight + 1 &&
                /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY),
            });
          }
          return path;
        };
        const inViewport = point => point.x >= 0 && point.y >= 0 && point.x < innerWidth && point.y < innerHeight;
        const within = (element, point) => {
          if (!(element instanceof Element)) return false;
          const box = element.getBoundingClientRect();
          return point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom;
        };
        const chain = [];
        for (let node = target; node && chain.length < 10; node = node.parentElement) {
          chain.push(describe(node));
          if (node === list) break;
        }
        return {
          mode: modeValue,
          page: { origin: location.origin, expectedOrigin: expectedOriginValue, pathname: location.pathname,
            innerWidth, innerHeight, devicePixelRatio, maxTouchPoints: Number(navigator.maxTouchPoints) || 0 },
          overlay: describe(overlay),
          outer: describe(outer),
          scrollport: describe(list),
          target: describe(target),
          rowWrapper: describe(rowWrapper),
          pressable: describe(pressable),
          targetBelongsToPressable: Boolean(pressable && target && pressable.contains(target)),
          targetBelongsToRowWrapper: Boolean(rowWrapper && target && rowWrapper.contains(target)),
          targetHit: { isTarget: startHit === target, withinTargetText: Boolean(target && startHit && (startHit === target || target.contains(startHit))),
            testId: startHit instanceof Element ? startHit.getAttribute("data-testid") : null,
            tag: startHit instanceof Element ? startHit.tagName : null, withinScrollport: Boolean(list && startHit && list.contains(startHit)),
            withinRowPressable: Boolean(pressable && startHit && pressable.contains(startHit)),
            withinRowWrapper: Boolean(rowWrapper && startHit && rowWrapper.contains(startHit)),
            stack: document.elementsFromPoint(startPoint.x, startPoint.y).slice(0, 6).map(describe) },
          endHit: { testId: endHit instanceof Element ? endHit.getAttribute("data-testid") : null,
            tag: endHit instanceof Element ? endHit.tagName : null, withinScrollport: Boolean(list && endHit && list.contains(endHit)),
            stack: document.elementsFromPoint(endPoint.x, endPoint.y).slice(0, 6).map(describe) },
          gestureBounds: {
            startInViewport: inViewport(startPoint), endInViewport: inViewport(endPoint),
            startInControlScrollport: within(list, startPoint), endInControlScrollport: within(list, endPoint),
            startToEndDeltaY: endPoint.y - startPoint.y,
          },
          chain,
          startAncestorPath: describeAncestorPath(startHit),
          endAncestorPath: describeAncestorPath(endHit),
          touchActionAncestorPath: describeAncestorPath(target),
          scrollableAncestorPath: describeAncestorPath(startHit).filter(node => node.verticallyScrollable),
          endScrollableAncestorPath: describeAncestorPath(endHit).filter(node => node.verticallyScrollable),
          actualSessionsListBeforeControl: describe(homeList),
        };
      }, { modeValue: mode, startPoint: start, endPoint: touchEnd, expectedOriginValue: expectedOrigin });
      const controlCursor = await page.evaluate(({ modeValue }) => {
        const list = document.querySelector('[data-testid="rnw-control-scrollport"]');
        const target = document.querySelector('[data-testid="rnw-control-clipped-text"]');
        const state = {
          mode: modeValue,
          events: [],
          scrollEvents: [],
          responderEvents: [],
          droppedEvents: 0,
          droppedScrollEvents: 0,
          droppedResponderEvents: 0,
        };
        const save = (collection, droppedName, event) => {
          if (collection.length >= 128) { state[droppedName] += 1; return; }
          collection.push(event);
        };
        const info = event => {
          const targetElement = event.target instanceof Element ? event.target : null;
          return {
            type: event.type,
            trusted: event.isTrusted,
            cancelable: event.cancelable,
            defaultPrevented: event.defaultPrevented,
            targetTag: targetElement?.tagName ?? null,
            targetTestId: targetElement?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
            targetWithinControl: Boolean(targetElement && eventTargetList.contains(targetElement)),
            atPageMs: performance.now(),
          };
        };
        const eventTargetList = list;
        for (const type of ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointermove", "pointerup", "pointercancel", "click"]) {
          window.addEventListener(type, event => save(state.events, "droppedEvents", info(event)), { capture: true, passive: true });
        }
        const fixture = window.KCoderRnwSessionsTouchControlBundle;
        const responderInfo = event => {
          const targetElement = event.target instanceof Element ? event.target : null;
          return {
            type: event.type,
            trusted: event.isTrusted,
            targetTestId: targetElement?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
            responderOwner: fixture?.currentResponderOwner?.() ?? null,
            atPageMs: performance.now(),
          };
        };
        const responderEventTypes = ["touchstart", "touchmove", "touchend", "touchcancel"];
        const responderEventHandler = event => save(state.responderEvents, "droppedResponderEvents", responderInfo(event));
        for (const type of responderEventTypes) window.addEventListener(type, responderEventHandler, { passive: true });
        const responderScrollHandler = event => save(state.responderEvents, "droppedResponderEvents", responderInfo(event));
        document.addEventListener("scroll", responderScrollHandler, true);
        state.detachResponderObservers = () => {
          for (const type of responderEventTypes) window.removeEventListener(type, responderEventHandler);
          document.removeEventListener("scroll", responderScrollHandler, true);
        };
        list.addEventListener("scroll", event => save(state.scrollEvents, "droppedScrollEvents", {
          trusted: event.isTrusted, atPageMs: performance.now(), scrollTop: list.scrollTop,
          scrollHeight: list.scrollHeight, clientHeight: list.clientHeight,
        }), { passive: true });
        window.__kcoderRnwControlInputState = state;
        window.__kcoderRnwControlPressCountBefore = window.__kcoderRnwSessionsTouchControl?.state?.pressCount ?? null;
        return {
          startScrollTop: list.scrollTop,
          targetConnected: Boolean(target?.isConnected),
          responderOwnerBeforeGesture: fixture?.currentResponderOwner?.() ?? null,
        };
      }, { modeValue: mode });
      const gesture = { start, end: touchEnd, moves: 12 };
      await dispatchTrustedTouchGesture(page, gesture, mode === "clipped-text" ? 611 : 612, context.abortSignal);
      await page.waitForTimeout(200);
      const after = await page.evaluate(({ modeValue, clippedPoint }) => {
        const list = document.querySelector('[data-testid="rnw-control-scrollport"]');
        const homeList = document.querySelector('[data-testid="sessions-list"]');
        const state = window.__kcoderRnwControlInputState;
        const count = type => state.events.filter(event => event.type === type && event.trusted).length;
        const rect = element => {
          if (!(element instanceof Element)) return null;
          const value = element.getBoundingClientRect();
          return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
        };
        return {
          mode: modeValue,
          scrollport: list ? { scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight } : null,
          targetRect: rect(document.querySelector('[data-testid="rnw-control-clipped-text"]')),
          actualSessionsListAfterControl: homeList ? { scrollTop: homeList.scrollTop, scrollHeight: homeList.scrollHeight, clientHeight: homeList.clientHeight } : null,
          trustedCounts: Object.fromEntries(["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointermove", "pointerup", "pointercancel", "click"].map(type => [type, count(type)])),
          scrollEvents: state.scrollEvents,
          events: state.events,
          droppedEvents: state.droppedEvents,
          droppedScrollEvents: state.droppedScrollEvents,
          responderEvents: state.responderEvents,
          droppedResponderEvents: state.droppedResponderEvents,
          pressLifecycle: window.__kcoderRnwSessionsTouchControl?.state?.pressLifecycle ?? null,
          scrollViewResponderEvents: window.__kcoderRnwSessionsTouchControl?.state?.scrollViewResponderEvents ?? null,
          pressCount: window.__kcoderRnwSessionsTouchControl?.state?.pressCount ?? null,
          targetTestId: document.elementFromPoint(modeValue === "same-row-row-gap" ? 60 : clippedPoint.x, clippedPoint.y)?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        };
      }, { modeValue: mode, clippedPoint });
      await page.evaluate(() => {
        const state = window.__kcoderRnwControlInputState;
        state?.detachResponderObservers?.();
        if (state) delete state.detachResponderObservers;
      });
      const beforeList = before.actualSessionsListBeforeControl;
      const afterList = after.actualSessionsListAfterControl;
      const boxClose = (left, right, tolerance = 2) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
      const trusted = after.trustedCounts;
      if (mode === "non-pressable-same-action") {
        result.responderComparison = {
          classification: "test-only same-RNW-ScrollView diagnostic; row 3 is a View with touchAction: manipulation, not a Pressable",
          status: "observed",
          mode,
          start,
          end: touchEnd,
          before,
          controlCursor,
          after,
          checks: {
            sameOwnedPageAndMobileViewport: before.page.origin === expectedOrigin &&
              before.page.innerWidth === MOBILE_PAGE_OPTIONS.viewport.width && before.page.innerHeight === MOBILE_PAGE_OPTIONS.viewport.height &&
              before.page.devicePixelRatio === MOBILE_PAGE_OPTIONS.deviceScaleFactor && before.page.maxTouchPoints > 0,
            sameOverlayViewportAndActualScrollRange: boxClose(before.scrollport?.box?.left, 0) &&
              boxClose(before.scrollport?.box?.top, 470) && boxClose(before.scrollport?.box?.width, 390) &&
              boxClose(before.scrollport?.box?.height, 374) && before.scrollport?.scrollHeight === actualListBefore.scrollHeight &&
              before.scrollport?.clientHeight === actualListBefore.clientHeight && before.scrollport?.scrollHeight > before.scrollport?.clientHeight,
            sameClippedTargetHitInsideRow: before.targetHit?.withinTargetText === true &&
              before.targetHit?.withinScrollport === true && before.targetHit?.withinRowWrapper === true &&
              boxClose(before.target?.box?.left, clippedPoint.x - 126) && boxClose(before.target?.box?.top, clippedPoint.y - 6) &&
              boxClose(before.target?.box?.width, 252) && boxClose(before.target?.box?.height, 11),
            noPressableAncestorAndSameTouchAction: before.targetBelongsToPressable === false &&
              before.rowWrapper?.tag === "DIV" && before.rowWrapper?.tabIndex === -1 &&
              before.rowWrapper?.touchAction === "manipulation",
            trustedTouchCompleteInsideScrollport: trusted.touchstart === 1 && trusted.touchmove === 12 && trusted.touchend === 1 &&
              after.events.filter(event => /^touch(start|move|end)$/.test(event.type)).every(event => event.trusted && event.targetWithinControl) &&
              before.gestureBounds?.startInControlScrollport === true && before.gestureBounds?.endInControlScrollport === true,
            scrollportObserverComplete: after.droppedScrollEvents === 0 && after.droppedResponderEvents === 0,
          },
        };
      } else {
      const gates = {
        samePageOwnedGateway: before.page.origin === expectedOrigin && before.page.origin === result.pageIdentity.origin,
        fixedMobileViewport: before.page.innerWidth === MOBILE_PAGE_OPTIONS.viewport.width && before.page.innerHeight === MOBILE_PAGE_OPTIONS.viewport.height &&
          before.page.devicePixelRatio === MOBILE_PAGE_OPTIONS.deviceScaleFactor && before.page.maxTouchPoints > 0,
        actualSessionsListStillMounted: Boolean(beforeList && afterList),
        controlViewportMatchesActual: boxClose(before.scrollport?.box?.left, 0) && boxClose(before.scrollport?.box?.top, 470) &&
          boxClose(before.scrollport?.box?.width, 390) && boxClose(before.scrollport?.box?.height, 374),
        controlScrollRangeMatchesActual: before.scrollport?.scrollHeight === actualListBefore.scrollHeight &&
          before.scrollport?.clientHeight === actualListBefore.clientHeight && before.scrollport?.scrollHeight > before.scrollport?.clientHeight,
        pressableTargetMatchesActualClip: before.mode === "clipped-text"
          ? before.targetHit?.withinTargetText === true && boxClose(before.target?.box?.left, clippedPoint.x - 126) &&
            boxClose(before.target?.box?.top, clippedPoint.y - 6) && boxClose(before.target?.box?.width, 252) && boxClose(before.target?.box?.height, 11) &&
            before.targetBelongsToPressable === true
          : before.targetHit?.isTarget === false && before.targetHit?.withinScrollport === true &&
            before.targetHit?.withinRowPressable === true && before.targetBelongsToPressable === true && before.pressable?.testId === "rnw-control-row-3",
        genuineRnwPressable: before.pressable?.tag === "DIV" && before.pressable?.tabIndex === 0 && before.pressable?.touchAction === "manipulation",
        trustedGestureStartAndEndInsideControl: before.gestureBounds?.startInViewport === true && before.gestureBounds?.endInViewport === true &&
          before.gestureBounds?.startInControlScrollport === true && before.gestureBounds?.endInControlScrollport === true &&
          before.targetHit?.withinScrollport === true && before.endHit?.withinScrollport === true &&
          before.targetHit?.withinRowPressable === true && before.gestureBounds?.startToEndDeltaY < 0 &&
          after.scrollport?.scrollTop > controlCursor.startScrollTop,
        verticalTouchActionPathAllowsScroll: before.touchActionAncestorPath?.length >= 3 &&
          before.touchActionAncestorPath.every(node => ["auto", "manipulation"].includes(node.touchAction) ||
            (typeof node.touchAction === "string" && node.touchAction.split(/\s+/).includes("pan-y"))),
        intendedControlIsNearestVerticalScroller: before.scrollableAncestorPath?.[0]?.testId === "rnw-control-scrollport",
        gestureEndStillTargetsSameScrollport: before.endScrollableAncestorPath?.[0]?.testId === "rnw-control-scrollport",
        touchIsTrustedAndInControl: trusted.touchstart === 1 && trusted.touchmove === 12 && trusted.touchend === 1 &&
          after.events.filter(event => /^touch(start|move|end)$/.test(event.type)).every(event => event.trusted && event.targetWithinControl),
        controlScrollObserved: after.scrollport?.scrollTop > controlCursor.startScrollTop && after.scrollEvents.some(event => event.trusted),
        homeListUnaffectedByOverlay: beforeList?.scrollTop === afterList?.scrollTop &&
          beforeList?.scrollHeight === afterList?.scrollHeight && beforeList?.clientHeight === afterList?.clientHeight,
        noPressActivation: after.pressCount === 0,
        collectorsNotTruncated: after.droppedEvents === 0 && after.droppedScrollEvents === 0,
      };
      result.cases.push({ mode, start, end: touchEnd, before, after, gates, controlCursor });
      }
      try {
        await page.evaluate(() => window.__kcoderRnwSessionsTouchControl?.unmount());
        await page.waitForTimeout(32);
      } catch (error) {
        result.cleanupErrors.push(safeErrorName(error));
      }
    }
    const actualListAfterUnmount = await page.locator('[data-testid="sessions-list"]').evaluate(element => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    result.actualSessionsListAfterUnmount = actualListAfterUnmount;
    result.gates = {
      originMatches: result.pageIdentity.originMatchesOwnedGateway,
      bothControlCasesObserved: result.cases.length === 2,
      eachCasePasses: result.cases.every(item => Object.values(item.gates).every(Boolean)),
      responderComparisonObserved: result.responderComparison.status === "observed",
      cleanupPassed: result.cleanupErrors.length === 0,
      actualListUnaffected: actualListAfterUnmount.scrollTop === actualListBefore.scrollTop,
      overlayDetachedAfterCleanup: await page.locator('#kcoder-rnw-sessions-touch-control-host').count() === 0,
    };
    result.gates.all = Object.entries(result.gates).filter(([key]) => key !== "responderComparisonObserved").every(([, value]) => Boolean(value));
    result.responderComparison.includedInOriginalControlPassGate = false;
    result.status = result.gates.all ? "observed" : "gate-failed";
  } catch (error) {
    result.status = "error";
    result.errorName = safeErrorName(error);
  } finally {
    if (fixtureRouteHandler && fixtureScriptUrl) {
      try {
        await page.unroute(fixtureScriptUrl, fixtureRouteHandler);
        result.fixtureScriptRoute.unrouteCompleted = true;
      } catch (error) {
        result.cleanupErrors.push(`unroute-rnw-fixture:${safeErrorName(error)}`);
        if (result.status === "observed") result.status = "cleanup-failed";
      }
    }
    try {
      await page.evaluate(() => window.__kcoderRnwSessionsTouchControl?.unmount());
    } catch (error) {
      result.cleanupErrors.push(safeErrorName(error));
      if (result.status === "observed") result.status = "cleanup-failed";
    }
    await context.writeArtifactJson("same-page-rnw-sessions-touch-control.json", result);
  }
  return result;
}

  return {
    proveOwnedTouchScrollControl,
    proveOwnedNestedTouchScrollControl,
    buildSamePageRnwTouchControl,
    measureSamePageRnwTouchControl,
  };
}
