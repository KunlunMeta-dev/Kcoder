// Private, model-independent Browser causal diagnostic for the 2026-10-09 default-catalog
// export. It reuses the existing local two-Gateway profile
// flow and retained-export copier. It starts no Rust app-server, Provider,
// Relay, SSH, or public service, and it never starts a turn.
//
// Exact manual command (integration checkout cwd):
// KCODER_E2E_CHROMIUM_NO_SANDBOX=1 KCODER_E2E_PRIVATE_HOME_SESSIONS_AFTER339_CAUSALITY=1 \
//   /home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node \
//   apps/kcoder-studio/e2e/private/mobile-home-sessions-after339-touch-causality.candidate.mjs
//
// This file is a private review candidate, not a registered run-all suite.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, lstat, realpath, readlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { reuseMobileWebExport } from "../harness/mobile-web-export-reuse.mjs";
import { validatePinnedGatewayRuntime } from "../harness/pinned-gateway.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { resolveExistingPrivateGatewaySnapshot } from "../suites/mobile/helpers/gateway-runtime-snapshot-guard.mjs";
import { parseObservedJsonRpcFrame } from "./mobile-public-new-catalog-dom-probe.candidate.mjs";

const PRIVATE_RUN_FLAG = "KCODER_E2E_PRIVATE_HOME_SESSIONS_AFTER339_CAUSALITY";
const RNW_CONTROL_ONLY_FLAG = "KCODER_E2E_PRIVATE_HOME_SESSIONS_RNW_TOUCH_CONTROL_ONLY";
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const SOURCE_TREE_SHA256 = "649a35cd63b42a43bb2cba9e74fdc2ba9e1586090f56507a0f4dd3cc4ad6667f";
const SOURCE_FILE_COUNT = 339;
const SOURCE_FREEZE_RELATIVE_ROOT = "target/private-phone-latency-implementation/current-mobile-default-catalog-parallel-20261009-090018";
const SOURCE_METADATA_SHA256 = "eea7e49fa96cb37ba1f2e656855fc080c9ef15c41f312652c92007c2293f7713";
const SOURCE_MAP_SHA256 = "d3f7b230cd925035f3905fb67c8050964fc38bc6b5cf50965da5a52776e19ef8";
const SOURCE_MANIFEST_SHA256 = "2973c553c2d40f010f7c73cb1656079cbc11634ed67e8d983a1116ce15b10c42";
const EXPORT_MANIFEST_SHA256 = "af1066420b8fc817d7aeb7b713658ea8a4cfea284ad49092ff7549f41a2c7518";
const EXPORT_PROVENANCE_SHA256 = "1d0e708adc8c0aa08f82ee9c54022c7d7d8435fee0b83c3e8ad2544940032d7e";
const BUNDLE_SHA256 = "1d00952cd276c22b1c37371e39e8719adcdee46ca724246d768d287e2479d9c7";
const BUNDLE_FILE_COUNT = 37;
const EXPORT_RELATIVE_ROOT = "target/private-phone-ux-implementation/mobile-web-export-default-catalog-parallel-20261009-090018";
const EXPORT_RELATIVE_MANIFEST = `${EXPORT_RELATIVE_ROOT}-manifest.json`;
const EXPORT_RELATIVE_PROVENANCE = `${EXPORT_RELATIVE_ROOT}-provenance.json`;
const SOURCE_RELATIVE_MAP = `${SOURCE_FREEZE_RELATIVE_ROOT}/sha256.json`;
const SOURCE_RELATIVE_MANIFEST = `${SOURCE_FREEZE_RELATIVE_ROOT}/source-manifest.json`;
const SOURCE_RELATIVE_METADATA = `${SOURCE_FREEZE_RELATIVE_ROOT}/metadata.json`;
const SOURCE_RELATIVE_CONTENT_ROOT = `${SOURCE_FREEZE_RELATIVE_ROOT}/source`;
const GATEWAY_SOURCE_FILE_COUNT = 67;
const GATEWAY_SOURCE_TREE_SHA256 = "02f803a6da08b5e6ee0915ed35da295b2cfd84548ff8c09d3ba67016233f0e24";
const GATEWAY_DEPENDENCY_FILE_COUNT = 1034;
const GATEWAY_DEPENDENCY_TREE_SHA256 = "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954";
const GATEWAY_DEPENDENCY_SYMLINK_COUNT = 17;
const GATEWAY_DEPENDENCY_SOURCE_RELATIVE_ROOT = "target/private-phone-ux-implementation/render-profile-gateway-runtime-3151f17f-20261008/node_modules";
const GATEWAY_RUNTIME_RELATIVE_ROOT = "target/private-phone-ux-implementation/render-profile-gateway-runtime-c22-20261009";
const GATEWAY_RUNTIME_MANIFEST_SHA256 = "474ea99288424030dddcba6a63f47689e8dd7f24c18ca5a9e21bb78c6262c39b";
const GATEWAY_BINARY_RELATIVE_PATH = "target/private-phone-ux-validation/b2-static03-build-20261008/frozen-candidate/kcoder";
const GATEWAY_BINARY_SHA256 = "289618f7e0670be9840b48adcd93d73261ea1c20034596ae6a95d5ed41f3b67d";
const GATEWAY_SOURCE_BEFORE_MANIFEST_PATH = "target/private-phone-ux-validation/nested-touch-diagnostics-20261009/gateway-c22-before-manifest.json";
const GATEWAY_SOURCE_BEFORE_MANIFEST_SHA256 = "1c585a47a3ec74968ee9d94252719fd38b54ec6eb55ceb3157060eed8b2f638d";
const GATEWAY_SOURCE_MANIFEST_PATH = "target/private-phone-ux-validation/nested-touch-diagnostics-20261009/gateway-c22-current-manifest.json";
const GATEWAY_SOURCE_MANIFEST_SHA256 = "523a784fccc11937afadcb25e23a57be507f5d0761704cce1816ac2af9e96ffe";
const GATEWAY_SOURCE_DELTA_PATH = "target/private-phone-ux-validation/nested-touch-diagnostics-20261009/gateway-c22-delta.json";
const GATEWAY_SOURCE_DELTA_SHA256 = "8c8150572b51653f3f253a88569c985f856e4ea90eb116b4a2a588870da6f74e";
const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const MAX_RPC_EVENTS = 512;
const MAX_PENDING_RPCS = 128;
const MAX_TOTAL_PENDING_RPCS = 256;
const MAX_WEBSOCKET_ROUTES = 32;
const MAX_HTTP_EVENTS = 128;
const MAX_HISTORY_READS = 64;
const MAX_SESSIONS_SCROLL_STEPS = 8;
const MAX_TOUCH_DIAGNOSTIC_EVENTS = 512;
const MAX_POINTER_DIAGNOSTIC_EVENTS = 512;
const MAX_SCROLL_DIAGNOSTIC_EVENTS = 256;
const TOUCH_DIAGNOSTICS_PROPERTY = "__kcoderLease3TouchScrollDiagnostics";
const TOUCH_SCROLL_CONTROL_PATH = "/__e2e_plain_touch_control__";
const NESTED_TOUCH_SCROLL_CONTROL_PATH = "/__e2e_nested_touch_control__";
const NESTED_TOUCH_CONTROL_SOURCE = Object.freeze({
  artifact: "target/test/apps/kcoder-studio/e2e/private/mobile-home-sessions-lease3-local-dom.candidate.mjs/20261009-081743.354Z/artifacts/mobile-home-sessions-lease3-local-dom-failure.json",
  artifactSha256: "a9eabf5ffbf04f357b3bb62d620c4d4b312945ba0abe7837f9a0d7c9235cb7f6",
  sourceFiles: Object.freeze([
    Object.freeze({ path: "apps/kcoder-studio/mobile/src/app/sessions.tsx", sha256: "ddc92d676975d52c93c682130bdcb6b3fb7ccc3c135f0f2de4e52752dbdfa159" }),
    Object.freeze({ path: "apps/kcoder-studio/mobile/src/theme.ts", sha256: "0dd4481b725674a897285490c15126d5f261f366666b82eb2b7d04efe77b2e15" }),
  ]),
  interpretation: "historical 336-source geometry-matched control from the observed DOM/CSS chain, not paired performance evidence for this 339 export or a full visual/behavioral clone of React Native Web",
  targetBoxLimit: "the original failure artifact recorded the inner target's 11px scroll/client height and CSS overflow/touch path, but not its bounding rectangle; the control places that 11px target under the fixed actual start point and the updated actual-page probe now records the real rectangle",
  viewport: Object.freeze({ width: 390, height: 844 }),
  gesture: Object.freeze({ start: Object.freeze({ x: 195, y: 777 }), end: Object.freeze({ x: 195, y: 537 }), moves: 12 }),
  controlTargetBox: Object.freeze({ x: 66, y: 770, width: 252, height: 11, derivation: "row 3 at 246px + centered 51px copy in 81px row + 39px title/meta/cwd stack, inside the actual y777 start coordinate" }),
  scrollport: Object.freeze({ x: 0, y: 470, width: 390, height: 374, scrollHeight: 1336, clientHeight: 374, overflowX: "hidden", overflowY: "auto", touchAction: "auto", pointerEvents: "auto" }),
  nonScrollableAutoAncestor: Object.freeze({ x: 0, y: 470, width: 390, height: 374, scrollHeight: 374, clientHeight: 374, overflowX: "hidden", overflowY: "auto", touchAction: "auto", pointerEvents: "auto" }),
  hitPath: Object.freeze([
    Object.freeze({ name: "inner-text-clip-11", height: 11, overflowX: "hidden", overflowY: "hidden", touchAction: "auto", pointerEvents: "auto" }),
    Object.freeze({ name: "row-copy", height: 51, overflowX: "visible", overflowY: "visible", touchAction: "auto", pointerEvents: "auto" }),
    Object.freeze({ name: "pressable-row", height: 81, overflowX: "visible", overflowY: "visible", touchAction: "manipulation", pointerEvents: "auto" }),
    Object.freeze({ name: "virtual-row", height: 82, overflowX: "visible", overflowY: "visible", touchAction: "auto", pointerEvents: "auto" }),
    Object.freeze({ name: "list-content", height: 1336, overflowX: "visible", overflowY: "visible", touchAction: "auto", pointerEvents: "auto" }),
  ]),
  rowSizing: Object.freeze({ contentPaddingHorizontal: 16, iconWidth: 38, rowActionWidth: 44, interItemGap: 12, rowWidth: 358, copyWidth: 252, derivation: "390px viewport/list minus 16px content padding on each side, 38px icon, 44px row action, and two 12px row gaps from sessions.tsx/theme.ts" }),
});
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
const MOBILE_PAGE_OPTIONS = Object.freeze({
  viewport: Object.freeze({ width: 390, height: 844 }),
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: "zh-CN",
});
const SERVER_ALIASES = Object.freeze({
  "fast-A": "A-fast",
  "slow-A": "A-slow",
  "fast-B": "B-fast",
});
const THREAD_FIXTURES = Object.freeze({
  homeFirst: Object.freeze({ id: "A_HOME_FIRST", title: "A Home first" }),
  homeSlowPeerFirst: Object.freeze({ id: "A_HOME_SLOW_PEER_FIRST", title: "A Home slow peer" }),
  homeMore: Object.freeze({ id: "A_HOME_MORE", title: "A Home later" }),
  sessionsFastFirst: Object.freeze({ id: "A_SESSIONS_FAST_0", title: "A Sessions first" }),
  sessionsSlowFirst: Object.freeze({ id: "A_SESSIONS_SLOW_0", title: "A Sessions slow first" }),
  sessionsFastMore: Object.freeze({ id: "A_SESSIONS_FAST_MORE", title: "A Sessions fast more" }),
  sessionsSlowMore: Object.freeze({ id: "A_SESSIONS_SLOW_MORE", title: "A Sessions slow more" }),
  profileBBootstrap: Object.freeze({ id: "B_BOOTSTRAP_FIRST", title: "B bootstrap" }),
  profileBAfterSwitch: Object.freeze({ id: "B_AFTER_SWITCH_FIRST", title: "B after switch" }),
});
const HOME_RETURN_PHASE = "home-a-after-task-return";
const FIXTURE_ERROR_MESSAGES = Object.freeze({
  homeReturnSlowThreadList: "A_SLOW_THREAD_LIST_ERROR",
  profileASlowWorkspaceDiscovery: "A_SLOW_DISCOVERY_ERROR",
});
const THREAD_FIXTURE_ROUTES = new Map([
  [THREAD_FIXTURES.homeFirst.id, "A/fast-A"],
  [THREAD_FIXTURES.homeSlowPeerFirst.id, "A/slow-A"],
  [THREAD_FIXTURES.homeMore.id, "A/fast-A"],
  [THREAD_FIXTURES.sessionsFastFirst.id, "A/fast-A"],
  [THREAD_FIXTURES.sessionsFastMore.id, "A/fast-A"],
  [THREAD_FIXTURES.sessionsSlowFirst.id, "A/slow-A"],
  [THREAD_FIXTURES.sessionsSlowMore.id, "A/slow-A"],
  [THREAD_FIXTURES.profileBBootstrap.id, "B/fast-B"],
  [THREAD_FIXTURES.profileBAfterSwitch.id, "B/fast-B"],
]);
for (let index = 1; index < 8; index += 1) {
  THREAD_FIXTURE_ROUTES.set(`A_SESSIONS_FAST_${index}`, "A/fast-A");
  THREAD_FIXTURE_ROUTES.set(`A_SESSIONS_SLOW_${index}`, "A/slow-A");
}
const FIXTURE_THREAD_IDS = new Set(THREAD_FIXTURE_ROUTES.keys());
const ALLOWED_CLIENT_RPC_METHODS = new Set([
  "initialize", "runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list",
  "thread/list", "thread/read", "thread/resume", "thread/goal/get",
]);
const ALLOWED_CLIENT_NOTIFICATIONS = new Set(["initialized"]);
const ALLOWED_SERVER_NOTIFICATIONS = new Set(["thread/goal/updated"]);

const FROZEN_MOBILE_SOURCE_PINS = Object.freeze({
  "apps/kcoder-studio/mobile/src/app/h/[profileId]/index.tsx": "dc057f0ddeead084264114b4d87b8e0f868f4acea333b13442b6be8f5fa6a4e5",
  "apps/kcoder-studio/mobile/src/app/sessions.tsx": "c7f799f334007b5cd8fe9d21d8abeb5592e8cdd805bc644497717e1b1892f93e",
  "apps/kcoder-studio/mobile/src/app/new.tsx": "c0d91a4b99aa462006c75146666afce21a663b646c0f9b3b59df7409cfe908ba",
  "apps/kcoder-studio/mobile/src/app/open-project.tsx": "c68bdf7d8adeda9b5e3fd3de2f6ae44bd2f007c0d4570e5fbe7de0e5c41af4fd",
  "apps/kcoder-studio/mobile/src/app/__tests__/thread-list-incremental-routes.review.test.tsx": "e1cb28b8b346ef298c9323c499b3f0ac5eb03c64b21889bccd39f42f158877ad",
  "apps/kcoder-studio/mobile/src/app/__tests__/new-catalog-read-publication.review.test.tsx": "d27ffd65ba74a8a39e842cac03ce9529a0480242ef8b9660c3c16e9c6b6b60c9",
  "apps/kcoder-studio/mobile/src/app/__tests__/new-workspace-handoff-discovery.review.test.tsx": "60390feeb2e95704628b42f6f3edda33a81cc4e29c03c3c3a9dfa0541604e947",
});

const LIVE_SOURCE_PINS = Object.freeze({
  "apps/kcoder-studio/src/mock-thread-store.js": "5ef2726f8565f8c0152dd4f95b15b32116adcd18941c7e3fca2a2bc6adf44941",
  "apps/kcoder-studio/e2e/harness/gateway.mjs": "7cef55697a767cb78c88dd9c4c72203e9db129e16d8502341e5496d3a325a2c9",
  "apps/kcoder-studio/e2e/harness/chromium.mjs": "6da43f71496317e00098780ab7e8c3bf0874e4b925c6add4e4c0e87bdf7b504c",
  "apps/kcoder-studio/e2e/harness/mobile-web-export-reuse.mjs": "d3e84b074e485dd2bf171d690d18e130920689b67711ad3f56a3bd791eb363f3",
  "apps/kcoder-studio/e2e/harness/run-context.mjs": "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11",
  "apps/kcoder-studio/e2e/private/mobile-public-new-catalog-dom-probe.candidate.mjs": "301658bf571cdd1b949ed30b8178d98e36c30299491ce8672eae563df456eed8",
  "apps/kcoder-studio/e2e/suites/mobile/mobile-qa-profile-background-reauth-isolation.e2e.mjs": "8f4676d5c7b6e90b061a4a4b4979c90a4fac77a578ecd8dabdc696efc1cea53f",
});

if (process.env[PRIVATE_RUN_FLAG] !== "1")
  throw new Error(`${PRIVATE_RUN_FLAG}=1 is required for this private candidate`);
if (process.env[RNW_CONTROL_ONLY_FLAG] !== "1")
  throw new Error(`${RNW_CONTROL_ONLY_FLAG}=1 is required; this candidate runs only the same-page RNW touch-control diagnostic`);
if (process.execPath !== EXPECTED_NODE || process.version !== "v22.17.0")
  throw new Error("This candidate requires the pinned Node 22.17.0 executable");
if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== "1")
  throw new Error("This isolated VM requires explicit KCODER_E2E_CHROMIUM_NO_SANDBOX=1");

await runE2E(import.meta.url, {
  testId: "mobile-home-sessions-after339-same-page-rnw-touch-control-n1",
  tier: "manual-live",
  modelPolicy: "model-independent local Mobile Web DOM, route, mock-Gateway and profile-owner isolation; KCODER_STUDIO_MOCK=1; no Rust app-server, Provider, or turn",
  retainSuccessLogs: true,
}, async context => {
  const sourceFreeze = await verifyFrozenSourceInputs();
  const sourcePins = await verifySourcePins(sourceFreeze.sourceMap);
  const gatewaySourceBefore = await verifyFrozenGatewayRuntimeSnapshot();
  const liveGatewayObservationBefore = await observeLiveGatewayCheckout();
  assert.equal(gatewaySourceBefore.fileCount, GATEWAY_SOURCE_FILE_COUNT, "complete Gateway source closure file count changed");
  assert.equal(gatewaySourceBefore.sourceTreeSha256, GATEWAY_SOURCE_TREE_SHA256, "complete Gateway source closure changed");
  assert.equal(gatewaySourceBefore.dependencyFileCount, GATEWAY_DEPENDENCY_FILE_COUNT, "complete Gateway dependency closure file count changed");
  assert.equal(gatewaySourceBefore.dependencyTreeSha256, GATEWAY_DEPENDENCY_TREE_SHA256, "complete Gateway dependency closure changed");
  const gatewaySourceFreeze = await verifyGatewaySourceFreeze(gatewaySourceBefore.files);
  await context.writeArtifactJson("gateway-c22-before-source-manifest.json", gatewaySourceFreeze.beforeManifest);
  await context.writeArtifactJson("gateway-c22-current-source-manifest.json", gatewaySourceFreeze.currentManifest);
  await context.writeArtifactJson("gateway-c22-source-delta.json", gatewaySourceFreeze.delta);
  await context.writeArtifactJson("gateway-c22-execution-inputs.json", {
    schemaVersion: 1,
    executionRoot: relative(repoRoot, gatewaySourceBefore.snapshotRoot),
    freezeManifestSha256: gatewaySourceBefore.manifestSha256,
    source: { fileCount: gatewaySourceBefore.fileCount, treeSha256: gatewaySourceBefore.sourceTreeSha256 },
    dependencies: { fileCount: gatewaySourceBefore.dependencyFileCount, treeSha256: gatewaySourceBefore.dependencyTreeSha256, declaredSymlinkCount: gatewaySourceBefore.symlinkCount },
    runtime: { nodeVersion: gatewaySourceBefore.nodeVersion, nodeExecutable: gatewaySourceBefore.nodeExecutable, binaryPath: relative(repoRoot, gatewaySourceBefore.binaryPath), binarySha256: gatewaySourceBefore.binarySha256 },
    nonExecutionLiveCheckoutObservation: { ...liveGatewayObservationBefore, executed: false },
  });
  const exportRoot = resolve(repoRoot, EXPORT_RELATIVE_ROOT);
  const exportManifest = resolve(repoRoot, EXPORT_RELATIVE_MANIFEST);
  const exportProvenance = resolve(repoRoot, EXPORT_RELATIVE_PROVENANCE);
  assert.ok(isAbsolute(exportRoot) && isAbsolute(exportManifest) && isAbsolute(exportProvenance));
  const exportProvenanceSha256 = await verifyPinnedRegularFile(exportProvenance, EXPORT_PROVENANCE_SHA256);
  const derivedExport = await deriveSchema1ReuseInput(context, exportRoot, exportManifest, exportProvenance);
  const mobileWeb = await reuseMobileWebExport(context, {
    bundleRoot: derivedExport.bundleRoot,
    manifestPath: derivedExport.manifestPath,
    expectedSourceTreeSha256: SOURCE_TREE_SHA256,
    expectedManifestSha256: derivedExport.manifestSha256,
    expectedBundleSha256: BUNDLE_SHA256,
    expectedBundleFileCount: BUNDLE_FILE_COUNT,
    label: "home-sessions-lease3-local",
    outputName: "home-sessions-lease3-web",
  });
  assert.equal(mobileWeb.sourceTreeSha256, SOURCE_TREE_SHA256);
  assert.equal(mobileWeb.sourceManifestSha256, derivedExport.manifestSha256);
  assert.equal(mobileWeb.bundleSha256, BUNDLE_SHA256);
  assert.equal(mobileWeb.bundleFileCount, BUNDLE_FILE_COUNT);
  const rnwTouchControlBuild = await buildSamePageRnwTouchControl(context);
  await context.writeArtifactJson("same-page-rnw-touch-control-build.json", rnwTouchControlBuild.evidence);

  await context.writeArtifactJson("execution-plan.json", {
    schemaVersion: 1,
    scope: "local-mock-browser-only",
    modelPolicy: "no Rust app-server, Provider, turn/start, or thread/start",
    node: { executable: process.execPath, version: process.version },
    sandbox: { KCODER_E2E_CHROMIUM_NO_SANDBOX: true },
    browserInput: { ...MOBILE_PAGE_OPTIONS, evidence: "Playwright mobile context with hasTouch; Sessions input uses bounded Chromium CDP touch events and requires trusted DOM touch/scroll evidence" },
    export: {
      sourceEntryCount: SOURCE_FILE_COUNT,
      sourceTreeSha256: SOURCE_TREE_SHA256,
      sourceFreezeManifestSha256: sourceFreeze.sourceManifestSha256,
      sourceFreezeMapSha256: sourceFreeze.sourceMapSha256,
      sourceFreezeMetadataSha256: sourceFreeze.sourceMetadataSha256,
      bundleRootRelativePath: EXPORT_RELATIVE_ROOT,
      bundleExportManifestSha256: EXPORT_MANIFEST_SHA256,
      derivedReuseManifestSha256: derivedExport.manifestSha256,
      exportProvenanceSha256,
      bundleSha256: BUNDLE_SHA256,
      bundleFileCount: BUNDLE_FILE_COUNT,
      exportPerformedByThisCandidate: false,
    },
    sourcePins,
    gatewaySource: {
      boundary: "the immutable approved C22 private runtime snapshot; current live checkout dev-server is observed but not executed",
      executionRootRelativePath: relative(repoRoot, gatewaySourceBefore.snapshotRoot),
      freezeManifestSha256: gatewaySourceBefore.manifestSha256,
      fileCount: gatewaySourceBefore.fileCount,
      sourceTreeSha256: gatewaySourceBefore.sourceTreeSha256,
      dependencyFileCount: gatewaySourceBefore.dependencyFileCount,
      dependencyTreeSha256: gatewaySourceBefore.dependencyTreeSha256,
      declaredDependencySymlinkCount: gatewaySourceBefore.symlinkCount,
      binarySha256: gatewaySourceBefore.binarySha256,
      nodeVersion: gatewaySourceBefore.nodeVersion,
      nodeExecutable: gatewaySourceBefore.nodeExecutable,
      priorApprovedSourceTreeSha256: gatewaySourceFreeze.beforeManifest.priorCandidateSourceTreeSha256,
      beforeManifestSha256: gatewaySourceFreeze.beforeManifestSha256,
      currentManifestSha256: gatewaySourceFreeze.currentManifestSha256,
      deltaSha256: gatewaySourceFreeze.deltaSha256,
      changedPaths: gatewaySourceFreeze.delta.changes.map(change => change.path),
      nonExecutionLiveCheckoutObservation: { ...liveGatewayObservationBefore, executed: false },
    },
    gateways: [
      { alias: "A", mock: true, runtimeRoot: relative(repoRoot, gatewaySourceBefore.snapshotRoot), runtimeEntry: "dev-server.mjs", binarySha256: gatewaySourceBefore.binarySha256, targets: ["A-fast", "A-slow"], servesPinnedStaticBundle: true },
      { alias: "B", mock: true, runtimeRoot: relative(repoRoot, gatewaySourceBefore.snapshotRoot), runtimeEntry: "dev-server.mjs", binarySha256: gatewaySourceBefore.binarySha256, targets: ["B-fast"], mobileWebOriginAllowlistAlias: "A" },
    ],
    allowedClientRpcMethods: [...ALLOWED_CLIENT_RPC_METHODS].sort(),
    allowedClientNotifications: [...ALLOWED_CLIENT_NOTIFICATIONS].sort(),
    unknownClientRpcPolicy: "record-and-reject; never forward outside the explicit read-only allowlist",
    foreignOriginPolicy: "all HTTP(S) requests outside the two owned Gateway origins, with non-owned Origin headers, or with URL credentials are aborted; all WebSockets outside exact owned /rpc+server+workspace routes are closed before upstream connect",
    observerBounds: { rpcEvents: MAX_RPC_EVENTS, httpApiResponses: MAX_HTTP_EVENTS, historyReads: MAX_HISTORY_READS, rejectedClientMethods: 32, sockets: MAX_WEBSOCKET_ROUTES, perSocketPendingRpc: MAX_PENDING_RPCS, totalPendingRpc: MAX_TOTAL_PENDING_RPCS, httpRequests: 512 },
    allowedPairingCleanup: ["POST /api/mobile/session", "DELETE /api/mobile/session"],
  });

  const workspaceAfast = context.pathInState("workspace-a-fast");
  const workspaceAslow = context.pathInState("workspace-a-slow");
  const workspaceBfast = context.pathInState("workspace-b-fast");
  const workspaceByTarget = Object.freeze({
    "A/fast-A": workspaceAfast,
    "A/slow-A": workspaceAslow,
    "B/fast-B": workspaceBfast,
  });
  await Promise.all([
    mkdir(workspaceAfast, { recursive: true, mode: 0o700 }),
    mkdir(workspaceAslow, { recursive: true, mode: 0o700 }),
    mkdir(workspaceBfast, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all(Object.values(workspaceByTarget).map(path => assertOwnedWorkspace(context, path)));
  const serversAPath = await context.writeStateJson("servers-a.json", [
    mockServer("fast-A", "Fast A", workspaceAfast),
    mockServer("slow-A", "Slow A", workspaceAslow),
  ]);
  const serversBPath = await context.writeStateJson("servers-b.json", [
    mockServer("fast-B", "Fast B", workspaceBfast),
  ]);
  const gatewayA = await startGateway(context, {
    label: "home-sessions-gateway-a",
    gatewayRoot: gatewaySourceBefore.snapshotRoot,
    cwd: gatewaySourceBefore.snapshotRoot,
    kcoderBin: gatewaySourceBefore.binaryPath,
    auth: true,
    workspace: workspaceAfast,
    serversFile: serversAPath,
    env: { KCODER_STUDIO_MOCK: "1", KCODER_STUDIO_WEB_ROOT: mobileWeb.path },
  });
  const gatewayB = await startGateway(context, {
    label: "home-sessions-gateway-b",
    gatewayRoot: gatewaySourceBefore.snapshotRoot,
    cwd: gatewaySourceBefore.snapshotRoot,
    kcoderBin: gatewaySourceBefore.binaryPath,
    auth: true,
    workspace: workspaceBfast,
    serversFile: serversBPath,
    env: {
      KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: gatewayA.baseUrl,
    },
  });
  for (const gateway of [gatewayA, gatewayB]) {
    assert.equal(gateway.gatewayRoot, gatewaySourceBefore.snapshotRoot, "Gateway process did not use the pinned C22 execution root");
    assert.equal(gateway.cwd, gatewaySourceBefore.snapshotRoot, "Gateway process working directory is not the pinned C22 root");
    assert.equal(gateway.scriptPath, resolve(gatewaySourceBefore.snapshotRoot, "dev-server.mjs"), "Gateway script path is not the pinned C22 entrypoint");
  }
  assert.notEqual(gatewayA.port, gatewayB.port, "A and B must be separate owned Gateways");

  const phases = {
    current: "home-a-fast-first-peer-and-cursor-held",
    gates: {
      homeSlowDiscovery: deferredGate("home-slow-discovery"),
      homeFastCursor: deferredGate("home-fast-cursor"),
      sessionsSlowCursor: deferredGate("sessions-slow-cursor"),
      profileBFirstPage: deferredGate("profile-b-first-page"),
    },
  };
  const ledger = {
    events: [],
    droppedEvents: 0,
    droppedHttpEvents: 0,
    droppedHistoryReadCount: 0,
    malformedFrameCount: 0,
    unknownRpcResponseCount: 0,
    rejectedClientRpcCount: 0,
    rejectedServerFrameCount: 0,
    rejectedWebSocketCount: 0,
    foreignWebSocketBlockedCount: 0,
    foreignHttpBlockedCount: 0,
    foreignHttpResponseCount: 0,
    httpRouteCount: 0,
    httpRouteOverflowCount: 0,
    webSocketRouteOverflowCount: 0,
    webSocketRouteCount: 0,
    pendingRpcCount: 0,
    fixtureErrorCount: 0,
    rejectedClientMethods: [],
    http: [],
    gates: phases.gates,
    held: { homeSlowDiscovery: false, homeFastCursor: false, sessionsSlowCursor: false, profileBFirstPage: false },
    sessionsScroll: null,
    historyReadThreadIds: [],
  };
  let homeClickHoldState = null;
  let homeReturnErrorRequestIdFingerprint = null;
  let fullCursorFlowOutcome = {
    status: "NOT_RUN",
    reason: "The original strict touch-target diagnostics run before the full Sessions pagination/cursor flow.",
  };
  const record = event => {
    if (ledger.events.length >= MAX_RPC_EVENTS) { ledger.droppedEvents += 1; return; }
    const phase = typeof event.phase === "string" ? event.phase : phases.current;
    const { phase: _capturedPhase, ...fields } = event;
    ledger.events.push({ atNodeMs: performance.now(), phase, ...fields });
  };
  const roleForOrigin = value => {
    let origin;
    try { origin = httpOrigin(value); } catch { return null; }
    if (origin === gatewayA.baseUrl) return "A";
    if (origin === gatewayB.baseUrl) return "B";
    return null;
  };

  const chromium = await startChromium(context, { label: "home-sessions-lease3-chromium", noSandbox: true });
  const page = await chromium.newPage(MOBILE_PAGE_OPTIONS);
  assert.deepEqual(page.viewportSize(), MOBILE_PAGE_OPTIONS.viewport, "owned Mobile Chromium page must use the fixed viewport");
  const aboutBlankTouchCapabilities = await page.evaluate(() => ({
    maxTouchPoints: Number(navigator.maxTouchPoints) || 0,
    ontouchstart: "ontouchstart" in window,
  }));
  ledger.browserInput = {
    ...MOBILE_PAGE_OPTIONS,
    observations: [{ stage: "about-blank-before-navigation", ...aboutBlankTouchCapabilities }],
    touchCapabilityGate: "pending until the connected Mobile page is loaded; trusted CDP touch and scroll evidence remains mandatory",
  };
  await context.writeArtifactJson("mobile-home-sessions-lease3-touch-capabilities-about-blank.json", {
    schemaVersion: 1,
    stage: "about-blank-before-navigation",
    configuredMobileOptions: MOBILE_PAGE_OPTIONS,
    observed: aboutBlankTouchCapabilities,
    interpretation: "diagnostic only; no touch capability assertion is made on the initial about:blank document",
  });
  context.addCleanup("close home-sessions lease3 page", async () => {
    if (!page.isClosed()) await page.close();
  });

  const httpRequestPhases = new WeakMap();
  await page.route("**/*", async route => {
    try {
      ledger.httpRouteCount += 1;
      if (ledger.httpRouteCount > 512) {
        ledger.httpRouteOverflowCount += 1;
        await route.abort("blockedbyclient");
        return;
      }
      const request = route.request();
      const url = new URL(request.url());
      const role = ["http:", "https:"].includes(url.protocol) ? roleForOrigin(url.origin) : null;
      const requestOrigin = request.headers().origin;
      const originHeaderOwned = !requestOrigin || roleForOrigin(requestOrigin) !== null;
      if (!role || url.username || url.password || !originHeaderOwned) {
        ledger.foreignHttpBlockedCount += 1;
        record({ phase: phases.current, kind: "foreign-http-blocked", direction: "page-to-gateway", role: "foreign", reason: !originHeaderOwned ? "origin-not-owned" : "url-origin-not-owned", method: safeMethod(request.method()), path: safeObservedRequestPath(url.pathname) });
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    } catch {
      ledger.fixtureErrorCount += 1;
      await route.abort("blockedbyclient").catch(() => {});
    }
  });
  page.on("request", request => { httpRequestPhases.set(request, phases.current); });
  page.on("response", response => {
    try {
      const url = new URL(response.url());
      const role = roleForOrigin(url.origin);
      if (!role) {
        ledger.foreignHttpResponseCount += 1;
        record({ phase: httpRequestPhases.get(response.request()) ?? "unknown", kind: "foreign-http-response-observed", direction: "gateway-to-page", role: "foreign", method: safeMethod(response.request().method()), path: safeObservedRequestPath(url.pathname), status: response.status() });
        return;
      }
      if (!url.pathname.startsWith("/api/")) return;
      if (ledger.http.length >= MAX_HTTP_EVENTS) { ledger.droppedHttpEvents += 1; return; }
      ledger.http.push({
        phase: httpRequestPhases.get(response.request()) ?? "unknown",
        role,
        method: safeMethod(response.request().method()),
        path: safeApiPath(url.pathname),
        status: response.status(),
      });
    } catch { ledger.droppedEvents += 1; }
  });
  let pageErrorCount = 0;
  let consoleErrorCount = 0;
  page.on("pageerror", () => { pageErrorCount += 1; });
  page.on("console", message => { if (message.type() === "error") consoleErrorCount += 1; });

  await installRpcFixture(page, context, {
    gatewayA,
    gatewayB,
    roleForOrigin,
    phases,
    ledger,
    workspaceByTarget,
    record,
  });
  try {
    const touchTargetDiagnostics = {
      schemaVersion: 2,
      sourceBundleSha256: BUNDLE_SHA256,
      scope: "339-source local mock Browser causal diagnostic; no public Gateway, Provider, Rust app-server, or turn",
      historicalControlSource: NESTED_TOUCH_CONTROL_SOURCE.artifactSha256,
      frozenSessionsSourceReview: {
        path: "apps/kcoder-studio/mobile/src/app/sessions.tsx",
        sha256: "c7f799f334007b5cd8fe9d21d8abeb5592e8cdd805bc644497717e1b1892f93e",
        findings: [
          "FlatList uses onEndReached with threshold 0.35, initialNumToRender 12, maxToRenderPerBatch 12, and windowSize 9",
          "the frozen FlatList does not declare disableScrollViewPanResponder or a touchAction prop/style",
          "each row nests the title/meta/cwd Text views inside a Pressable row, with an adjacent icon and nested row-action Pressable",
          "the frozen TypeScript StyleSheet defines row/copy/icon/rowAction layout but does not set CSS overflow or touchAction directly",
        ],
        runtimeCssSource: "computed from the actual rendered DOM for each causal sample; React Native Web generated styles are not inferred from the TypeScript StyleSheet",
      },
      causalMethod: "collect the original clipped point, original row gap, left icon-copy gap, focus/window/target-ancestor state, and isolated one-property DOM override experiments before assertions; overrides are diagnostic-only and do not count as product behavior",
      cases: [],
      status: "collecting-raw-observations",
      fullSessionsCursorFlowAtCapture: "NOT_RUN; this raw diagnostic snapshot precedes its strict control assertions",
      touchSequencePolicy: "require trusted touchstart, touchmove, and touchend; record pointercancel/touchcancel separately without substituting them for touchend",
    };
    ledger.touchTargetDiagnostics = touchTargetDiagnostics;
    for (const [name, capture] of [
      ["plain-overflow-control", () => proveOwnedTouchScrollControl(context, chromium, gatewayA)],
      ["nested-clipped-vs-gap-control", () => proveOwnedNestedTouchScrollControl(context, chromium, gatewayA)],
    ]) {
      try {
        touchTargetDiagnostics.cases.push({ name, status: "observed", observation: await capture() });
      } catch (error) {
        touchTargetDiagnostics.cases.push({ name, status: "error", errorName: safeErrorName(error) });
      }
    }
    const controlOnly = process.env[RNW_CONTROL_ONLY_FLAG] === "1";
    const actualCaseSpecs = controlOnly
      ? [{ name: "actual-clipped-text-baseline", targetKind: "clipped-text", samePageRnwTouchControlBuild: rnwTouchControlBuild }]
      : [
        { name: "actual-clipped-text-baseline", targetKind: "clipped-text", samePageRnwTouchControlBuild: rnwTouchControlBuild },
        { name: "actual-original-row-gap-baseline", targetKind: "same-row-gap" },
        { name: "actual-left-icon-copy-gap-baseline", targetKind: "icon-copy-gap" },
        { name: "diagnostic-row-touch-action-auto", targetKind: "same-row-gap",
          styleOverride: { target: "row", property: "touch-action", value: "auto" } },
        { name: "diagnostic-clipped-target-overflow-visible", targetKind: "clipped-text",
          styleOverride: { target: "clip", property: "overflow-y", value: "visible" } },
      ];
    const actualCases = [];
    let referenceGeometry = null;
    for (const spec of actualCaseSpecs) {
      const caseRecord = await captureActualSessionsTouchTargetCase(
        context, chromium, gatewayA, gatewayB, workspaceByTarget, spec, referenceGeometry,
      );
      actualCases.push(caseRecord);
      touchTargetDiagnostics.cases.push(caseRecord);
      if (!referenceGeometry && caseRecord.geometry) referenceGeometry = caseRecord.geometry;
    }
    touchTargetDiagnostics.status = "raw-observations-collected-before-central-assertions";
    const plainControl = touchTargetDiagnostics.cases.find(item => item.name === "plain-overflow-control");
    const nestedControl = touchTargetDiagnostics.cases.find(item => item.name === "nested-clipped-vs-gap-control");
    const actualClippedTextCase = actualCases.find(item => item.targetMode === "clipped-text" && !item.diagnosticOnly);
    ledger.browserInput.touchScrollControl = plainControl?.observation ?? null;
    ledger.browserInput.nestedTouchScrollControl = nestedControl?.observation ?? null;
    ledger.browserInput.samePageRnwTouchControl = actualClippedTextCase?.samePageRnwTouchControl ?? null;
      if (!controlOnly) {
        assert.equal(plainControl?.status, "observed", "plain overflow control must produce raw evidence");
        assert.equal(plainControl?.observation?.passed, true, "plain overflow trusted-touch control must continue to pass");
        assert.equal(nestedControl?.status, "observed", "nested clipped/gap control must produce raw evidence");
      }
    touchTargetDiagnostics.historicalNestedControlDisposition = {
      status: "diagnostic-only-fixture-mismatch",
      reason: "the historical nested control is a generic DIV, not the RNW Pressable used by the real Sessions rows; its trusted gesture remains retained but is not a gating control result",
    };
    touchTargetDiagnostics.plainOverflowControlDisposition = {
      status: "diagnostic-only",
      reason: "retained as a native overflow behavior observation; it does not substitute for the genuine RNW same-page control",
    };
    await context.writeArtifactJson("mobile-home-sessions-after339-touch-target-diagnostics.json", touchTargetDiagnostics);
    const actualOriginalGapCase = actualCases.find(item => item.targetMode === "same-row-gap" && !item.diagnosticOnly);
    const actualIconCopyGapCase = actualCases.find(item => item.targetMode === "icon-copy-gap" && !item.diagnosticOnly);
    if (controlOnly) {
      assert.equal(actualClippedTextCase?.status, "observed", "actual Sessions clipped-text touch must produce a raw observation");
      assert.equal(actualClippedTextCase?.cleanup?.gatesReleased, true, "actual Sessions sample must release its fixture gates");
      assert.equal(actualClippedTextCase?.cleanup?.pageClosed, true, "actual Sessions sample page must close before the overlay control runs");
      assert.equal(actualClippedTextCase?.gates?.exactOwnedPageOrigin, true, "actual Sessions sample must remain on owned Gateway origins");
      assert.equal(actualClippedTextCase?.gates?.fixedMobileViewport, true, "actual Sessions sample must use the pinned Mobile viewport");
      assert.equal(actualClippedTextCase?.gates?.settledFirstPages, true, "actual Sessions sample requires settled first pages");
      assert.equal(actualClippedTextCase?.gates?.actualScrollRange, true, "actual Sessions sample requires a real overflowing list");
      assert.equal(actualClippedTextCase?.gates?.startPointWithinSessionsList, true, "actual touch start must hit the Sessions list");
      assert.equal(actualClippedTextCase?.gates?.endPointWithinSessionsList, true, "actual touch end must hit the Sessions list");
      assert.equal(actualClippedTextCase?.gates?.targetClassMatchesCase, true, "actual touch must hit the measured clipped text");
      assert.equal(actualClippedTextCase?.gates?.trustedTouchSequence, true, "actual Sessions sample requires trusted touchstart/move/end");
      assert.equal(actualClippedTextCase?.gates?.collectorsNotTruncated, true, "actual Sessions sample collectors must remain complete");
      assert.equal(actualClippedTextCase?.gates?.rpcLedgerHealthy, true, "actual Sessions fixture RPC ledger must remain healthy");
      assert.equal(actualClippedTextCase?.samePageRnwTouchControl?.status, "observed", "same-page genuine RNW control must produce raw evidence");
      assert.equal(actualClippedTextCase?.samePageRnwTouchControl?.gates?.all, true,
        "same-page RNW control must satisfy its independent viewport, hit-test, touch, scroll and cleanup gates");
      const summary = {
        schemaVersion: 1,
        status: "control-observed",
        claimScope: "one actual Sessions clipped-text touch followed by two trusted gestures against a genuine RNW ScrollView/Pressable/Text overlay on the same already-open page; not a product-equivalence or native-phone claim",
        actualSessionsCase: actualClippedTextCase.observation,
        samePageRnwControl: actualClippedTextCase.samePageRnwTouchControl,
        genericDivControl: nestedControl?.observation ?? null,
        plainOverflowControl: plainControl?.observation ?? null,
        historicalNestedControlDisposition: touchTargetDiagnostics.historicalNestedControlDisposition,
        cursorFlow: "NOT_RUN by explicit same-page control-only mode",
        nativePhone: "NOT_VALIDATED",
      };
      await context.writeArtifactJson("same-page-rnw-touch-control-summary.json", summary);
      return {
        status: summary.status,
        actualSessionsScrollTopDelta: actualClippedTextCase.observation?.scrollTopDelta ?? null,
        rnwClippedTextScrollTopDelta: actualClippedTextCase.samePageRnwTouchControl?.cases?.find(item => item.mode === "clipped-text")?.after?.scrollport?.scrollTop ?? null,
        rnwGapScrollTopDelta: actualClippedTextCase.samePageRnwTouchControl?.cases?.find(item => item.mode === "same-row-row-gap")?.after?.scrollport?.scrollTop ?? null,
      };
    }
    for (const caseRecord of [actualClippedTextCase, actualOriginalGapCase, actualIconCopyGapCase]) {
      assert.equal(caseRecord?.status, "observed", `${caseRecord?.name ?? "actual Sessions case"} must produce raw evidence`);
      assert.equal(caseRecord?.cleanup?.gatesReleased, true, `${caseRecord?.name ?? "actual Sessions case"} must release all fixture gates`);
      assert.equal(caseRecord?.cleanup?.pageClosed, true, `${caseRecord?.name ?? "actual Sessions case"} page must be closed`);
    }
    for (const caseRecord of [actualClippedTextCase, actualOriginalGapCase, actualIconCopyGapCase]) {
      assert.equal(caseRecord.gates?.exactOwnedPageOrigin, true, `${caseRecord.name} must stay within the owned Gateway origin`);
      assert.equal(caseRecord.gates?.fixedMobileViewport, true, `${caseRecord.name} must retain the fixed Mobile viewport`);
      assert.equal(caseRecord.gates?.settledFirstPages, true, `${caseRecord.name} requires settled Sessions first pages`);
      assert.equal(caseRecord.gates?.actualScrollRange, true, `${caseRecord.name} requires real overflowing Sessions content`);
      assert.equal(caseRecord.gates?.startPointWithinSessionsList, true, `${caseRecord.name} touch start must hit the Sessions list`);
      assert.equal(caseRecord.gates?.endPointWithinSessionsList, true, `${caseRecord.name} touch end must hit the Sessions list`);
      assert.equal(caseRecord.gates?.collectorsNotTruncated, true, `${caseRecord.name} diagnostic collectors must remain bounded and complete`);
      assert.equal(caseRecord.gates?.rpcLedgerHealthy, true, `${caseRecord.name} RPC fixture must remain within its strict owned allowlist`);
    }
    assert.equal(actualClippedTextCase.gates?.targetClassMatchesCase, true, "actual baseline target must hit the measured clipped text");
    assert.equal(actualOriginalGapCase.gates?.targetClassMatchesCase, true, "actual baseline target must hit the original row gap, not the clipped text");
    assert.equal(actualIconCopyGapCase.gates?.targetClassMatchesCase, true, "actual baseline target must hit the measured icon-copy gap");
    for (const caseRecord of [actualOriginalGapCase, actualIconCopyGapCase]) {
      assert.equal(caseRecord.geometryComparison?.matchesClippedCase, true,
        `${caseRecord.name} must retain the same fresh-page row/scrollport geometry`);
      assert.notEqual(actualClippedTextCase.input?.gesture?.start?.x, caseRecord.input?.gesture?.start?.x,
        `${caseRecord.name} must change only the measured horizontal start target`);
      assert.equal(actualClippedTextCase.input?.gesture?.start?.y, caseRecord.input?.gesture?.start?.y,
        `${caseRecord.name} must hold the measured vertical touch coordinate constant`);
    }
    assert.equal(actualClippedTextCase.gates?.trustedTouchSequence, true, "actual clipped-text case must receive the trusted touch sequence");
    assert.equal(actualClippedTextCase.samePageRnwTouchControl?.status, "observed",
      "the same-page genuine RNW Pressable/ScrollView control must produce its own raw result");
    assert.equal(actualClippedTextCase.samePageRnwTouchControl?.gates?.all, true,
      "the same-page RNW control must satisfy its independent geometry, hit-test, trusted-input, scroll and cleanup gates");
    assert.equal(actualOriginalGapCase.gates?.trustedTouchSequence, true, "actual original row-gap case must receive the trusted touch sequence");
    assert.equal(actualIconCopyGapCase.gates?.trustedTouchSequence, true, "actual icon-copy-gap case must receive the trusted touch sequence");
    await connectProfileFromLogin(page, gatewayA);
    const mobilePageTouchCapabilities = await page.evaluate(() => ({
      isAboutBlank: location.protocol === "about:",
      readyState: document.readyState,
      maxTouchPoints: Number(navigator.maxTouchPoints) || 0,
      ontouchstart: "ontouchstart" in window,
    }));
    ledger.browserInput.observations.push({ stage: "connected-mobile-page-after-navigation", ...mobilePageTouchCapabilities });
    ledger.browserInput.touchCapabilityGate = {
      passed: !mobilePageTouchCapabilities.isAboutBlank && mobilePageTouchCapabilities.maxTouchPoints > 0,
      required: "actual connected page is navigated and navigator.maxTouchPoints is positive",
      ontouchstart: "observed only; property presence is not a necessary capability gate",
      gestureAcceptance: "later Sessions input must produce trusted touchstart/touchmove/touchend and trusted scroll with actual scrollTop change and the final row rendered",
    };
    await context.writeArtifactJson("mobile-home-sessions-lease3-touch-capabilities-mobile-page.json", {
      schemaVersion: 1,
      stage: "connected-mobile-page-after-navigation",
      configuredMobileOptions: MOBILE_PAGE_OPTIONS,
      observed: mobilePageTouchCapabilities,
      touchCapabilityGate: ledger.browserInput.touchCapabilityGate,
    });
    assert.equal(mobilePageTouchCapabilities.isAboutBlank, false,
      "touch capability must be checked on the actual connected Mobile page, not about:blank");
    assert.ok(mobilePageTouchCapabilities.maxTouchPoints > 0,
      "the connected Mobile page must expose a positive navigator.maxTouchPoints value");
    const profileA = await readProfileIdentity(page, gatewayA.baseUrl);
    await waitFor(() => phases.gates.homeSlowDiscovery.held && phases.gates.homeFastCursor.held,
      30_000, "A fast first page plus the independent slow discovery and fast cursor holds", 50, context.abortSignal);
    await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `thread-${THREAD_FIXTURES.homeFirst.id}`, THREAD_FIXTURES.homeFirst.title);
    assert.equal(await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).isEnabled(), true,
      "the fast Home first-page row must be actionable while peer discovery and its cursor are held");
    homeClickHoldState = {
      slowPeerHeld: phases.gates.homeSlowDiscovery.held,
      slowPeerReleased: phases.gates.homeSlowDiscovery.released,
      fastCursorHeld: phases.gates.homeFastCursor.held,
      fastCursorReleased: phases.gates.homeFastCursor.released,
    };
    assert.deepEqual(homeClickHoldState, {
      slowPeerHeld: true,
      slowPeerReleased: false,
      fastCursorHeld: true,
      fastCursorReleased: false,
    }, "the fast Home row click must happen before either peer or cursor is released");

    await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).click();
    await waitForTaskRoute(page, profileA.id, "fast-A", THREAD_FIXTURES.homeFirst.id, workspaceAfast, THREAD_FIXTURES.homeFirst.title);
    await visible(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(`HISTORY_${THREAD_FIXTURES.homeFirst.id}`, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    phases.gates.homeSlowDiscovery.release("reject");
    phases.gates.homeFastCursor.release("complete");
    phases.current = HOME_RETURN_PHASE;
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `thread-${THREAD_FIXTURES.homeFirst.id}`, THREAD_FIXTURES.homeFirst.title);
    await page.getByText(FIXTURE_ERROR_MESSAGES.homeReturnSlowThreadList, { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
    const homeReturnError = ledger.events.find(event => event.phase === HOME_RETURN_PHASE && event.kind === "configured-error-response" && event.role === "A" && event.server === "A-slow" && event.method === "thread/list");
    assert.ok(homeReturnError, "the returned Home screen must receive an explicit new slow A thread/list error");
    homeReturnErrorRequestIdFingerprint = homeReturnError.requestIdFingerprint;
    assert.ok(ledger.events.some(event => event.phase === HOME_RETURN_PHASE && event.kind === "rpc-request" && event.role === "A" && event.server === "A-slow" && event.method === "thread/list" && event.requestIdFingerprint === homeReturnErrorRequestIdFingerprint),
      "the returned Home error must correlate to the new slow A list request");
    assert.ok(ledger.events.some(event => event.phase === HOME_RETURN_PHASE && event.kind === "rpc-response" && event.role === "A" && event.server === "A-slow" && event.method === "thread/list" && event.responseShape === "error" && event.requestIdFingerprint === homeReturnErrorRequestIdFingerprint),
      "the returned Home error must correlate to its actual error response");

    phases.current = "sessions-a-first-pages-and-held-peer-cursor";
    await visible(page, "sessions").click();
    const sessionsList = visible(page, "sessions-list");
    await sessionsList.waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, `session-${THREAD_FIXTURES.sessionsFastFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `session-${THREAD_FIXTURES.sessionsFastFirst.id}`, THREAD_FIXTURES.sessionsFastFirst.title);
    await visible(page, `session-${THREAD_FIXTURES.sessionsSlowFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `session-${THREAD_FIXTURES.sessionsSlowFirst.id}`, THREAD_FIXTURES.sessionsSlowFirst.title);
    ledger.sessionsScroll = { phase: phases.current, initialSettle: null, initial: null, steps: [], terminal: null };
    const initialSettle = await waitFor(async () => {
      const cursorRequest = ledger.events.find(event => event.phase === phases.current && event.kind === "rpc-request" && event.role === "A" &&
        (event.server === "A-fast" || event.server === "A-slow") && event.method === "thread/list" && event.hasCursor);
      if (cursorRequest) return { status: "cursor-before-input", request: cursorRequest };
      const spinnerVisible = await visible(page, "sessions-page-loading").isVisible();
      return !spinnerVisible && ledger.pendingRpcCount === 0 ? { status: "settled", spinnerVisible, pendingRpcCount: ledger.pendingRpcCount } : false;
    }, 30_000, "both Sessions first pages and initial list loading settle before user scroll", 50, context.abortSignal);
    ledger.sessionsScroll.initialSettle = initialSettle;
    assert.equal(initialSettle.status, "settled", "no cursor request may be counted before a measured user scroll");
    for (const server of ["A-fast", "A-slow"]) {
      const firstPageResponse = ledger.events.find(event => event.phase === phases.current && event.kind === "rpc-response" && event.role === "A" &&
        event.server === server && event.method === "thread/list" && event.responseShape === "result" && !event.hasCursor);
      assert.ok(firstPageResponse?.hasNextCursor, `${server} first page must have returned a cursor before the scroll test`);
    }
    fullCursorFlowOutcome = { status: "RUNNING", stage: "trusted-scroll-and-cursor-gate" };
    await scrollListWithBrowserInput(page, sessionsList, ledger, context.abortSignal);
    await waitFor(() => phases.gates.sessionsSlowCursor.held,
      30_000, "slow Sessions cursor request held after a measured user scroll reached the list end", 50, context.abortSignal);
    const heldCursorRequest = ledger.events.find(event => event.phase === phases.current && event.kind === "rpc-request" && event.role === "A" &&
      event.server === "A-slow" && event.method === "thread/list" && event.hasCursor);
    assert.ok(heldCursorRequest, "slow cursor must be requested after the measured touch input");
    assert.ok(ledger.sessionsScroll.steps.some(step => step.touchStartIssuedNodeMs < heldCursorRequest.atNodeMs &&
      step.after.scrollEventCount > step.before.scrollEventCount && step.after.scrollTop > step.before.scrollTop),
    "the slow cursor request must follow a trusted touch gesture and observed scroll event that moved the actual Sessions list");
    await visible(page, `session-${THREAD_FIXTURES.sessionsFastMore.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "sessions-page-loading").waitFor({ state: "visible", timeout: 30_000 });
    phases.gates.sessionsSlowCursor.release("complete");
    await visible(page, `session-${THREAD_FIXTURES.sessionsSlowMore.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "sessions-page-loading").waitFor({ state: "hidden", timeout: 30_000 });
    fullCursorFlowOutcome = {
      status: "PASS",
      evidence: "trusted scroll moved Sessions list, A-slow cursor request was held, then released and its final row became visible",
    };

    await assertRowAdvertisesTitle(page, `session-${THREAD_FIXTURES.sessionsFastFirst.id}`, THREAD_FIXTURES.sessionsFastFirst.title);
    await visible(page, `session-${THREAD_FIXTURES.sessionsFastFirst.id}`).click();
    await waitForTaskRoute(page, profileA.id, "fast-A", THREAD_FIXTURES.sessionsFastFirst.id, workspaceAfast, THREAD_FIXTURES.sessionsFastFirst.title);
    await visible(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(`HISTORY_${THREAD_FIXTURES.sessionsFastFirst.id}`, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    await visible(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });

    phases.current = "pair-b-actual-settings-profile";
    await openDrawerSettings(page);
    await clickAddGateway(page);
    await visible(page, "welcome-direct-connection").click();
    await visible(page, "gateway-endpoint").fill(gatewayB.baseUrl);
    await visible(page, "gateway-token").fill(gatewayB.authToken);
    phases.current = "profile-b-bootstrap";
    await visible(page, "gateway-connect").click();
    await visible(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    const profileB = await readProfileIdentity(page, gatewayB.baseUrl);
    assert.notEqual(profileA.id, profileB.id, "two owned Gateway profiles must have distinct IDs");
    await waitForStoredActiveProfile(page, profileB.id);
    await visible(page, `thread-${THREAD_FIXTURES.profileBBootstrap.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `thread-${THREAD_FIXTURES.profileBBootstrap.id}`, THREAD_FIXTURES.profileBBootstrap.title);

    await openDrawerSettings(page);
    phases.current = "profile-a-after-b-bootstrap";
    await switchToProfile(page, profileA);
    await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByText(FIXTURE_ERROR_MESSAGES.profileASlowWorkspaceDiscovery, { exact: false }).count() > 0, true,
      "A's owned discovery error must exist before the A-to-B isolation check");

    await openDrawerSettings(page);
    phases.current = "settings-a-to-b-owner-switch-with-b-first-page-held";
    await switchToProfile(page, profileB);
    await waitFor(() => phases.gates.profileBFirstPage.held,
      30_000, "B's first thread/list response held after the actual Settings A-to-B switch", 50, context.abortSignal);
    await waitForStoredActiveProfile(page, profileB.id);
    assert.equal(await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).count(), 0,
      "A's Home row must be absent before B's held first page is released");
    assert.equal(await page.getByText(FIXTURE_ERROR_MESSAGES.profileASlowWorkspaceDiscovery, { exact: false }).count(), 0,
      "A's workspace discovery error must be absent before B's held first page is released");
    assert.equal(await page.getByText(FIXTURE_ERROR_MESSAGES.homeReturnSlowThreadList, { exact: false }).count(), 0,
      "A's earlier thread-list error must be absent before B's held first page is released");
    phases.gates.profileBFirstPage.release("complete");
    await visible(page, `thread-${THREAD_FIXTURES.profileBAfterSwitch.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `thread-${THREAD_FIXTURES.profileBAfterSwitch.id}`, THREAD_FIXTURES.profileBAfterSwitch.title);
    assert.equal(await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).count(), 0);
    await visible(page, `thread-${THREAD_FIXTURES.profileBAfterSwitch.id}`).click();
    await waitForTaskRoute(page, profileB.id, "fast-B", THREAD_FIXTURES.profileBAfterSwitch.id, workspaceBfast, THREAD_FIXTURES.profileBAfterSwitch.title);
    await visible(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(`HISTORY_${THREAD_FIXTURES.profileBAfterSwitch.id}`, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    assert.equal(ledger.rejectedClientRpcCount, 0, "the explicit read-only Mobile RPC allowlist must cover all client operations");
    assert.equal(ledger.droppedEvents, 0, "RPC evidence must remain within the bounded collector");
    assert.equal(ledger.droppedHttpEvents, 0, "HTTP evidence must remain within the bounded collector");
    assert.equal(ledger.droppedHistoryReadCount, 0, "history evidence must remain within the bounded collector");
    assert.equal(ledger.malformedFrameCount, 0, "all observed RPC frames must parse");
    assert.equal(ledger.unknownRpcResponseCount, 0, "all observed RPC responses must correlate to one request");
    assert.equal(ledger.rejectedServerFrameCount, 0, "the mock Gateway must not send unallowlisted server frames");
    assert.equal(ledger.rejectedWebSocketCount, 0, "all page WebSockets must use an exact owned Gateway route");
    assert.equal(ledger.foreignWebSocketBlockedCount, 0, "the page must not attempt foreign-origin WebSockets");
    assert.equal(ledger.foreignHttpBlockedCount, 0, "the page must not attempt foreign-origin HTTP requests");
    assert.equal(ledger.foreignHttpResponseCount, 0, "no foreign-origin HTTP response may reach the page");
    assert.equal(ledger.httpRouteOverflowCount, 0, "all page HTTP requests must stay within the explicit interception bound");
    assert.equal(ledger.webSocketRouteOverflowCount, 0, "WebSocket route count must stay within its explicit bound");
    assert.equal(ledger.pendingRpcCount, 0, "all allowed RPC requests must be correlated before evidence is finalized");
    assert.equal(ledger.fixtureErrorCount, 0, "all fixture response handling must complete");
    assert.equal(pageErrorCount, 0, "the page must have no uncaught JavaScript errors");
    assert.equal(consoleErrorCount, 0, "the page must have no console errors");
    const historyAliasesRead = [...new Set(ledger.historyReadThreadIds.map(historyAlias))].sort();
    for (const expectedAlias of [THREAD_FIXTURES.homeFirst.id, THREAD_FIXTURES.sessionsFastFirst.id, THREAD_FIXTURES.profileBAfterSwitch.id])
      assert.ok(historyAliasesRead.includes(expectedAlias), `actual thread/read response for ${expectedAlias} must be observed`);
    const heldBPage = ledger.events.find(event => event.phase === "settings-a-to-b-owner-switch-with-b-first-page-held" && event.role === "B" && event.method === "thread/list" && event.kind === "held-response");
    assert.ok(heldBPage, "the owner-switch check must be backed by B's actual held RPC response");
    assert.ok(ledger.events.some(event => event.phase === heldBPage.phase && event.role === "B" && event.method === "thread/list" && event.kind === "rpc-request" && event.requestIdFingerprint === heldBPage.requestIdFingerprint),
      "the held B response must correlate to its observed list request");
    const sessionsSocketOrdinals = assertSessionsSocketOrdinals(ledger.events);
    const gatewaySourceAfter = await verifyFrozenGatewayRuntimeSnapshot();
    const liveGatewayObservationAfter = await observeLiveGatewayCheckout();
    assert.equal(gatewaySourceAfter.fileCount, gatewaySourceBefore.fileCount, "complete Gateway source closure file count changed during the run");
    assert.equal(gatewaySourceAfter.sourceTreeSha256, gatewaySourceBefore.sourceTreeSha256, "complete Gateway source closure changed during the run");
    assert.equal(gatewaySourceAfter.dependencyFileCount, gatewaySourceBefore.dependencyFileCount, "complete Gateway dependency closure file count changed during the run");
    assert.equal(gatewaySourceAfter.dependencyTreeSha256, gatewaySourceBefore.dependencyTreeSha256, "complete Gateway dependency closure changed during the run");
    assert.deepEqual(gatewaySourceAfter.binaryIdentity, gatewaySourceBefore.binaryIdentity, "pinned mock Gateway binary identity changed during the run");
    assert.deepEqual(gatewaySourceAfter.files, gatewaySourceFreeze.currentManifest.files, "Gateway source file closure changed during the run");

    await context.writeArtifactJson("mobile-home-sessions-lease3-local-dom-observation.json", {
      schemaVersion: 1,
      status: "functional-checks-satisfied-awaiting-runcontext-cleanup",
      terminalStatus: "not-yet-observed",
      claimScope: "local two-Gateway Mobile Web mock DOM/profile route only; not Rust, public Relay, real-phone, Provider, or model evidence",
      export: { sourceTreeSha256: SOURCE_TREE_SHA256, exporterManifestSha256: EXPORT_MANIFEST_SHA256, derivedReuseManifestSha256: derivedExport.manifestSha256, bundleSha256: BUNDLE_SHA256, bundleFileCount: BUNDLE_FILE_COUNT },
      gatewaySource: {
        executionRootRelativePath: relative(repoRoot, gatewaySourceBefore.snapshotRoot),
        freezeManifestSha256: gatewaySourceBefore.manifestSha256,
        fileCount: gatewaySourceBefore.fileCount,
        sourceTreeSha256: gatewaySourceBefore.sourceTreeSha256,
        dependencyFileCount: gatewaySourceBefore.dependencyFileCount,
        dependencyTreeSha256: gatewaySourceBefore.dependencyTreeSha256,
        binarySha256: gatewaySourceBefore.binarySha256,
        currentManifestSha256: gatewaySourceFreeze.currentManifestSha256,
        deltaSha256: gatewaySourceFreeze.deltaSha256,
        changedPaths: gatewaySourceFreeze.delta.changes.map(change => change.path),
        unchanged: gatewaySourceAfter.sourceTreeSha256 === gatewaySourceBefore.sourceTreeSha256,
        dependenciesUnchanged: gatewaySourceAfter.dependencyTreeSha256 === gatewaySourceBefore.dependencyTreeSha256,
        nonExecutionLiveCheckoutObservationBefore: { ...liveGatewayObservationBefore, executed: false },
        nonExecutionLiveCheckoutObservationAfter: { ...liveGatewayObservationAfter, executed: false },
      },
      profileAliases: { A: shortHash(profileA.id), B: shortHash(profileB.id), distinct: profileA.id !== profileB.id },
      gatewayAliases: { A: gatewayA.port, B: gatewayB.port, distinct: gatewayA.port !== gatewayB.port },
      browserInput: ledger.browserInput,
      touchTargetDiagnostics: ledger.touchTargetDiagnostics,
      fullCursorFlowOutcome,
      home: { firstRowVisibleWhilePeerAndCursorHeld: true, firstRowClickedWhilePeerAndCursorHeld: true, holdStateAtClick: homeClickHoldState, slowPeerReleasedAfterRouteAndHistoryVerified: true, routeAndHistoryVerified: true },
      homeReturnError: { phase: HOME_RETURN_PHASE, method: "thread/list", role: "A", server: "A-slow", requestIdFingerprint: homeReturnErrorRequestIdFingerprint, requestAndErrorResponseCorrelated: true },
      sessions: { firstRowsVisible: true, fastLoadMoreVisibleWhileSlowCursorHeld: true, slowCursorReleasedAndVisible: true, routeAndHistoryVerified: true, socketOrdinals: sessionsSocketOrdinals, scrollEvidence: ledger.sessionsScroll },
      profileSwitch: { actualSettingsSwitch: true, oldARowAbsentBeforeBFirstPageRelease: true, oldAErrorAbsentBeforeBFirstPageRelease: true, BRouteAndHistoryVerified: true },
      calls: {
        rejectedClientRpcCount: ledger.rejectedClientRpcCount,
        rejectedServerFrameCount: ledger.rejectedServerFrameCount,
        rejectedWebSocketCount: ledger.rejectedWebSocketCount,
        foreignWebSocketBlockedCount: ledger.foreignWebSocketBlockedCount,
        foreignHttpBlockedCount: ledger.foreignHttpBlockedCount,
        foreignHttpResponseCount: ledger.foreignHttpResponseCount,
        httpRouteCount: ledger.httpRouteCount,
        httpRouteOverflowCount: ledger.httpRouteOverflowCount,
        webSocketRouteCount: ledger.webSocketRouteCount,
        pendingRpcCount: ledger.pendingRpcCount,
        historyAliasesRead,
        pageErrorCount,
        consoleErrorCount,
      },
      http: ledger.http,
      rpcEvents: ledger.events,
      droppedEvents: ledger.droppedEvents,
      droppedHttpEvents: ledger.droppedHttpEvents,
      droppedHistoryReadCount: ledger.droppedHistoryReadCount,
      homeClickHoldState,
      homeReturnErrorRequestIdFingerprint,
      gatewaySourceBefore: {
        executionRootRelativePath: relative(repoRoot, gatewaySourceBefore.snapshotRoot),
        freezeManifestSha256: gatewaySourceBefore.manifestSha256,
        fileCount: gatewaySourceBefore.fileCount,
        sourceTreeSha256: gatewaySourceBefore.sourceTreeSha256,
        dependencyFileCount: gatewaySourceBefore.dependencyFileCount,
        dependencyTreeSha256: gatewaySourceBefore.dependencyTreeSha256,
        binarySha256: gatewaySourceBefore.binarySha256,
        nonExecutionLiveCheckoutObservation: { ...liveGatewayObservationBefore, executed: false },
      },
      rejectedClientMethods: ledger.rejectedClientMethods,
      malformedFrameCount: ledger.malformedFrameCount,
      unknownRpcResponseCount: ledger.unknownRpcResponseCount,
      fixtureErrorCount: ledger.fixtureErrorCount,
      held: ledger.held,
      gates: summarizeGates(phases.gates),
      sourcePins,
    });
  } catch (error) {
    if (fullCursorFlowOutcome.status === "RUNNING") {
      fullCursorFlowOutcome = { status: "FAIL_OR_INCOMPLETE", stage: phases.current, errorName: safeErrorName(error) };
    }
    await context.writeArtifactJson("mobile-home-sessions-lease3-local-dom-failure.json", {
      schemaVersion: 1,
      status: "failed",
      evidenceDisposition: ledger.touchTargetDiagnostics && fullCursorFlowOutcome.status === "NOT_RUN"
        ? "PARTIAL_TOUCH_TARGET_DIAGNOSTICS_COLLECTED; FULL_SESSIONS_CURSOR_FLOW_NOT_RUN"
        : "FAILURE_DURING_SETUP_OR_FULL_SESSIONS_CURSOR_FLOW",
      phase: phases.current,
      errorName: safeErrorName(error),
      rpcEvents: ledger.events,
      http: ledger.http,
      droppedEvents: ledger.droppedEvents,
      malformedFrameCount: ledger.malformedFrameCount,
      unknownRpcResponseCount: ledger.unknownRpcResponseCount,
      rejectedClientRpcCount: ledger.rejectedClientRpcCount,
      rejectedServerFrameCount: ledger.rejectedServerFrameCount,
      rejectedWebSocketCount: ledger.rejectedWebSocketCount,
      foreignWebSocketBlockedCount: ledger.foreignWebSocketBlockedCount,
      foreignHttpBlockedCount: ledger.foreignHttpBlockedCount,
      foreignHttpResponseCount: ledger.foreignHttpResponseCount,
      httpRouteCount: ledger.httpRouteCount,
      httpRouteOverflowCount: ledger.httpRouteOverflowCount,
      webSocketRouteOverflowCount: ledger.webSocketRouteOverflowCount,
      webSocketRouteCount: ledger.webSocketRouteCount,
      pendingRpcCount: ledger.pendingRpcCount,
      fixtureErrorCount: ledger.fixtureErrorCount,
      droppedHttpEvents: ledger.droppedHttpEvents,
      droppedHistoryReadCount: ledger.droppedHistoryReadCount,
      rejectedClientMethods: ledger.rejectedClientMethods,
      historyAliasesRead: [...new Set(ledger.historyReadThreadIds.map(historyAlias))].sort(),
      held: ledger.held,
      gates: summarizeGates(phases.gates),
      sessionsScroll: ledger.sessionsScroll,
      browserInput: ledger.browserInput,
      touchTargetDiagnostics: ledger.touchTargetDiagnostics,
      fullCursorFlowOutcome,
      pageErrorCount,
      consoleErrorCount,
      gatewaySourceBefore: {
        executionRootRelativePath: relative(repoRoot, gatewaySourceBefore.snapshotRoot),
        freezeManifestSha256: gatewaySourceBefore.manifestSha256,
        fileCount: gatewaySourceBefore.fileCount,
        sourceTreeSha256: gatewaySourceBefore.sourceTreeSha256,
        dependencyFileCount: gatewaySourceBefore.dependencyFileCount,
        dependencyTreeSha256: gatewaySourceBefore.dependencyTreeSha256,
        binarySha256: gatewaySourceBefore.binarySha256,
        nonExecutionLiveCheckoutObservation: { ...liveGatewayObservationBefore, executed: false },
      },
      sourcePins,
    });
    throw error;
  } finally {
    phases.gates.homeSlowDiscovery.release("cleanup");
    phases.gates.homeFastCursor.release("cleanup");
    phases.gates.sessionsSlowCursor.release("cleanup");
    phases.gates.profileBFirstPage.release("cleanup");
  }
});

async function installRpcFixture(page, context, { gatewayA, gatewayB, roleForOrigin, phases, ledger, workspaceByTarget, record }) {
  await page.routeWebSocket("**/*", async routed => {
    ledger.webSocketRouteCount += 1;
    const socketOrdinal = ledger.webSocketRouteCount;
    if (socketOrdinal > MAX_WEBSOCKET_ROUTES) {
      ledger.webSocketRouteOverflowCount += 1;
      await routed.close({ code: 1008, reason: "local fixture route limit" });
      return;
    }
    let role = null;
    let serverId = "unknown";
    let workspaceAlias = "default";
    let rpcPathOwned = false;
    let websocketUrl = null;
    try {
      websocketUrl = new URL(typeof routed.url === "function" ? routed.url() : routed.url);
      role = roleForOrigin(websocketUrl.origin);
      rpcPathOwned = websocketUrl.pathname === "/rpc" && ["ws:", "wss:"].includes(websocketUrl.protocol);
      serverId = websocketUrl.searchParams.get("server") ?? "unknown";
      const workspace = websocketUrl.searchParams.get("workspace");
      if (workspace) workspaceAlias = Object.keys(workspaceByTarget).find(key => workspaceByTarget[key] === workspace) ?? "other";
    } catch { ledger.malformedFrameCount += 1; }
    const routeOwned = websocketUrl && !websocketUrl.username && !websocketUrl.password && rpcPathOwned && workspaceAlias === `${role}/${serverId}` &&
      ((role === "A" && (serverId === "fast-A" || serverId === "slow-A")) || (role === "B" && serverId === "fast-B"));
    if (!role) {
      ledger.foreignWebSocketBlockedCount += 1;
      record({ phase: phases.current, kind: "foreign-websocket-blocked", direction: "page-to-gateway", role: "foreign", socketOrdinal });
      await routed.close({ code: 1008, reason: "local fixture rejected foreign WebSocket" });
      return;
    }
    if (!routeOwned) {
      ledger.rejectedWebSocketCount += 1;
      record({ phase: phases.current, kind: "unowned-websocket-rejected", direction: "page-to-gateway", role, server: SERVER_ALIASES[serverId] ?? "unknown", socketOrdinal });
      await routed.close({ code: 1008, reason: "local fixture rejected unowned WebSocket" });
      return;
    }
    const recordSocket = event => record({ ...event, socketOrdinal });
    recordSocket({ phase: phases.current, kind: "owned-websocket-connected", direction: "page-to-gateway", role, server: SERVER_ALIASES[serverId] ?? "unknown", workspace: workspaceAlias });
    const upstream = routed.connectToServer();
    const outstanding = new Map();
    let closed = false;
    const releaseOutstanding = () => {
      ledger.pendingRpcCount -= outstanding.size;
      outstanding.clear();
    };
    routed.onClose((code) => {
      closed = true;
      releaseOutstanding();
      recordSocket({ phase: phases.current, kind: "owned-websocket-closed", direction: "page-to-gateway", role, server: SERVER_ALIASES[serverId] ?? "unknown", closeCode: Number.isSafeInteger(code) ? code : null });
      const closeOptions = Number.isSafeInteger(code) && code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code)
        ? { code }
        : {};
      void upstream.close(closeOptions).catch(() => {});
    });
    routed.onMessage(raw => {
      const parsed = parseObservedJsonRpcFrame("client-to-server", raw);
      if (!parsed.ok) {
        ledger.malformedFrameCount += 1;
        recordSocket({ phase: phases.current, kind: "rejected-client-frame", direction: "client-to-server", reason: parsed.reason });
        return;
      }
      const frame = parsed.frame;
      const phase = phases.current;
      const routeOwned = rpcPathOwned && workspaceAlias === `${role}/${serverId}` &&
        ((role === "A" && (serverId === "fast-A" || serverId === "slow-A")) ||
        (role === "B" && serverId === "fast-B"));
      if (Object.hasOwn(frame, "params") && !isRecord(frame.params)) {
        ledger.malformedFrameCount += 1;
        recordSocket({ phase, kind: "rejected-client-frame", direction: "client-to-server", reason: "params-not-object" });
        if (parsed.envelopeKind === "request")
          routed.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32600, message: "fixture requires object params" } }));
        return;
      }
      if (parsed.envelopeKind === "notification") {
        if (!routeOwned || !ALLOWED_CLIENT_NOTIFICATIONS.has(frame.method)) {
          ledger.rejectedClientRpcCount += 1;
          recordSocket({ phase, kind: "rejected-client-notification", direction: "client-to-server", method: safeMethod(frame.method), reason: "notification-not-allowlisted" });
          return;
        }
        recordSocket({ phase, kind: "rpc-notification", direction: "client-to-server", role, server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(frame.method) });
        upstream.send(raw);
        return;
      }

      const key = rpcKey(frame.id);
      const method = frame.method;
      const params = isRecord(frame.params) ? frame.params : {};
      const readTargetsKnown = !["thread/read", "thread/resume", "thread/goal/get"].includes(method) ||
        (typeof params.threadId === "string" && THREAD_FIXTURE_ROUTES.get(params.threadId) === `${role}/${serverId}`);
      if (!ALLOWED_CLIENT_RPC_METHODS.has(method) || !readTargetsKnown || outstanding.size >= MAX_PENDING_RPCS || ledger.pendingRpcCount >= MAX_TOTAL_PENDING_RPCS || outstanding.has(key)) {
        ledger.rejectedClientRpcCount += 1;
        if (ledger.rejectedClientMethods.length < 32) ledger.rejectedClientMethods.push(safeMethod(method));
        const reason = !ALLOWED_CLIENT_RPC_METHODS.has(method) ? "method-not-allowlisted" : !readTargetsKnown ? "thread-id-not-in-fixture" : "pending-limit-or-duplicate-id";
        recordSocket({ phase, kind: "rejected-client-rpc", direction: "client-to-server", role, server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(method), requestIdFingerprint: shortHash(key), reason });
        routed.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "fixture blocked non-allowlisted request" } }));
        return;
      }
      const request = {
        id: frame.id,
        method,
        params: isRecord(frame.params) ? frame.params : {},
        role,
        serverId,
        workspaceAlias,
        socketOrdinal,
        phase,
        sentAtNodeMs: performance.now(),
      };
      outstanding.set(key, request);
      ledger.pendingRpcCount += 1;
      recordSocket({ phase, kind: "rpc-request", direction: "client-to-server", role, server: SERVER_ALIASES[serverId] ?? "unknown", workspace: workspaceAlias, method: safeMethod(method), requestIdFingerprint: shortHash(key), hasCursor: Boolean(request.params.cursor) });
      upstream.send(raw);
    });
    upstream.onMessage(async raw => {
      const parsed = parseObservedJsonRpcFrame("server-to-client", raw);
      if (!parsed.ok) {
        ledger.malformedFrameCount += 1;
        recordSocket({ phase: phases.current, kind: "rejected-server-frame", direction: "server-to-client", reason: parsed.reason });
        return;
      }
      if (parsed.envelopeKind === "notification") {
        const method = parsed.frame.method;
        if (!ALLOWED_SERVER_NOTIFICATIONS.has(method)) {
          ledger.rejectedServerFrameCount += 1;
          recordSocket({ phase: phases.current, kind: "rejected-server-notification", direction: "server-to-client", method: safeMethod(method) });
          return;
        }
        recordSocket({ phase: phases.current, kind: "rpc-notification", direction: "server-to-client", role, server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(method) });
        routed.send(raw);
        return;
      }
      if (parsed.envelopeKind !== "response") {
        ledger.rejectedServerFrameCount += 1;
        recordSocket({ phase: phases.current, kind: "rejected-server-request", direction: "server-to-client", method: safeMethod(parsed.frame.method) });
        upstream.send(JSON.stringify({ jsonrpc: "2.0", id: parsed.frame.id, error: { code: -32601, message: "local fixture does not accept server requests" } }));
        return;
      }
      const response = structuredClone(parsed.frame);
      const request = outstanding.get(rpcKey(response.id));
      if (!request) {
        ledger.unknownRpcResponseCount += 1;
        recordSocket({ phase: phases.current, kind: "uncorrelated-server-response", direction: "server-to-client", requestIdFingerprint: shortHash(rpcKey(response.id)) });
        routed.send(raw);
        return;
      }
      outstanding.delete(rpcKey(response.id));
      ledger.pendingRpcCount -= 1;
      try {
        const action = await shapeOrHoldResponse(response, request, workspaceByTarget, ledger, closed, recordSocket);
        if (closed) return;
        recordSocket({ phase: request.phase, kind: action.held ? "held-response-released" : "rpc-response", direction: "server-to-client", role: request.role, server: SERVER_ALIASES[request.serverId] ?? "unknown", workspace: request.workspaceAlias, method: safeMethod(request.method), requestIdFingerprint: shortHash(rpcKey(request.id)), responseShape: Object.hasOwn(action.frame, "error") ? "error" : "result", hasNextCursor: request.method === "thread/list" && isRecord(action.frame.result) && typeof action.frame.result.nextCursor === "string" && action.frame.result.nextCursor.length > 0, held: action.held, elapsedNodeMs: Math.max(0, performance.now() - request.sentAtNodeMs) });
        routed.send(JSON.stringify(action.frame));
      } catch {
        ledger.fixtureErrorCount += 1;
        recordSocket({ phase: request.phase, kind: "fixture-response-error", direction: "server-to-client", role: request.role, server: SERVER_ALIASES[request.serverId] ?? "unknown", method: safeMethod(request.method), requestIdFingerprint: shortHash(rpcKey(request.id)) });
        if (!closed) routed.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "local fixture failed" } }));
      }
    });
  });
}

async function shapeOrHoldResponse(response, request, workspaceByTarget, ledger, closed, record) {
  const { role, serverId, method, params, phase } = request;
  let held = false;
  if (method === "runtime.workspaces.list" && role === "A" && serverId === "slow-A" && phase === "home-a-fast-first-peer-and-cursor-held" && !ledger.gates.homeSlowDiscovery.released) {
    ledger.gates.homeSlowDiscovery.held = true;
    ledger.held.homeSlowDiscovery = true;
    recordForGate(record, phase, "held-response", role, serverId, method, response.id);
    const releaseKind = await ledger.gates.homeSlowDiscovery.promise;
    held = true;
    if (closed) return { frame: response, held };
    if (releaseKind === "reject")
      return { frame: { jsonrpc: "2.0", id: response.id, error: { code: -32110, message: FIXTURE_ERROR_MESSAGES.profileASlowWorkspaceDiscovery } }, held };
  }
  if (method === "runtime.workspaces.list" && role === "A" && serverId === "slow-A" && phase === "profile-a-after-b-bootstrap")
    return { frame: { jsonrpc: "2.0", id: response.id, error: { code: -32110, message: FIXTURE_ERROR_MESSAGES.profileASlowWorkspaceDiscovery } }, held };
  if (method === "thread/list" && role === "A" && serverId === "slow-A" && phase === HOME_RETURN_PHASE) {
    recordForGate(record, phase, "configured-error-response", role, serverId, method, response.id);
    return { frame: { jsonrpc: "2.0", id: response.id, error: { code: -32111, message: FIXTURE_ERROR_MESSAGES.homeReturnSlowThreadList } }, held };
  }
  if (method === "runtime.workspaces.list") {
    const workspace = workspaceByTarget[`${role}/${serverId}`];
    if (workspace) response.result = { ...(isRecord(response.result) ? response.result : {}), success: true, items: [{ workspacePath: workspace, label: SERVER_ALIASES[serverId] ?? serverId }], pinnedTaskIds: [], taskOrders: {} };
  } else if (method === "runtime.worktrees.list") {
    response.result = { ...(isRecord(response.result) ? response.result : {}), success: true, items: [] };
  } else if (method === "thread/list") {
    const page = fixturePage(phase, role, serverId, params, workspaceByTarget);
    if (page) {
      if (page.gate) {
        const gate = ledger.gates[page.gate];
        gate.held = true;
        if (page.gate === "homeFastCursor") ledger.held.homeFastCursor = true;
        if (page.gate === "sessionsSlowCursor") ledger.held.sessionsSlowCursor = true;
        if (page.gate === "profileBFirstPage") ledger.held.profileBFirstPage = true;
        recordForGate(record, phase, "held-response", role, serverId, method, response.id);
        await gate.promise;
        held = true;
        if (closed) return { frame: response, held };
      }
      response.result = { ...(isRecord(response.result) ? response.result : {}), threads: page.threads, nextCursor: page.nextCursor ?? null, completeness: "complete", issueCount: 0 };
    } else {
      ledger.fixtureErrorCount += 1;
      record({ phase, kind: "unmapped-fixture-rpc", role: role ?? "foreign", server: SERVER_ALIASES[serverId] ?? "unknown",
        workspace: request.workspaceAlias ?? "unknown", method: safeMethod(method), reason: "no-fixture-page-for-phase",
        requestIdFingerprint: shortHash(rpcKey(response.id)), hasCursor: Boolean(params.cursor) });
      return { frame: { jsonrpc: "2.0", id: response.id, error: { code: -32602, message: "fixture has no response for this list phase" } }, held };
    }
  } else if (method === "thread/read") {
    const threadId = typeof params.threadId === "string" ? params.threadId : "unknown-thread";
    if (!FIXTURE_THREAD_IDS.has(threadId) || THREAD_FIXTURE_ROUTES.get(threadId) !== `${role}/${serverId}`) {
      ledger.fixtureErrorCount += 1;
      record({ phase, kind: "unmapped-fixture-rpc", role: role ?? "foreign", server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(method), reason: "thread-id-not-owned-by-route" });
      return { frame: { jsonrpc: "2.0", id: response.id, error: { code: -32602, message: "fixture has no response for this thread" } }, held };
    }
    if (ledger.historyReadThreadIds.length < MAX_HISTORY_READS) ledger.historyReadThreadIds.push(threadId);
    else ledger.droppedHistoryReadCount += 1;
    const alias = historyAlias(threadId);
    response.result = {
      ...(isRecord(response.result) ? response.result : {}),
      thread: { id: threadId, title: threadId, cwd: workspaceByTarget[`${role}/${serverId}`] ?? "/", status: "idle", model: "mock-local", createdAt: 1, updatedAt: 2 },
      messages: [{ id: `history-${alias}`, role: "user", content: `HISTORY_${alias}`, timestampMs: 2, blocks: [] }],
    };
  }
  return { frame: response, held };
}

function fixturePage(phase, role, serverId, params, workspaceByTarget) {
  const cursor = typeof params.cursor === "string" ? params.cursor : null;
  if (phase === HOME_RETURN_PHASE && role === "A" && serverId === "fast-A" && !cursor)
    return { threads: [threadSummary(THREAD_FIXTURES.homeFirst.id, THREAD_FIXTURES.homeFirst.title, workspaceByTarget["A/fast-A"])], nextCursor: null };
  if (phase === "home-a-fast-first-peer-and-cursor-held" && role === "A" && serverId === "slow-A" && !cursor)
    return { threads: [threadSummary(THREAD_FIXTURES.homeSlowPeerFirst.id, THREAD_FIXTURES.homeSlowPeerFirst.title, workspaceByTarget["A/slow-A"])], nextCursor: null };
  if (phase === "home-a-fast-first-peer-and-cursor-held" && role === "A" && serverId === "fast-A") {
    if (!cursor) return { threads: [threadSummary(THREAD_FIXTURES.homeFirst.id, THREAD_FIXTURES.homeFirst.title, workspaceByTarget["A/fast-A"])], nextCursor: "home-fast-cursor" };
    if (cursor === "home-fast-cursor") return { threads: [threadSummary(THREAD_FIXTURES.homeMore.id, THREAD_FIXTURES.homeMore.title, workspaceByTarget["A/fast-A"])], nextCursor: null, gate: "homeFastCursor" };
  }
  if (phase === "sessions-a-first-pages-and-held-peer-cursor" && role === "A" && (serverId === "fast-A" || serverId === "slow-A")) {
    const fast = serverId === "fast-A";
    const prefix = fast ? "A_SESSIONS_FAST" : "A_SESSIONS_SLOW";
    const first = fast ? THREAD_FIXTURES.sessionsFastFirst : THREAD_FIXTURES.sessionsSlowFirst;
    if (!cursor) {
      const workspace = workspaceByTarget[`A/${serverId}`];
      return { threads: Array.from({ length: 8 }, (_value, index) => index === 0
        ? threadSummary(first.id, first.title, workspace)
        : threadSummary(`${prefix}_${index}`, `A Sessions ${fast ? "fast" : "slow"} ${index}`, workspace)), nextCursor: `${prefix}_CURSOR` };
    }
    if (cursor === "A_SESSIONS_FAST_CURSOR" && serverId === "fast-A")
      return { threads: [threadSummary(THREAD_FIXTURES.sessionsFastMore.id, THREAD_FIXTURES.sessionsFastMore.title, workspaceByTarget["A/fast-A"])], nextCursor: null };
    if (cursor === "A_SESSIONS_SLOW_CURSOR" && serverId === "slow-A")
      return { threads: [threadSummary(THREAD_FIXTURES.sessionsSlowMore.id, THREAD_FIXTURES.sessionsSlowMore.title, workspaceByTarget["A/slow-A"])], nextCursor: null, gate: "sessionsSlowCursor" };
  }
  if ((phase === "profile-b-bootstrap" || phase === "settings-a-to-b-owner-switch-with-b-first-page-held") && role === "B" && serverId === "fast-B" && !cursor) {
    if (phase === "settings-a-to-b-owner-switch-with-b-first-page-held")
      return { threads: [threadSummary(THREAD_FIXTURES.profileBAfterSwitch.id, THREAD_FIXTURES.profileBAfterSwitch.title, workspaceByTarget["B/fast-B"])], nextCursor: null, gate: "profileBFirstPage" };
    return { threads: [threadSummary(THREAD_FIXTURES.profileBBootstrap.id, THREAD_FIXTURES.profileBBootstrap.title, workspaceByTarget["B/fast-B"])], nextCursor: null };
  }
  if (phase === "profile-a-after-b-bootstrap" && role === "A" && serverId === "fast-A" && !cursor)
    return { threads: [threadSummary(THREAD_FIXTURES.homeFirst.id, THREAD_FIXTURES.homeFirst.title, workspaceByTarget["A/fast-A"])], nextCursor: null };
  return null;
}

async function verifySourcePins(frozenSourceMap) {
  const observed = { frozenMobileSource: {}, liveCheckoutSource: {} };
  for (const [relativePath, expected] of Object.entries(FROZEN_MOBILE_SOURCE_PINS)) {
    assert.ok(Object.hasOwn(frozenSourceMap, relativePath), `pinned Mobile file is missing from the 339-file freeze: ${relativePath}`);
    assert.equal(frozenSourceMap[relativePath], expected, `pinned Mobile file differs from the 339-file freeze: ${relativePath}`);
    observed.frozenMobileSource[relativePath] = expected;
  }
  for (const [relativePath, expected] of Object.entries(LIVE_SOURCE_PINS)) {
    const file = resolve(repoRoot, relativePath);
    assert.equal(await realpath(file), file, `source pin must be canonical: ${relativePath}`);
    const stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `source pin must be a regular file: ${relativePath}`);
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    assert.equal(digest, expected, `source pin changed: ${relativePath}`);
    if (Object.hasOwn(frozenSourceMap, relativePath))
      assert.equal(frozenSourceMap[relativePath], expected, `live pin differs from the source freeze: ${relativePath}`);
    observed.liveCheckoutSource[relativePath] = digest;
  }
  return observed;
}

async function verifyPinnedRegularFile(file, expectedSha256) {
  assert.equal(await realpath(file), file, `pinned input must be canonical: ${file}`);
  const stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `pinned input must be a regular file: ${file}`);
  const sha256 = createHash("sha256").update(await readFile(file)).digest("hex");
  assert.equal(sha256, expectedSha256, `pinned input digest changed: ${file}`);
  return sha256;
}

async function deriveSchema1ReuseInput(context, sourceBundleRoot, exportManifestPath, exportProvenancePath) {
  const exportManifestSha256 = await verifyPinnedRegularFile(exportManifestPath, EXPORT_MANIFEST_SHA256);
  const exportProvenanceSha256 = await verifyPinnedRegularFile(exportProvenancePath, EXPORT_PROVENANCE_SHA256);
  const sourceRoot = resolve(sourceBundleRoot);
  assert.equal(sourceRoot, sourceBundleRoot, "schema-2 bundle root must be normalized");
  assert.equal(await realpath(sourceRoot), sourceRoot, "schema-2 bundle root must be canonical");
  const exportManifest = await readJson(exportManifestPath);
  assert.equal(exportManifest.schemaVersion, 2, "pinned Mobile Web exporter manifest must use schema 2");
  assert.equal(exportManifest.status, "complete");
  assert.equal(exportManifest.failurePhase, null);
  assert.equal(exportManifest.error, null);
  assert.equal(exportManifest.sourceTreeSha256, SOURCE_TREE_SHA256);
  assert.equal(exportManifest.sourceHashBefore, SOURCE_TREE_SHA256);
  assert.equal(exportManifest.sourceHashAfter, SOURCE_TREE_SHA256);
  assert.equal(exportManifest.sourceUnchanged, true);
  assert.equal(exportManifest.snapshotCopyMatchesSource, true);
  assert.equal(exportManifest.snapshotUnchangedDuringExport, true);
  assert.equal(exportManifest.bundleSha256, BUNDLE_SHA256);
  assert.equal(exportManifest.bundleFileCount, BUNDLE_FILE_COUNT);
  assert.ok(Array.isArray(exportManifest.bundleFiles) && exportManifest.bundleFiles.length === BUNDLE_FILE_COUNT,
    "schema-2 manifest must contain the exact 37-file bundle table");
  const files = exportManifest.bundleFiles;
  assert.equal(hashJson(files), BUNDLE_SHA256, "schema-2 ordered bundle table must match its fixed aggregate SHA-256");
  const indexFiles = files.filter(file => file?.path === "index.html");
  assert.equal(indexFiles.length, 1, "schema-2 table must contain exactly one root index.html");
  assert.equal(indexFiles[0].sha256, exportManifest.indexHtmlSha256);

  const ownedBundleRoot = context.pathInArtifacts("home-sessions-lease3-schema2-bundle");
  assert.equal(resolve(ownedBundleRoot), ownedBundleRoot, "derived public bundle path must be normalized");
  const relativeBundleRoot = relative(context.runRoot, ownedBundleRoot);
  assert.ok(relativeBundleRoot.startsWith(`artifacts${sep}`) && !relativeBundleRoot.startsWith(`..${sep}`),
    "derived bundle must remain inside this RunContext artifacts");
  await mkdir(ownedBundleRoot, { recursive: false, mode: 0o700 });

  let totalBytes = 0;
  const derivedFiles = [];
  for (const entry of files) {
    assert.ok(entry && Object.keys(entry).join(",") === "path,size,sha256",
      "schema-2 bundle entry must contain only path, size, and SHA-256 in fixed order");
    const bundlePath = assertSafeMobileBundlePath(entry.path);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0, "schema-2 bundle entry size is invalid");
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, "schema-2 bundle entry SHA-256 is invalid");
    totalBytes += entry.size;
    assert.ok(totalBytes <= 64 * 1024 * 1024, "pinned Mobile Web bundle exceeds the public-copy bound");

    const sourceFile = resolve(sourceRoot, ...bundlePath.split("/"));
    assertContainedPath(sourceRoot, sourceFile, "schema-2 bundle entry escaped the pinned bundle root");
    assert.equal(await realpath(sourceFile), sourceFile, `schema-2 bundle file must be canonical: ${bundlePath}`);
    const sourceInfo = await lstat(sourceFile);
    assert.ok(sourceInfo.isFile() && !sourceInfo.isSymbolicLink(), `schema-2 bundle entry must be a regular file: ${bundlePath}`);
    const bytes = await readFile(sourceFile);
    assert.equal(bytes.length, entry.size, `schema-2 bundle size changed: ${bundlePath}`);
    assert.equal(hashBytes(bytes), entry.sha256, `schema-2 bundle SHA-256 changed: ${bundlePath}`);

    const destination = resolve(ownedBundleRoot, ...bundlePath.split("/"));
    assertContainedPath(ownedBundleRoot, destination, "derived bundle destination escaped its owned root");
    const destinationDirectory = dirname(destination);
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    assert.equal(await realpath(destinationDirectory), destinationDirectory, "derived bundle directory must be canonical");
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    const destinationInfo = await lstat(destination);
    assert.ok(destinationInfo.isFile() && !destinationInfo.isSymbolicLink(), `derived bundle copy must be a regular file: ${bundlePath}`);
    assert.equal(destinationInfo.uid, process.getuid(), "derived bundle copy owner must match this process");
    assert.equal(destinationInfo.mode & 0o777, 0o600, "derived public bundle files must be private mode 0600");
    const copiedBytes = await readFile(destination);
    assert.equal(copiedBytes.length, entry.size);
    assert.equal(hashBytes(copiedBytes), entry.sha256, `derived bundle copy SHA-256 mismatch: ${bundlePath}`);
    derivedFiles.push({ path: bundlePath, size: entry.size, sha256: entry.sha256 });
  }
  assert.equal(derivedFiles.length, BUNDLE_FILE_COUNT);
  assert.equal(hashJson(derivedFiles), BUNDLE_SHA256, "derived bundle file table changed its exporter aggregate");
  assert.equal(await verifyPinnedRegularFile(exportManifestPath, EXPORT_MANIFEST_SHA256), exportManifestSha256,
    "schema-2 export manifest changed while deriving the local reuse view");
  assert.equal(await verifyPinnedRegularFile(exportProvenancePath, EXPORT_PROVENANCE_SHA256), exportProvenanceSha256,
    "exporter provenance changed while deriving the local reuse view");

  const manifestPath = context.pathInArtifacts("home-sessions-lease3-derived-reuse-manifest.json");
  const reuseManifest = {
    schemaVersion: 1,
    purpose: "derived local schema-1 view from the immutable schema-2 export bundle; original exporter manifest and bundle remain unchanged",
    sourceCommit: null,
    sourceTreeSha256: SOURCE_TREE_SHA256,
    bundleSha256: BUNDLE_SHA256,
    bundleFileCount: BUNDLE_FILE_COUNT,
    indexHtmlSha256: exportManifest.indexHtmlSha256,
    directory: relative(context.runRoot, ownedBundleRoot).split(sep).join("/"),
    files: derivedFiles,
  };
  const writtenManifestPath = await context.writeArtifactJson("home-sessions-lease3-derived-reuse-manifest.json", reuseManifest);
  assert.equal(writtenManifestPath, manifestPath, "RunContext wrote the derived adapter at an unexpected path");
  const manifestBytes = await readFile(manifestPath);
  const parsedManifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.deepEqual(Object.keys(parsedManifest), [
    "schemaVersion", "purpose", "sourceCommit", "sourceTreeSha256", "bundleSha256", "bundleFileCount", "indexHtmlSha256", "directory", "files",
  ], "derived schema-1 manifest must exactly match the strict public reuse-helper input contract");
  assert.equal(hashJson(parsedManifest.files), BUNDLE_SHA256);
  return {
    bundleRoot: ownedBundleRoot,
    manifestPath,
    manifestSha256: hashBytes(manifestBytes),
    sourceExportManifestSha256: exportManifestSha256,
    sourceExportProvenanceSha256: exportProvenanceSha256,
    copiedFileCount: derivedFiles.length,
  };
}

async function verifyFrozenGatewayRuntimeSnapshot() {
  const gateway = await resolveExistingPrivateGatewaySnapshot(repoRoot, GATEWAY_RUNTIME_RELATIVE_ROOT);
  const expectedRoot = resolve(repoRoot, GATEWAY_RUNTIME_RELATIVE_ROOT);
  assert.equal(gateway.snapshotRoot, expectedRoot, "approved C22 Gateway snapshot root changed");
  assert.equal(await realpath(gateway.snapshotRoot), gateway.snapshotRoot, "approved C22 Gateway snapshot must be canonical");
  assert.equal(await realpath(gateway.manifestPath), gateway.manifestPath, "Gateway freeze manifest must be canonical");
  const manifestBytes = await readFile(gateway.manifestPath);
  const manifestSha256 = hashBytes(manifestBytes);
  assert.equal(manifestSha256, GATEWAY_RUNTIME_MANIFEST_SHA256, "approved C22 Gateway freeze manifest changed");
  const manifest = gateway.manifest;
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.sourceRoot, "apps/kcoder-studio");
  assert.equal(manifest.sourceFiles.length, GATEWAY_SOURCE_FILE_COUNT);
  assert.equal(manifest.sourceTreeSha256, GATEWAY_SOURCE_TREE_SHA256);
  assert.equal(manifest.dependencyFiles.length, GATEWAY_DEPENDENCY_FILE_COUNT);
  assert.equal(manifest.dependencyTreeSha256, GATEWAY_DEPENDENCY_TREE_SHA256);
  assert.equal(manifest.dependencyFiles.filter(row => Object.hasOwn(row, "symlinkTarget")).length, GATEWAY_DEPENDENCY_SYMLINK_COUNT);

  const dependencyLinkPath = resolve(gateway.snapshotRoot, "node_modules");
  const dependencyLinkInfo = await lstat(dependencyLinkPath);
  assert.ok(dependencyLinkInfo.isSymbolicLink(), "C22 Gateway node_modules must use its manifest-declared dependency link");
  assert.equal(manifest.dependencySourceRoot, GATEWAY_DEPENDENCY_SOURCE_RELATIVE_ROOT,
    "C22 Gateway dependency source root changed from the approved frozen closure");
  const dependencyRootDeclaredByManifest = resolve(repoRoot, manifest.dependencySourceRoot);
  const dependencyLinkTarget = await readlink(dependencyLinkPath);
  assert.equal(dependencyLinkTarget, dependencyRootDeclaredByManifest,
    "C22 Gateway node_modules link differs from its exact manifest-declared target");
  const dependencyRoot = await realpath(dependencyLinkPath);
  assert.equal(dependencyRoot, dependencyRootDeclaredByManifest,
    "C22 Gateway node_modules did not resolve to its manifest-declared dependency closure");
  assert.equal(await realpath(dependencyRoot), dependencyRoot, "manifest-declared Gateway dependency root must be canonical");
  assertContainedPath(resolve(repoRoot, "target/private-phone-ux-implementation"), dependencyRoot,
    "manifest-declared Gateway dependency closure escaped the approved private root");
  const dependencyRootInfo = await lstat(dependencyRoot);
  assert.ok(dependencyRootInfo.isDirectory() && !dependencyRootInfo.isSymbolicLink(),
    "manifest-declared Gateway dependency target must be a regular directory");
  const runtimeInputs = manifest.runtimeInputs;
  assert.equal(runtimeInputs.nodeVersion, process.version, "frozen Gateway Node version differs from this pinned test runner");
  assert.equal(resolve(runtimeInputs.nodeExecutable), resolve(process.execPath), "frozen Gateway Node executable differs from this pinned test runner");
  assert.equal(manifest.nodeVersion, process.version);
  assert.equal(resolve(manifest.nodeExecutable), resolve(process.execPath));
  const binaryPath = resolve(repoRoot, GATEWAY_BINARY_RELATIVE_PATH);
  assert.equal(runtimeInputs.kcoderBinaryPath, binaryPath, "frozen Gateway binary path changed");
  assert.equal(manifest.kcoderBinaryPath, binaryPath, "top-level Gateway binary path changed");
  assert.equal(runtimeInputs.kcoderBinarySha256, GATEWAY_BINARY_SHA256, "frozen Gateway binary digest metadata changed");
  const binaryStat = await lstat(binaryPath);
  assert.ok(binaryStat.isFile() && !binaryStat.isSymbolicLink(), "pinned mock Gateway binary must be a regular file");
  const binaryIdentity = { size: binaryStat.size, mtimeMs: binaryStat.mtimeMs, dev: binaryStat.dev, ino: binaryStat.ino };
  const devServerRows = manifest.sourceFiles.filter(row => row.path === "dev-server.mjs");
  assert.equal(devServerRows.length, 1, "C22 Gateway manifest must contain exactly one dev-server.mjs row");
  assert.equal(resolve(process.execPath), EXPECTED_NODE, "Gateway validator must use the fixed Node 22 executable");
  const verified = await validatePinnedGatewayRuntime({
    snapshotRelativePath: GATEWAY_RUNTIME_RELATIVE_ROOT,
    expectedManifestSha256: GATEWAY_RUNTIME_MANIFEST_SHA256,
    expectedSourceTreeSha256: GATEWAY_SOURCE_TREE_SHA256,
    expectedDependencyTreeSha256: GATEWAY_DEPENDENCY_TREE_SHA256,
    expectedDevServerSha256: devServerRows[0].sha256,
    expectedBinaryPath: GATEWAY_BINARY_RELATIVE_PATH,
    expectedBinarySha256: GATEWAY_BINARY_SHA256,
    expectedNodeVersion: process.version,
  });
  assert.equal(verified.root, gateway.snapshotRoot, "pinned Gateway validator resolved another source root");
  assert.equal(verified.manifestSha256, manifestSha256, "pinned Gateway validator read another manifest");
  const binaryStatAfterHash = await lstat(binaryPath);
  assert.deepEqual(
    { size: binaryStatAfterHash.size, mtimeMs: binaryStatAfterHash.mtimeMs, dev: binaryStatAfterHash.dev, ino: binaryStatAfterHash.ino },
    binaryIdentity,
    "pinned Gateway binary identity changed while it was verified",
  );

  return {
    snapshotRoot: verified.root,
    manifestSha256: verified.manifestSha256,
    manifest,
    fileCount: manifest.sourceFiles.length,
    sourceTreeSha256: verified.sourceTreeSha256,
    files: manifest.sourceFiles,
    dependencyFileCount: manifest.dependencyFiles.length,
    dependencyTreeSha256: verified.dependencyTreeSha256,
    dependencyLinkPath,
    dependencyLinkTarget,
    dependencyRoot,
    dependencySourceRoot: manifest.dependencySourceRoot,
    dependencyFiles: manifest.dependencyFiles,
    symlinkCount: GATEWAY_DEPENDENCY_SYMLINK_COUNT,
    nodeExecutable: verified.nodeExecutable,
    nodeVersion: verified.nodeVersion,
    binaryPath: verified.binaryPath,
    binarySha256: verified.binarySha256,
    binaryIdentity,
  };
}

async function observeLiveGatewayCheckout() {
  const relativePath = "apps/kcoder-studio/dev-server.mjs";
  const file = resolve(repoRoot, relativePath);
  assert.equal(await realpath(file), file, "non-execution live Gateway observation must be canonical");
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "non-execution live Gateway observation must be a regular file");
  const bytes = await readFile(file);
  assert.equal(bytes.length, info.size);
  return { relativePath, size: bytes.length, sha256: hashBytes(bytes), classification: "observed-only-not-executed" };
}

async function verifyGatewaySourceFreeze(observedFiles) {
  const beforePath = resolve(repoRoot, GATEWAY_SOURCE_BEFORE_MANIFEST_PATH);
  const currentPath = resolve(repoRoot, GATEWAY_SOURCE_MANIFEST_PATH);
  const deltaPath = resolve(repoRoot, GATEWAY_SOURCE_DELTA_PATH);
  const [beforeManifestSha256, currentManifestSha256, deltaSha256] = await Promise.all([
    verifyPinnedRegularFile(beforePath, GATEWAY_SOURCE_BEFORE_MANIFEST_SHA256),
    verifyPinnedRegularFile(currentPath, GATEWAY_SOURCE_MANIFEST_SHA256),
    verifyPinnedRegularFile(deltaPath, GATEWAY_SOURCE_DELTA_SHA256),
  ]);
  const [beforeManifest, currentManifest, delta] = await Promise.all([
    readJson(beforePath), readJson(currentPath), readJson(deltaPath),
  ]);
  assert.equal(beforeManifest.status, "reconstructed-prior-approved-source-closure");
  assert.equal(beforeManifest.sourceRoot, "apps/kcoder-studio");
  assert.equal(beforeManifest.priorCandidateSourceTreeSha256, "05a2aae8022ea1044e75d648a186c330ef5acd721007385268161664dd3403ea");
  assert.equal(beforeManifest.fileCount, GATEWAY_SOURCE_FILE_COUNT);
  assert.equal(currentManifest.status, "current-c22-source-closure");
  assert.equal(currentManifest.sourceRoot, "apps/kcoder-studio");
  assert.equal(currentManifest.fileCount, GATEWAY_SOURCE_FILE_COUNT);
  assert.equal(currentManifest.sourceTreeSha256, GATEWAY_SOURCE_TREE_SHA256);
  assert.deepEqual(observedFiles, currentManifest.files, "executed frozen Gateway source does not match the C22 source manifest");
  assert.equal(delta.before.sourceTreeSha256, beforeManifest.priorCandidateSourceTreeSha256);
  assert.equal(delta.after.sourceTreeSha256, currentManifest.sourceTreeSha256);
  assert.deepEqual(delta.changes.map(change => change.path).sort(), [
    "src/retention-context.js",
    "src/workspace-app-server-broker.js",
  ]);
  const beforeByPath = new Map(beforeManifest.files.map(file => [file.path, file]));
  const currentByPath = new Map(currentManifest.files.map(file => [file.path, file]));
  const observedDelta = [...currentByPath.values()].filter(file => {
    const before = beforeByPath.get(file.path);
    return !before || before.size !== file.size || before.sha256 !== file.sha256;
  }).map(file => ({
    path: file.path,
    before: beforeByPath.has(file.path)
      ? { size: beforeByPath.get(file.path).size, sha256: beforeByPath.get(file.path).sha256 }
      : null,
    after: { size: file.size, sha256: file.sha256 },
  }));
  assert.deepEqual(delta.changes, observedDelta, "C22 file-level source delta changed");
  return { beforeManifest, currentManifest, delta, beforeManifestSha256, currentManifestSha256, deltaSha256 };
}

function assertSafeMobileBundlePath(value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 1024, "bundle path is invalid");
  assert.ok(!value.startsWith("/") && !value.includes("\\") && !value.includes("\0"), "bundle path must be relative and platform-neutral");
  const parts = value.split("/");
  assert.ok(parts.every(part => part && part !== "." && part !== ".." && !/[\u0000-\u001f\u007f]/.test(part)), "bundle path contains an unsafe segment");
  assert.ok(parts.every(part => !part.includes(":")), "bundle path contains a platform-specific separator");
  const lowerParts = parts.map(part => part.toLowerCase());
  assert.ok(!lowerParts.some(part => /^\.env(?:$|[._-])/.test(part)), "public bundle cannot contain environment files");
  assert.ok(!lowerParts.some(part => [".npmrc", ".netrc"].includes(part)), "public bundle cannot contain network credential files");
  assert.ok(!lowerParts.some(part => /(?:^|[._-])(?:credential|credentials|secret|secrets|token|tokens|privatekey|private-key|api[-_.]?key|keys?)(?:[._-]|$)/.test(part)), "public bundle cannot contain secrets or keys");
  assert.ok(!lowerParts.some(part => /\.(?:pem|key|p12|pfx|keystore|jks)$/.test(part)), "public bundle cannot contain key material");
  const nodeModulesIndexes = lowerParts.flatMap((part, index) => part === "node_modules" ? [index] : []);
  if (nodeModulesIndexes.length) {
    const imageAsset = /\.(?:png|svg|webp|jpe?g|gif)$/i.test(value);
    assert.ok(parts[0] === "assets" && nodeModulesIndexes.length === 1 && nodeModulesIndexes[0] === 1 && imageAsset,
      "public bundle cannot contain node_modules except manifest-listed images");
  }
  return value;
}

function assertContainedPath(root, candidate, message) {
  const child = relative(resolve(root), resolve(candidate));
  assert.ok(child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child), message);
}

function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function hashJson(value) { return hashBytes(Buffer.from(JSON.stringify(value))); }

async function assertOwnedWorkspace(context, path) {
  const stateRoot = resolve(context.stateDir);
  const workspace = resolve(path);
  const relativePath = relative(stateRoot, workspace);
  assert.ok(relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
    "fixture workspace must remain inside this RunContext state");
  assert.equal(await realpath(workspace), workspace, "fixture workspace path must be canonical");
  const stat = await lstat(workspace);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "fixture workspace must be an owned directory");
  assert.equal(stat.uid, process.getuid(), "fixture workspace owner must match this test process");
  assert.equal(stat.mode & 0o077, 0, "fixture workspace must be private to its owner");
}

async function verifyFrozenSourceInputs() {
  const frozenRoot = resolve(repoRoot, SOURCE_FREEZE_RELATIVE_ROOT);
  const contentRoot = resolve(repoRoot, SOURCE_RELATIVE_CONTENT_ROOT);
  assert.equal(await realpath(frozenRoot), frozenRoot, "source freeze root must be canonical");
  assert.equal(await realpath(contentRoot), contentRoot, "source content root must be canonical");
  const metadataPath = resolve(repoRoot, SOURCE_RELATIVE_METADATA);
  const sourceMapPath = resolve(repoRoot, SOURCE_RELATIVE_MAP);
  const sourceManifestPath = resolve(repoRoot, SOURCE_RELATIVE_MANIFEST);
  const sourceMetadataSha256 = await verifyPinnedRegularFile(metadataPath, SOURCE_METADATA_SHA256);
  const sourceMapSha256 = await verifyPinnedRegularFile(sourceMapPath, SOURCE_MAP_SHA256);
  const sourceManifestSha256 = await verifyPinnedRegularFile(sourceManifestPath, SOURCE_MANIFEST_SHA256);
  const [metadata, sourceMap, sourceManifest] = await Promise.all([
    readJson(metadataPath), readJson(sourceMapPath), readJson(sourceManifestPath),
  ]);
  assert.equal(metadata.status, "CURRENT_SOURCE_FROZEN_FOR_STATIC_EXPORT");
  assert.equal(metadata.sourceDigest, SOURCE_TREE_SHA256);
  assert.equal(metadata.sourceFiles, SOURCE_FILE_COUNT);
  assert.equal(metadata.sha256MapSha256, SOURCE_MAP_SHA256);
  assert.equal(metadata.sourceManifestSha256, SOURCE_MANIFEST_SHA256);
  assert.equal(sourceManifest.status, "FROZEN_CURRENT_SOURCE_FOR_STATIC_WEB_EXPORT");
  assert.equal(sourceManifest.sourceDigest, SOURCE_TREE_SHA256);
  assert.equal(sourceManifest.fileCount, SOURCE_FILE_COUNT);
  assert.equal(sourceManifest.files.length, SOURCE_FILE_COUNT);
  assert.equal(Object.keys(sourceMap).length, SOURCE_FILE_COUNT);

  const manifestEntries = new Map(sourceManifest.files.map(entry => [entry.path, entry]));
  assert.equal(manifestEntries.size, SOURCE_FILE_COUNT, "source manifest paths must be unique");
  for (const [relativePath, expectedSha256] of Object.entries(sourceMap)) {
    const entry = manifestEntries.get(relativePath);
    assert.ok(entry, `source manifest is missing ${relativePath}`);
    assert.equal(entry.sha256, expectedSha256, `source map/manifest mismatch for ${relativePath}`);
    const file = resolve(contentRoot, relativePath);
    const withinRoot = relative(contentRoot, file);
    assert.ok(withinRoot && withinRoot !== ".." && !withinRoot.startsWith(`..${sep}`) && !isAbsolute(withinRoot),
      `frozen source path escaped its root: ${relativePath}`);
    assert.equal(await realpath(file), file, `frozen source path must be canonical: ${relativePath}`);
    const stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `frozen source must be a regular file: ${relativePath}`);
    assert.equal(stat.size, entry.size, `frozen source size changed: ${relativePath}`);
    const observedSha256 = createHash("sha256").update(await readFile(file)).digest("hex");
    assert.equal(observedSha256, expectedSha256, `frozen source bytes changed: ${relativePath}`);
  }
  return { sourceMetadataSha256, sourceMapSha256, sourceManifestSha256, sourceMap };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function summarizeGates(gates) {
  return Object.fromEntries(Object.entries(gates).map(([name, gate]) => [name, { held: gate.held, released: gate.released }]));
}

async function connectProfileFromLogin(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await visible(page, "welcome-direct-connection").click();
  await visible(page, "gateway-endpoint").fill(gateway.baseUrl);
  await visible(page, "gateway-token").fill(gateway.authToken);
  await visible(page, "gateway-connect").click();
  await visible(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function openDrawerSettings(page) {
  const menu = page.locator('[aria-label="打开任务列表"]:visible, [aria-label="打开导航"]:visible');
  await menu.first().click();
  const drawer = visible(page, "mobile-drawer");
  await drawer.waitFor({ state: "visible", timeout: 10_000 });
  await drawer.getByLabel("设置", { exact: true }).click();
}

async function clickAddGateway(page) {
  const label = (await page.locator("html").getAttribute("lang")) === "en" ? "Add Gateway" : "添加 Gateway";
  await page.getByText(label, { exact: true }).and(page.locator(":visible")).click();
}

async function switchToProfile(page, profile) {
  const prefix = (await page.locator("html").getAttribute("lang")) === "en" ? "Switch to" : "切换到";
  await page.getByLabel(`${prefix} ${profile.label}`, { exact: true }).and(page.locator(":visible")).click();
  await waitForStoredActiveProfile(page, profile.id);
}

async function readProfileIdentity(page, baseUrl) {
  const profile = await page.evaluate(({ key, expectedBaseUrl }) => {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null");
    const profiles = Array.isArray(raw) ? raw : raw?.profiles;
    if (!Array.isArray(profiles)) return null;
    const value = profiles.find(item => item?.baseUrl === expectedBaseUrl);
    return typeof value?.id === "string" && typeof value?.label === "string" ? { id: value.id, label: value.label } : null;
  }, { key: PROFILE_INDEX_KEY, expectedBaseUrl: baseUrl });
  assert.ok(profile, "the actual UI pairing must persist an owned profile identity");
  return profile;
}

async function waitForStoredActiveProfile(page, profileId) {
  await page.waitForFunction(({ key, expected }) => {
    try { return JSON.parse(localStorage.getItem(key) ?? "null")?.activeId === expected; }
    catch { return false; }
  }, { key: PROFILE_INDEX_KEY, expected: profileId }, { timeout: 15_000 });
}

async function waitForTaskRoute(page, profileId, serverId, threadId, cwd, title) {
  await waitFor(() => {
    try {
      const url = new URL(page.url());
      return url.pathname === `/h/${encodeURIComponent(profileId)}/task/${encodeURIComponent(serverId)}/${encodeURIComponent(threadId)}` &&
        url.searchParams.get("cwd") === cwd && url.searchParams.get("title") === title;
    } catch { return false; }
  }, 15_000, "exact Mobile task route profile/server/thread/cwd/title", 50);
}

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

async function captureActualSessionsTouchTargetCase(context, chromium, gatewayA, gatewayB, workspaceByTarget, caseSpec, referenceGeometry) {
  const { name: caseName, targetKind, styleOverride = null } = caseSpec;
  const caseRecord = {
    name: `actual-sessions-${caseName}`,
    targetMode: targetKind,
    diagnosticOnly: Boolean(styleOverride),
    status: "starting",
    stage: "new-page",
    geometry: null,
    geometryComparison: null,
    gates: {},
    rpcEvents: [],
    httpResponses: [],
    credentialHeaderObserved: false,
    pageErrors: 0,
    consoleErrors: 0,
    cleanup: { pageClosed: false, gatesReleased: false },
  };
  const phases = {
    current: "home-a-fast-first-peer-and-cursor-held",
    gates: {
      homeSlowDiscovery: deferredGate("diagnostic-home-slow-discovery"),
      homeFastCursor: deferredGate("diagnostic-home-fast-cursor"),
      sessionsSlowCursor: deferredGate("diagnostic-sessions-slow-cursor"),
      profileBFirstPage: deferredGate("diagnostic-profile-b-first-page"),
    },
  };
  const ledger = {
    events: [], droppedEvents: 0, droppedHttpEvents: 0, droppedHistoryReadCount: 0,
    malformedFrameCount: 0, unknownRpcResponseCount: 0, rejectedClientRpcCount: 0,
    rejectedServerFrameCount: 0, rejectedWebSocketCount: 0, foreignWebSocketBlockedCount: 0,
    foreignHttpBlockedCount: 0, foreignHttpResponseCount: 0, httpRouteCount: 0,
    httpRouteOverflowCount: 0, webSocketRouteOverflowCount: 0, webSocketRouteCount: 0,
    pendingRpcCount: 0, fixtureErrorCount: 0, rejectedClientMethods: [], http: [],
    gates: phases.gates,
    held: { homeSlowDiscovery: false, homeFastCursor: false, sessionsSlowCursor: false, profileBFirstPage: false },
    historyReadThreadIds: [],
  };
  const record = event => {
    if (ledger.events.length >= MAX_RPC_EVENTS) { ledger.droppedEvents += 1; return; }
    const phase = typeof event.phase === "string" ? event.phase : phases.current;
    const { phase: _capturedPhase, ...fields } = event;
    ledger.events.push({ atNodeMs: performance.now(), phase, ...fields });
  };
  const roleForOrigin = value => {
    let origin;
    try { origin = httpOrigin(value); } catch { return null; }
    if (origin === gatewayA.baseUrl) return "A";
    if (origin === gatewayB.baseUrl) return "B";
    return null;
  };
  let page = null;
  let stage = "new-page";
  try {
    page = await chromium.newPage(MOBILE_PAGE_OPTIONS);
    context.addCleanup(`close ${caseRecord.name} page`, async () => {
      if (!page.isClosed()) await page.close();
    });
    assert.deepEqual(page.viewportSize(), MOBILE_PAGE_OPTIONS.viewport, "diagnostic page must use the fixed Mobile viewport");
    const requestPhases = new WeakMap();
    await page.route("**/*", async route => {
      try {
        ledger.httpRouteCount += 1;
        if (ledger.httpRouteCount > 512) {
          ledger.httpRouteOverflowCount += 1;
          await route.abort("blockedbyclient");
          return;
        }
        const request = route.request();
        const url = new URL(request.url());
        const role = ["http:", "https:"].includes(url.protocol) ? roleForOrigin(url.origin) : null;
        const headers = request.headers();
        caseRecord.credentialHeaderObserved ||= Boolean(headers.authorization || headers.cookie);
        const requestOrigin = headers.origin;
        const originOwned = !requestOrigin || roleForOrigin(requestOrigin) !== null;
        if (!role || url.username || url.password || !originOwned) {
          ledger.foreignHttpBlockedCount += 1;
          record({ kind: "foreign-http-blocked", direction: "page-to-gateway", role: "foreign",
            reason: !originOwned ? "origin-not-owned" : "url-origin-not-owned",
            method: safeMethod(request.method()), path: safeObservedRequestPath(url.pathname) });
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      } catch {
        ledger.fixtureErrorCount += 1;
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    page.on("request", request => { requestPhases.set(request, phases.current); });
    page.on("response", response => {
      try {
        const url = new URL(response.url());
        const role = roleForOrigin(url.origin);
        if (!role) {
          ledger.foreignHttpResponseCount += 1;
          record({ phase: requestPhases.get(response.request()) ?? "unknown", kind: "foreign-http-response-observed",
            direction: "gateway-to-page", role: "foreign", method: safeMethod(response.request().method()),
            path: safeObservedRequestPath(url.pathname), status: response.status() });
          return;
        }
        if (!url.pathname.startsWith("/api/")) return;
        if (ledger.http.length >= MAX_HTTP_EVENTS) { ledger.droppedHttpEvents += 1; return; }
        ledger.http.push({ phase: requestPhases.get(response.request()) ?? "unknown", role,
          method: safeMethod(response.request().method()), path: safeApiPath(url.pathname), status: response.status() });
      } catch { ledger.droppedEvents += 1; }
    });
    page.on("pageerror", () => { caseRecord.pageErrors += 1; });
    page.on("console", message => { if (message.type() === "error") caseRecord.consoleErrors += 1; });
    await installRpcFixture(page, context, { gatewayA, gatewayB, roleForOrigin, phases, ledger, workspaceByTarget, record });

    stage = "profile-pairing";
    await connectProfileFromLogin(page, gatewayA);
    const profile = await readProfileIdentity(page, gatewayA.baseUrl);
    caseRecord.profileAlias = shortHash(profile.id);
    await waitFor(() => phases.gates.homeSlowDiscovery.held && phases.gates.homeFastCursor.held,
      30_000, "diagnostic Home bootstrap fast row plus held peer and cursor", 50, context.abortSignal);
    await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `thread-${THREAD_FIXTURES.homeFirst.id}`, THREAD_FIXTURES.homeFirst.title);
    phases.gates.homeFastCursor.release("complete");

    stage = "enter-sessions";
    phases.current = "sessions-a-first-pages-and-held-peer-cursor";
    await visible(page, "sessions").click();
    const list = visible(page, "sessions-list");
    await list.waitFor({ state: "visible", timeout: 30_000 });
    phases.gates.homeSlowDiscovery.release("complete");
    await visible(page, `session-${THREAD_FIXTURES.sessionsFastFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `session-${THREAD_FIXTURES.sessionsFastFirst.id}`, THREAD_FIXTURES.sessionsFastFirst.title);
    await visible(page, `session-${THREAD_FIXTURES.sessionsSlowFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `session-${THREAD_FIXTURES.sessionsSlowFirst.id}`, THREAD_FIXTURES.sessionsSlowFirst.title);
    const settled = await waitFor(async () => {
      const cursor = ledger.events.find(event => event.phase === phases.current && event.kind === "rpc-request" &&
        event.role === "A" && (event.server === "A-fast" || event.server === "A-slow") &&
        event.method === "thread/list" && event.hasCursor);
      if (cursor) return { status: "cursor-before-diagnostic-input" };
      const spinner = await visible(page, "sessions-page-loading").isVisible();
      return !spinner && ledger.pendingRpcCount === 0 ? { status: "settled", spinnerVisible: spinner } : false;
    }, 30_000, "Sessions first pages settle before the diagnostic touch", 50, context.abortSignal);
    caseRecord.initialSettle = settled;
    for (const server of ["A-fast", "A-slow"]) {
      const firstPage = ledger.events.find(event => event.phase === phases.current && event.kind === "rpc-response" &&
        event.role === "A" && event.server === server && event.method === "thread/list" && !event.hasCursor);
      if (!firstPage) throw new Error("Sessions default-page response was not observed");
    }

    stage = "measure-target-geometry";
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const rowTestId = "session-A_SESSIONS_FAST_3";
    const geometry = await readActualSessionsTouchTargetGeometry(page, rowTestId);
    caseRecord.geometry = geometry;
    if (referenceGeometry) {
      caseRecord.geometryComparison = compareActualSessionsTouchGeometry(referenceGeometry, geometry);
    }
    const geometryReady = geometry?.gates?.clipTargetFound === true && geometry?.gates?.sameRowGapFound === true &&
      (targetKind !== "icon-copy-gap" || geometry?.gates?.iconCopyGapFound === true);
    if (!geometryReady) throw new Error("Actual Sessions page did not expose the required measured touch target");

    stage = "dispatch-trusted-touch";
    await installSessionsTouchDiagnostics(page);
    const listHandle = visible(page, "sessions-list");
    await listHandle.evaluate(element => {
      const increment = name => {
        const current = Number(element.getAttribute(name) ?? "0");
        element.setAttribute(name, String(Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1));
      };
      for (const name of ["data-e2e-scroll-event-count", "data-e2e-trusted-scroll-event-count",
        "data-e2e-trusted-touchstart-count", "data-e2e-trusted-touchmove-count",
        "data-e2e-trusted-touchend-count", "data-e2e-trusted-touchcancel-count"]) element.setAttribute(name, "0");
      element.addEventListener("scroll", event => {
        increment("data-e2e-scroll-event-count");
        if (event.isTrusted) increment("data-e2e-trusted-scroll-event-count");
      }, { passive: true });
      for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
        element.addEventListener(type, event => {
          if (event.isTrusted) increment(`data-e2e-trusted-${type}-count`);
        }, { capture: true, passive: true });
      }
    });
    const before = await readSessionsScrollMetrics(listHandle);
    const targetPoint = targetKind === "clipped-text" ? geometry.clippedPoint
      : targetKind === "same-row-gap" ? geometry.gap?.point
      : targetKind === "icon-copy-gap" ? geometry.iconCopyGap?.point : null;
    const geometryPointValid = Number.isFinite(targetPoint?.x) && Number.isFinite(targetPoint?.y);
    caseRecord.input = {
      kind: "trusted-CDP-touch",
      geometryPointSource: targetKind === "clipped-text" ? "geometry.clippedPoint"
        : targetKind === "same-row-gap" ? "geometry.gap.point"
        : targetKind === "icon-copy-gap" ? "geometry.iconCopyGap.point" : "unknown-target-kind",
      geometryPointValid,
      geometryPoint: geometryPointValid ? { x: targetPoint.x, y: targetPoint.y } : null,
    };
    assert.equal(geometryPointValid, true, `${caseName} must provide a finite measured geometry point before dispatching touch`);
    const endPoint = { x: targetPoint.x, y: Math.max(Math.ceil(before.box.y + 24), targetPoint.y - 240) };
    const targetHitBeforeOverride = await readSessionsTouchHitTest(page, targetPoint.x, targetPoint.y);
    if (styleOverride) {
      stage = "apply-isolated-dom-style-diagnostic";
      caseRecord.styleOverride = await applyCausalStyleOverride(page, rowTestId, styleOverride);
      assert.equal(caseRecord.styleOverride?.status, "applied", `${caseName} isolated style override must identify its target`);
      assert.equal(caseRecord.styleOverride?.changed, true, `${caseName} isolated style override must change exactly the requested computed property`);
    }
    caseRecord.styleInterpretation = styleOverride
      ? "single-page DOM-only causal experiment; never product behavior evidence or a passing product gate"
      : "unmodified frozen Mobile bundle observation";
    caseRecord.preGestureState = await readPreGestureState(chromium.browser, page);
    const startHitTest = await readSessionsTouchHitTest(page, targetPoint.x, targetPoint.y);
    const endHitTest = await readSessionsTouchHitTest(page, endPoint.x, endPoint.y);
    const scrollChainBefore = startHitTest.scrollableAncestorChain;
    const inputCursor = await readSessionsTouchDiagnosticCursor(page);
    const gesture = { start: targetPoint, end: endPoint, moves: 12 };
    caseRecord.input = { ...caseRecord.input, gesture, targetHitBeforeOverride, startHitTest, endHitTest, inputCursor };
    const touchId = targetKind === "clipped-text" ? 201 : targetKind === "same-row-gap" ? 202 : 203;
    await dispatchTrustedTouchGesture(page, gesture, touchId, context.abortSignal);
    const after = await waitForStableSessionsScrollMetrics(page, listHandle, context.abortSignal);
    const inputDiagnostics = await readSessionsTouchDiagnosticDelta(page, inputCursor);
    const afterHitTest = await readSessionsTouchHitTest(page, targetPoint.x, targetPoint.y);
    const targetPointMatchesGeometry = targetKind === "clipped-text"
      ? targetPoint.hitMatchesClippedTarget
      : targetKind === "same-row-gap" ? targetPoint.hitWithinSameRow && targetPoint.hitNotClippedTarget
      : targetKind === "icon-copy-gap" ? targetPoint.hitMatchesIconCopyGap
        : false;
    const trustedTouchSequence = inputDiagnostics.touchEvents.some(event => event.type === "touchstart" && event.trusted) &&
      inputDiagnostics.touchEvents.some(event => event.type === "touchmove" && event.trusted) &&
      inputDiagnostics.touchEvents.some(event => event.type === "touchend" && event.trusted);
    caseRecord.observation = {
      before,
      after,
      scrollChainBefore,
      scrollChainAfter: afterHitTest.scrollableAncestorChain,
      afterHitTest,
      inputDiagnostics,
      scrollTopDelta: after.scrollTop - before.scrollTop,
      scrollEventDelta: after.scrollEventCount - before.scrollEventCount,
      defaultPreventedCaptureCount: inputDiagnostics.touchEvents.filter(event => event.phase === "capture" && event.defaultPrevented).length,
      defaultPreventedBubbleCount: inputDiagnostics.touchEvents.filter(event => event.phase === "bubble" && event.defaultPrevented).length,
      touchCancelCount: inputDiagnostics.touchEvents.filter(event => event.type === "touchcancel" && event.trusted).length,
      pointerCancelCount: inputDiagnostics.pointerEvents.filter(event => event.type === "pointercancel" && event.trusted).length,
      rawTouchScrollMoved: after.scrollTop > before.scrollTop && after.scrollEventCount > before.scrollEventCount,
    };
    if (caseSpec.samePageRnwTouchControlBuild && targetKind === "clipped-text" && !styleOverride) {
      caseRecord.samePageRnwTouchControl = await measureSamePageRnwTouchControl(
        context, page, caseSpec.samePageRnwTouchControlBuild, before, targetPoint, endPoint, gatewayA.baseUrl,
      );
    }
    caseRecord.gates = {
      exactOwnedPageOrigin: ledger.foreignHttpBlockedCount === 0 && ledger.foreignWebSocketBlockedCount === 0 && ledger.rejectedWebSocketCount === 0,
      fixedMobileViewport: geometry.viewport.width === 390 && geometry.viewport.height === 844 && geometry.viewport.maxTouchPoints > 0,
      settledFirstPages: settled.status === "settled",
      actualScrollRange: before.scrollHeight > before.clientHeight,
      startPointWithinSessionsList: startHitTest.pointWithinScrollport && startHitTest.targetWithinScrollport && !startHitTest.modalOverlayAtPoint,
      endPointWithinSessionsList: endHitTest.pointWithinScrollport && endHitTest.targetWithinScrollport && !endHitTest.modalOverlayAtPoint,
      targetClassMatchesCase: targetPointMatchesGeometry,
      trustedTouchSequence,
      collectorsNotTruncated: inputDiagnostics.unavailable === false && inputDiagnostics.droppedTouchEvents === 0 &&
        inputDiagnostics.droppedPointerEvents === 0 && inputDiagnostics.droppedScrollEvents === 0 && ledger.droppedEvents === 0 && ledger.droppedHttpEvents === 0,
      rpcLedgerHealthy: ledger.fixtureErrorCount === 0 && ledger.rejectedClientRpcCount === 0 && ledger.rejectedServerFrameCount === 0 &&
        ledger.rejectedWebSocketCount === 0 && ledger.foreignWebSocketBlockedCount === 0 && ledger.unknownRpcResponseCount === 0 && ledger.pendingRpcCount === 0,
    };
    caseRecord.rpcEvents = ledger.events;
    caseRecord.httpResponses = ledger.http;
    caseRecord.pageErrors = caseRecord.pageErrors;
    caseRecord.fixtureCounts = {
      pendingRpcCount: ledger.pendingRpcCount,
      fixtureErrorCount: ledger.fixtureErrorCount,
      rejectedClientRpcCount: ledger.rejectedClientRpcCount,
      malformedFrameCount: ledger.malformedFrameCount,
      unknownRpcResponseCount: ledger.unknownRpcResponseCount,
      droppedEvents: ledger.droppedEvents,
      droppedHttpEvents: ledger.droppedHttpEvents,
    };
    caseRecord.status = "observed";
    stage = "complete";
    caseRecord.stage = stage;
  } catch (error) {
    caseRecord.status = "error";
    caseRecord.errorName = safeErrorName(error);
    caseRecord.errorStage = stage;
    caseRecord.stage = stage;
    caseRecord.rpcEvents = ledger.events;
    caseRecord.httpResponses = ledger.http;
    caseRecord.fixtureCounts = {
      pendingRpcCount: ledger.pendingRpcCount,
      fixtureErrorCount: ledger.fixtureErrorCount,
      rejectedClientRpcCount: ledger.rejectedClientRpcCount,
      malformedFrameCount: ledger.malformedFrameCount,
      unknownRpcResponseCount: ledger.unknownRpcResponseCount,
      droppedEvents: ledger.droppedEvents,
      droppedHttpEvents: ledger.droppedHttpEvents,
    };
  } finally {
    for (const [name, gate] of Object.entries(phases.gates)) gate.release("complete");
    caseRecord.cleanup.gatesReleased = true;
    if (page && !page.isClosed()) {
      try { await page.close(); caseRecord.cleanup.pageClosed = true; }
      catch { caseRecord.cleanup.pageCloseError = true; }
    } else if (page) caseRecord.cleanup.pageClosed = true;
  }
  await context.writeArtifactJson(`mobile-home-sessions-after339-${caseName}-raw.json`, caseRecord);
  return caseRecord;
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

async function readActualSessionsTouchTargetGeometry(page, rowTestId) {
  return page.evaluate(({ rowTestId }) => {
    const list = document.querySelector('[data-testid="sessions-list"]');
    const row = document.querySelector(`[data-testid="${rowTestId}"]`);
    const describe = element => {
      if (!(element instanceof Element)) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className.slice(0, 160) : null,
        testId: element.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        box: { x: rect.x, y: rect.y, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        overflowX: style.overflowX, overflowY: style.overflowY, touchAction: style.touchAction,
        pointerEvents: style.pointerEvents, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth, clientHeight: element.clientHeight,
      };
    };
    if (!list || !row) return { rowTestId, gates: { listFound: Boolean(list), rowFound: Boolean(row) } };
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const clipped = [...row.querySelectorAll("*")].map(element => ({ element, measured: describe(element) }))
      .filter(item => item.measured.box.height > 0 && item.measured.box.height <= 12 && item.measured.box.width >= 80 &&
        (item.measured.overflowX === "hidden" || item.measured.overflowY === "hidden"))
      .sort((left, right) => right.measured.box.width - left.measured.box.width)[0] ?? null;
    let gap = null;
    if (clipped) {
      const clip = clipped.element;
      const clipRect = clip.getBoundingClientRect();
      const centerY = clipRect.top + clipRect.height / 2;
      for (let branch = clip; branch && branch !== row && !gap; branch = branch.parentElement) {
        const branchRect = branch.getBoundingClientRect();
        const siblings = [...(branch.parentElement?.children ?? [])]
          .filter(sibling => sibling !== branch)
          .map(sibling => ({ sibling, rect: sibling.getBoundingClientRect() }))
          .filter(item => centerY >= item.rect.top && centerY < item.rect.bottom);
        const leftSibling = siblings.filter(item => item.rect.right <= branchRect.left + 1)
          .sort((left, right) => right.rect.right - left.rect.right)[0];
        const rightSibling = siblings.filter(item => item.rect.left >= branchRect.right - 1)
          .sort((left, right) => left.rect.left - right.rect.left)[0];
        if (leftSibling && branchRect.left > leftSibling.rect.right) {
          gap = { x: Math.round((leftSibling.rect.right + branchRect.left) / 2), y: Math.round(centerY),
            left: leftSibling.rect.right, right: branchRect.left, branch: describe(branch), leftSibling: describe(leftSibling.sibling),
            parent: describe(branch.parentElement) };
        } else if (rightSibling && rightSibling.rect.left > branchRect.right) {
          gap = { x: Math.round((branchRect.right + rightSibling.rect.left) / 2), y: Math.round(centerY),
            left: branchRect.right, right: rightSibling.rect.left, branch: describe(branch), rightSibling: describe(rightSibling.sibling),
            parent: describe(branch.parentElement) };
        }
      }
    }
    const clippedPoint = clipped ? { x: Math.round(clipped.measured.box.x + clipped.measured.box.width / 2),
      y: Math.round(clipped.measured.box.y + clipped.measured.box.height / 2) } : null;
    const clippedHit = clippedPoint ? document.elementFromPoint(clippedPoint.x, clippedPoint.y) : null;
    const gapHit = gap ? document.elementFromPoint(gap.x, gap.y) : null;
    const clippedContainsHit = Boolean(clipped && clippedHit && (clipped.element === clippedHit || clipped.element.contains(clippedHit)));
    const gapWithinRow = Boolean(gapHit && row.contains(gapHit));
    const gapOutsideClip = Boolean(gapHit && clipped && !(clipped.element === gapHit || clipped.element.contains(gapHit)));
    const rowAncestor = clipped?.element.closest("[role=button],button,[data-testid]") ?? null;
    const clippedPointWithHit = clippedPoint ? { ...clippedPoint, hitTag: clippedHit?.tagName ?? null, hitClassName: typeof clippedHit?.className === "string" ? clippedHit.className.slice(0, 160) : null,
      hitWithinRow: Boolean(clippedHit && row.contains(clippedHit)), hitMatchesClippedTarget: clippedContainsHit } : null;
    const gapPoint = gap ? { x: gap.x, y: gap.y, hitTag: gapHit?.tagName ?? null, hitClassName: typeof gapHit?.className === "string" ? gapHit.className.slice(0, 160) : null,
      hitWithinSameRow: gapWithinRow, hitNotClippedTarget: gapOutsideClip } : null;
    let iconCopyGap = null;
    if (clipped) {
      const rowChildren = [...row.children];
      const copyBranchIndex = rowChildren.findIndex(child => child === clipped.element || child.contains(clipped.element));
      const copyBranch = copyBranchIndex >= 0 ? rowChildren[copyBranchIndex] : null;
      const iconBranch = copyBranchIndex > 0 ? rowChildren[copyBranchIndex - 1] : null;
      const iconRect = iconBranch?.getBoundingClientRect() ?? null;
      const copyRect = copyBranch?.getBoundingClientRect() ?? null;
      const y = Math.round(clipped.element.getBoundingClientRect().top + clipped.element.getBoundingClientRect().height / 2);
      if (iconRect && copyRect && iconRect.right < copyRect.left && y >= iconRect.top && y < iconRect.bottom && y >= copyRect.top && y < copyRect.bottom) {
        const left = iconRect.right;
        const right = copyRect.left;
        const x = Math.round((left + right) / 2);
        const pointHit = document.elementFromPoint(x, y);
        const pointStack = document.elementsFromPoint(x, y).slice(0, 8);
        const pointAncestorChain = [];
        for (let node = pointHit; node && pointAncestorChain.length < 16; node = node.parentElement) {
          pointAncestorChain.push(describe(node));
          if (node === row) break;
        }
        iconCopyGap = {
          geometry: { left, right, y, width: right - left, midpointX: x },
          point: {
            x, y,
            hitTag: pointHit?.tagName ?? null,
            hitClassName: typeof pointHit?.className === "string" ? pointHit.className.slice(0, 160) : null,
            hitWithinSameRow: Boolean(pointHit && row.contains(pointHit)),
            hitNotClippedTarget: Boolean(pointHit && !(clipped.element === pointHit || clipped.element.contains(pointHit))),
            hitMatchesIconCopyGap: Boolean(pointHit && row.contains(pointHit) && x > left && x < right),
          },
          iconBranch: describe(iconBranch),
          copyBranch: describe(copyBranch),
          hitStack: pointStack.map(describe),
          hitAncestorChain: pointAncestorChain,
        };
      }
    }
    const clipAncestorChain = [];
    for (let node = clipped?.element ?? null; node && clipAncestorChain.length < 20; node = node.parentElement) {
      clipAncestorChain.push(describe(node));
      if (node === list) break;
    }
    const stack = clippedPoint ? document.elementsFromPoint(clippedPoint.x, clippedPoint.y).slice(0, 6).map(describe) : [];
    return {
      rowTestId,
      viewport: { width: innerWidth, height: innerHeight, maxTouchPoints: Number(navigator.maxTouchPoints) || 0 },
      scrollport: describe(list),
      row: describe(row),
      rowAncestor: describe(rowAncestor),
      clippedTarget: clipped?.measured ?? null,
      clippedPoint: clippedPointWithHit,
      gap: gap ? { geometry: { x: gap.x, y: gap.y, left: gap.left, right: gap.right }, point: gapPoint,
        branch: gap.branch, leftSibling: gap.leftSibling ?? null, rightSibling: gap.rightSibling ?? null, parent: gap.parent } : null,
      iconCopyGap,
      clipAncestorChain,
      clippedHitStack: stack,
      gates: {
        listFound: true,
        rowFound: true,
        rowIntersectsScrollport: rowRect.bottom > listRect.top && rowRect.top < listRect.bottom,
        clipTargetFound: Boolean(clipped && clippedPoint && clippedContainsHit && row.contains(clipped.element)),
        clipTargetIsOverflowHidden: Boolean(clipped && (clipped.measured.overflowX === "hidden" || clipped.measured.overflowY === "hidden")),
        sameRowGapFound: Boolean(gap && gapHit && gapWithinRow && gapOutsideClip && rowAncestor && rowAncestor.contains(gapHit)),
        iconCopyGapFound: Boolean(iconCopyGap?.point?.hitMatchesIconCopyGap && iconCopyGap?.geometry?.width > 0),
      },
    };
  }, { rowTestId });
}

async function applyCausalStyleOverride(page, rowTestId, override) {
  const allowed = new Set([
    "row|touch-action|auto",
    "clip|overflow-y|visible",
  ]);
  const key = `${override?.target}|${override?.property}|${override?.value}`;
  if (!allowed.has(key)) throw new Error("unsupported private causal style override");
  return page.evaluate(({ rowTestId, override }) => {
    const row = document.querySelector(`[data-testid="${rowTestId}"]`);
    if (!row) return { status: "unavailable", reason: "row-not-found" };
    let target = row;
    if (override.target === "clip") {
      const candidates = [...row.querySelectorAll("*")].map(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { element, rect, style };
      }).filter(item => item.rect.height > 0 && item.rect.height <= 12 && item.rect.width >= 80 &&
        (item.style.overflowX === "hidden" || item.style.overflowY === "hidden"))
        .sort((left, right) => right.rect.width - left.rect.width);
      target = candidates[0]?.element ?? null;
    }
    if (!(target instanceof Element)) return { status: "unavailable", reason: "target-not-found" };
    const property = override.property;
    const before = getComputedStyle(target).getPropertyValue(property);
    const previousInlineValue = target.style.getPropertyValue(property);
    target.style.setProperty(property, override.value, "important");
    const after = getComputedStyle(target).getPropertyValue(property);
    const rect = target.getBoundingClientRect();
    return {
      status: "applied",
      diagnosticOnly: true,
      target: override.target,
      property,
      before,
      after,
      changed: before !== after,
      previousInlineValue: previousInlineValue.slice(0, 80),
      appliedValue: override.value,
      targetTag: target.tagName,
      targetClassName: typeof target.className === "string" ? target.className.slice(0, 120) : null,
      targetTestId: target.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
      targetBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }, { rowTestId, override });
}

async function readPreGestureState(browser, page) {
  const pageState = await page.evaluate(() => {
    const active = document.activeElement instanceof Element ? document.activeElement : null;
    const activeStyle = active ? getComputedStyle(active) : null;
    const activeRect = active ? active.getBoundingClientRect() : null;
    const visual = window.visualViewport;
    return {
      sampledAtPageMs: performance.now(),
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      activeElement: active ? {
        tag: active.tagName,
        role: active.getAttribute("role"),
        type: active instanceof HTMLInputElement ? active.type : null,
        testId: active.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        disabled: "disabled" in active ? Boolean(active.disabled) : null,
        readOnly: "readOnly" in active ? Boolean(active.readOnly) : null,
        contentEditable: active.isContentEditable,
        touchAction: activeStyle?.touchAction ?? null,
        box: activeRect ? { x: activeRect.x, y: activeRect.y, width: activeRect.width, height: activeRect.height } : null,
      } : null,
      viewport: { innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio },
      windowOffset: { scrollX: window.scrollX, scrollY: window.scrollY },
      visualViewport: visual ? {
        offsetLeft: visual.offsetLeft, offsetTop: visual.offsetTop,
        pageLeft: visual.pageLeft, pageTop: visual.pageTop,
        width: visual.width, height: visual.height, scale: visual.scale,
      } : null,
      documentScroll: {
        scrollTop: document.scrollingElement?.scrollTop ?? null,
        scrollHeight: document.scrollingElement?.scrollHeight ?? null,
        clientHeight: document.scrollingElement?.clientHeight ?? null,
      },
    };
  });
  let browserWindow = { status: "unavailable", reason: "not-read" };
  let session = null;
  try {
    session = await browser.newBrowserCDPSession();
    const pageUrl = page.url();
    const targetInfos = (await session.send("Target.getTargets")).targetInfos ?? [];
    const matches = targetInfos.filter(target => target.type === "page" && target.url === pageUrl);
    if (matches.length !== 1) {
      browserWindow = { status: "unavailable", reason: "current-page-target-not-unique", matchingPageCount: matches.length };
    } else {
      const result = await session.send("Browser.getWindowForTarget", { targetId: matches[0].targetId });
      const bounds = result?.bounds ?? {};
      const allowedStates = new Set(["normal", "minimized", "maximized", "fullscreen"]);
      browserWindow = {
        status: "observed",
        windowState: allowedStates.has(bounds.windowState) ? bounds.windowState : "unknown",
        bounds: {
          left: Number.isFinite(bounds.left) ? bounds.left : null,
          top: Number.isFinite(bounds.top) ? bounds.top : null,
          width: Number.isFinite(bounds.width) ? bounds.width : null,
          height: Number.isFinite(bounds.height) ? bounds.height : null,
        },
      };
    }
  } catch (error) {
    browserWindow = { status: "unavailable", reason: safeErrorName(error) };
  } finally {
    await session?.detach().catch(() => {});
  }
  return { sampledAtNodeMs: performance.now(), page: pageState, browserWindow };
}

function compareActualSessionsTouchGeometry(reference, current) {
  const close = (left, right) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 2;
  const checks = {
    sameViewport: reference?.viewport?.width === current?.viewport?.width && reference?.viewport?.height === current?.viewport?.height,
    sameScrollportBox: ["x", "y", "width", "height"].every(key => close(reference?.scrollport?.box?.[key], current?.scrollport?.box?.[key])),
    sameRowBox: ["x", "y", "width", "height"].every(key => close(reference?.row?.box?.[key], current?.row?.box?.[key])),
    sameClippedTargetBox: ["x", "y", "width", "height"].every(key => close(reference?.clippedTarget?.box?.[key], current?.clippedTarget?.box?.[key])),
    sameGapGeometry: close(reference?.gap?.geometry?.y, current?.gap?.geometry?.y) &&
      close(reference?.gap?.geometry?.left, current?.gap?.geometry?.left) && close(reference?.gap?.geometry?.right, current?.gap?.geometry?.right),
    sameIconCopyGapGeometry: close(reference?.iconCopyGap?.geometry?.y, current?.iconCopyGap?.geometry?.y) &&
      close(reference?.iconCopyGap?.geometry?.left, current?.iconCopyGap?.geometry?.left) &&
      close(reference?.iconCopyGap?.geometry?.right, current?.iconCopyGap?.geometry?.right),
  };
  return { checks, matchesClippedCase: Object.values(checks).every(Boolean), interpretation: "fresh-page comparison permits only the horizontal start target to differ" };
}

async function dispatchTrustedTouchGesture(page, gesture, id, signal) {
  if (signal?.aborted) throw signal.reason || new Error("Aborted before diagnostic trusted touch");
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: gesture.start.x, y: gesture.start.y, id }] });
    let ended = false;
    try {
      for (let move = 1; move <= gesture.moves; move += 1) {
        if (signal?.aborted) throw signal.reason || new Error("Aborted during diagnostic trusted touch");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
          x: gesture.start.x + ((gesture.end.x - gesture.start.x) * move) / gesture.moves,
          y: gesture.start.y + ((gesture.end.y - gesture.start.y) * move) / gesture.moves,
          id,
        }] });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      ended = true;
    } finally {
      if (!ended) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }).catch(() => {});
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function installSessionsTouchDiagnostics(page) {
  await page.evaluate(({ property, maxTouchEvents, maxPointerEvents, maxScrollEvents }) => {
    if (window[property]) throw new Error("Sessions touch diagnostic observer was installed more than once");
    const state = { nextTouchOrdinal: 0, touchEvents: [], droppedTouchEvents: 0,
      nextPointerOrdinal: 0, pointerEvents: [], droppedPointerEvents: 0,
      nextScrollOrdinal: 0, scrollEvents: [], droppedScrollEvents: 0 };
    const touchOrdinals = new WeakMap();
    const pointerOrdinals = new WeakMap();
    const targetInfo = event => {
      const target = event.target instanceof Element ? event.target : event.target === document ? document.scrollingElement : null;
      const box = target instanceof Element ? target.getBoundingClientRect() : null;
      const style = target instanceof Element ? getComputedStyle(target) : null;
      return {
        targetTag: target?.tagName ?? null,
        targetTestId: target instanceof Element ? target.closest("[data-testid]")?.getAttribute("data-testid") ?? null : null,
        targetClassName: target instanceof Element && typeof target.className === "string" ? target.className.slice(0, 120) : null,
        targetWithinSessions: target instanceof Element && Boolean(document.querySelector('[data-testid="sessions-list"]')?.contains(target)),
        targetBox: box ? { x: box.x, y: box.y, width: box.width, height: box.height, top: box.top, bottom: box.bottom } : null,
        scrollTop: target && "scrollTop" in target ? target.scrollTop : null,
        scrollLeft: target && "scrollLeft" in target ? target.scrollLeft : null,
        scrollHeight: target && "scrollHeight" in target ? target.scrollHeight : null,
        clientHeight: target && "clientHeight" in target ? target.clientHeight : null,
        scrollWidth: target && "scrollWidth" in target ? target.scrollWidth : null,
        clientWidth: target && "clientWidth" in target ? target.clientWidth : null,
        touchAction: style?.touchAction ?? null,
        overflowX: style?.overflowX ?? null,
        overflowY: style?.overflowY ?? null,
        overscrollBehaviorY: style?.overscrollBehaviorY ?? null,
        pointerType: typeof event.pointerType === "string" ? event.pointerType : null,
        pointerId: Number.isSafeInteger(event.pointerId) ? event.pointerId : null,
        isPrimary: typeof event.isPrimary === "boolean" ? event.isPrimary : null,
      };
    };
    const save = (name, droppedName, limit, value) => {
      const entries = state[name];
      if (entries.length >= limit) { state[droppedName] += 1; return; }
      entries.push(value);
    };
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      window.addEventListener(type, event => {
        const ordinal = ++state.nextTouchOrdinal;
        touchOrdinals.set(event, ordinal);
        save("touchEvents", "droppedTouchEvents", maxTouchEvents, {
          ordinal, type, phase: "capture", trusted: event.isTrusted,
          cancelable: event.cancelable, defaultPrevented: event.defaultPrevented, atPageMs: performance.now(), ...targetInfo(event),
        });
      }, { capture: true, passive: true });
      window.addEventListener(type, event => {
        const ordinal = touchOrdinals.get(event);
        if (ordinal === undefined) return;
        save("touchEvents", "droppedTouchEvents", maxTouchEvents, {
          ordinal, type, phase: "bubble", trusted: event.isTrusted,
          cancelable: event.cancelable, defaultPrevented: event.defaultPrevented, atPageMs: performance.now(), ...targetInfo(event),
        });
      }, { passive: true });
    }
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      window.addEventListener(type, event => {
        const ordinal = ++state.nextPointerOrdinal;
        pointerOrdinals.set(event, ordinal);
        save("pointerEvents", "droppedPointerEvents", maxPointerEvents, {
          ordinal, type, phase: "capture", trusted: event.isTrusted,
          cancelable: event.cancelable, defaultPrevented: event.defaultPrevented, atPageMs: performance.now(), ...targetInfo(event),
        });
      }, { capture: true, passive: true });
      window.addEventListener(type, event => {
        const ordinal = pointerOrdinals.get(event);
        if (ordinal === undefined) return;
        save("pointerEvents", "droppedPointerEvents", maxPointerEvents, {
          ordinal, type, phase: "bubble", trusted: event.isTrusted,
          cancelable: event.cancelable, defaultPrevented: event.defaultPrevented, atPageMs: performance.now(), ...targetInfo(event),
        });
      }, { passive: true });
    }
    window.addEventListener("scroll", event => {
      const ordinal = ++state.nextScrollOrdinal;
      save("scrollEvents", "droppedScrollEvents", maxScrollEvents, {
        ordinal, trusted: event.isTrusted, atPageMs: performance.now(), ...targetInfo(event),
      });
    }, { capture: true, passive: true });
    Object.defineProperty(window, property, { configurable: false, enumerable: false, value: state });
  }, { property: TOUCH_DIAGNOSTICS_PROPERTY, maxTouchEvents: MAX_TOUCH_DIAGNOSTIC_EVENTS,
    maxPointerEvents: MAX_POINTER_DIAGNOSTIC_EVENTS, maxScrollEvents: MAX_SCROLL_DIAGNOSTIC_EVENTS });
}

async function readSessionsTouchDiagnosticCursor(page) {
  return page.evaluate(property => {
    const state = window[property];
    return { touchOrdinal: state?.nextTouchOrdinal ?? 0, pointerOrdinal: state?.nextPointerOrdinal ?? 0,
      scrollOrdinal: state?.nextScrollOrdinal ?? 0 };
  }, TOUCH_DIAGNOSTICS_PROPERTY);
}

async function readSessionsTouchDiagnosticDelta(page, cursor) {
  return page.evaluate(({ property, after }) => {
    const state = window[property];
    if (!state) return { unavailable: true, touchEvents: [], pointerEvents: [], scrollEvents: [] };
    return {
      unavailable: false,
      touchEvents: state.touchEvents.filter(event => event.ordinal > after.touchOrdinal),
      pointerEvents: state.pointerEvents.filter(event => event.ordinal > after.pointerOrdinal),
      scrollEvents: state.scrollEvents.filter(event => event.ordinal > after.scrollOrdinal),
      droppedTouchEvents: state.droppedTouchEvents,
      droppedPointerEvents: state.droppedPointerEvents,
      droppedScrollEvents: state.droppedScrollEvents,
    };
  }, { property: TOUCH_DIAGNOSTICS_PROPERTY, after: cursor });
}

async function scrollListWithBrowserInput(page, list, ledger, signal) {
  await list.scrollIntoViewIfNeeded();
  await installSessionsTouchDiagnostics(page);
  await list.evaluate(element => {
    const increment = name => {
      const current = Number(element.getAttribute(name) ?? "0");
      element.setAttribute(name, String(Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1));
    };
    element.setAttribute("data-e2e-scroll-event-count", "0");
    element.setAttribute("data-e2e-trusted-scroll-event-count", "0");
    element.setAttribute("data-e2e-trusted-touchstart-count", "0");
    element.setAttribute("data-e2e-trusted-touchmove-count", "0");
    element.setAttribute("data-e2e-trusted-touchend-count", "0");
    element.setAttribute("data-e2e-trusted-touchcancel-count", "0");
    element.addEventListener("scroll", event => {
      increment("data-e2e-scroll-event-count");
      if (event.isTrusted) increment("data-e2e-trusted-scroll-event-count");
    }, { passive: true });
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      element.addEventListener(type, event => {
        if (event.isTrusted) increment(`data-e2e-trusted-${type}-count`);
      }, { capture: true, passive: true });
    }
  });
  const initial = await readSessionsScrollMetrics(list);
  ledger.sessionsScroll.initial = initial;
  assert.ok(initial.clientHeight > 0 && initial.scrollHeight > initial.clientHeight,
    "the actual Sessions list must have scrollable content before the user-input phase");
  assert.ok(initial.scrollTop <= 2, "the Sessions list must start at its top before the touch-input phase");
  const viewport = page.viewportSize();
  assert.ok(viewport && initial.box.x >= 0 && initial.box.y < viewport.height && initial.box.bottom > 0,
    "the actual Sessions scrollport must intersect the Browser viewport");
  const priorWheelCenter = {
    x: Math.round(initial.box.x + initial.box.width / 2),
    y: Math.round(initial.box.y + initial.box.height / 2),
  };
  ledger.sessionsScroll.priorWheelCoordinateReference = {
    priorRunCoordinate: priorWheelCenter,
    interpretation: "same geometric center point used by the failed prior wheel steps; this hit test is sampled in the current run, not reconstructed from the prior DOM",
    currentRunHitTest: await readSessionsTouchHitTest(page, priorWheelCenter.x, priorWheelCenter.y),
  };

  const slowLastRow = `session-A_SESSIONS_SLOW_7`;
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let index = 1; index <= MAX_SESSIONS_SCROLL_STEPS; index += 1) {
      if (signal?.aborted) throw signal.reason || new Error("Aborted while scrolling Sessions");
      const before = await readSessionsScrollMetrics(list);
      const box = before.box;
      const x = Math.round(box.x + box.width / 2);
      const startY = Math.round(box.y + box.height * 0.82);
      const endY = Math.round(box.y + box.height * 0.18);
      const [startHitTest, endHitTest] = await Promise.all([
        readSessionsTouchHitTest(page, x, startY),
        readSessionsTouchHitTest(page, x, endY),
      ]);
      const inputDiagnosticCursor = await readSessionsTouchDiagnosticCursor(page);
      const step = {
        index,
        inputBoundary: "trusted Chromium CDP Input.dispatchTouchEvent; no DOM scroll offset is written",
        touchStartIssuedNodeMs: null,
        before,
        start: { x, y: startY },
        end: { x, y: endY },
        pointCount: 14,
        startHitTest,
        endHitTest,
        after: null,
        trustedEventDelta: null,
        inputDiagnostics: null,
        lastRow: null,
      };
      ledger.sessionsScroll.steps.push(step);
      assert.equal(startHitTest.targetWithinScrollport, true,
        "the trusted touch must start on the actual Sessions scrollport, not an overlay or sibling");
      assert.equal(startHitTest.modalOverlayAtPoint, false,
        "the trusted touch point must not be covered by an active modal overlay");
      assert.equal(endHitTest.pointWithinScrollport, true,
        "the trusted touch path must end inside the same actual Sessions scrollport");
      assert.equal(endHitTest.targetWithinScrollport, true,
        "the trusted touch path must end on the actual Sessions scrollport, not an overlay or sibling");
      assert.equal(endHitTest.modalOverlayAtPoint, false,
        "the end of the trusted touch path must not be covered by an active modal overlay");

      const pointId = 81;
      step.touchStartIssuedNodeMs = performance.now();
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y: startY, id: pointId }],
      });
      let touchEnded = false;
      try {
        for (let move = 1; move <= 12; move += 1) {
          if (signal?.aborted) throw signal.reason || new Error("Aborted during trusted Sessions touch");
          const y = startY + ((endY - startY) * move) / 12;
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y, id: pointId }],
          });
          await page.waitForTimeout(16);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        touchEnded = true;
      } finally {
        if (!touchEnded) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }).catch(() => {});
      }
      const after = await waitForStableSessionsScrollMetrics(page, list, signal);
      const lastRow = await readRowWithinSessionsScrollport(page, list, slowLastRow);
      step.after = after;
      step.lastRow = lastRow;
      step.inputDiagnostics = await readSessionsTouchDiagnosticDelta(page, inputDiagnosticCursor);
      step.trustedEventDelta = {
        touchstart: after.trustedTouchStartCount - before.trustedTouchStartCount,
        touchmove: after.trustedTouchMoveCount - before.trustedTouchMoveCount,
        touchend: after.trustedTouchEndCount - before.trustedTouchEndCount,
        touchcancel: after.trustedTouchCancelCount - before.trustedTouchCancelCount,
        scroll: after.trustedScrollEventCount - before.trustedScrollEventCount,
      };
      step.trustedPointerEventDelta = Object.fromEntries(["pointerdown", "pointermove", "pointerup", "pointercancel"].map(type => [
        type, step.inputDiagnostics.pointerEvents.filter(event => event.type === type && event.trusted).length,
      ]));
      const nearBottom = after.scrollTop + after.clientHeight >= after.scrollHeight - 3;
      if (nearBottom && step.trustedEventDelta.touchstart > 0 && step.trustedEventDelta.touchmove > 0 &&
        step.trustedEventDelta.touchend > 0 && step.trustedEventDelta.scroll > 0 && after.scrollTop > before.scrollTop &&
        lastRow.rendered && lastRow.intersectsScrollport) {
        ledger.sessionsScroll.terminal = {
          status: "actual-bottom-and-last-row-rendered",
          nearBottom,
          observedTrustedTouchEvents: step.trustedEventDelta,
          observedScrollEvents: after.scrollEventCount,
          scrollTopDelta: after.scrollTop - before.scrollTop,
        };
        return ledger.sessionsScroll;
      }
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
  const final = ledger.sessionsScroll.steps.at(-1)?.after ?? initial;
  const lastRow = await readRowWithinSessionsScrollport(page, list, slowLastRow);
  ledger.sessionsScroll.terminal = { status: "scroll-step-bound-reached", nearBottom: final.scrollTop + final.clientHeight >= final.scrollHeight - 3,
    observedScrollEvents: final.scrollEventCount, lastRow };
  assert.fail("eight bounded trusted Mobile touch drags did not reach the actual Sessions list end with its last row rendered");
}

async function readSessionsTouchHitTest(page, x, y) {
  return page.evaluate(({ pointX, pointY }) => {
    const list = document.querySelector('[data-testid="sessions-list"]');
    if (!list) return { targetWithinScrollport: false, pointWithinScrollport: false, modalOverlayAtPoint: false, reason: "sessions-list-missing" };
    const rect = list.getBoundingClientRect();
    const pointWithinScrollport = pointX >= rect.left && pointX < rect.right && pointY >= rect.top && pointY < rect.bottom;
    const describe = element => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        testId: element.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        role: element.getAttribute("role"),
        className: typeof element.className === "string" ? element.className.slice(0, 120) : null,
        box: { x: box.x, y: box.y, width: box.width, height: box.height, top: box.top, bottom: box.bottom },
        display: style.display,
        cssHeight: style.height,
        minHeight: style.minHeight,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        boxSizing: style.boxSizing,
        pointerEvents: style.pointerEvents,
        touchAction: style.touchAction,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        overscrollBehaviorY: style.overscrollBehaviorY,
        scrollTop: element.scrollTop,
        scrollLeft: element.scrollLeft,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        position: style.position,
        withinScrollport: list.contains(element),
      };
    };
    const stack = document.elementsFromPoint(pointX, pointY).slice(0, 6);
    const target = stack[0] ?? null;
    const targetAncestorChain = [];
    for (let current = target; current && targetAncestorChain.length < 24; current = current.parentElement) {
      targetAncestorChain.push(describe(current));
    }
    const listStyle = getComputedStyle(list);
    const scrollableAncestorChain = targetAncestorChain.filter(node =>
      node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1 ||
      /^(auto|scroll|overlay)$/.test(node.overflowY) || /^(auto|scroll|overlay)$/.test(node.overflowX));
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      .filter(element => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 &&
          pointX >= box.left && pointX < box.right && pointY >= box.top && pointY < box.bottom;
      });
    return {
      point: { x: pointX, y: pointY },
      pointWithinScrollport,
      targetWithinScrollport: Boolean(target && list.contains(target)),
      modalOverlayAtPoint: dialogs.length > 0,
      scrollportStyle: {
        pointerEvents: listStyle.pointerEvents,
        touchAction: listStyle.touchAction,
        overflowX: listStyle.overflowX,
        overflowY: listStyle.overflowY,
        overscrollBehaviorY: listStyle.overscrollBehaviorY,
      },
      targetAncestorChain,
      scrollableAncestorChain,
      hitStack: stack.map(describe),
      modalHits: dialogs.slice(0, 4).map(describe),
    };
  }, { pointX: x, pointY: y });
}

async function readSessionsScrollMetrics(list) {
  return list.evaluate((element, diagnosticsProperty) => {
    const box = element.getBoundingClientRect();
    const describe = node => {
      if (!(node instanceof Element)) return null;
      const style = getComputedStyle(node);
      const nodeBox = node.getBoundingClientRect();
      return {
        tag: node.tagName,
        testId: node.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        isSessionsList: node === element,
        box: { x: nodeBox.x, y: nodeBox.y, width: nodeBox.width, height: nodeBox.height, top: nodeBox.top, bottom: nodeBox.bottom },
        display: style.display,
        heightCss: style.height,
        minHeightCss: style.minHeight,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        touchAction: style.touchAction,
        pointerEvents: style.pointerEvents,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        overscrollBehaviorX: style.overscrollBehaviorX,
        overscrollBehaviorY: style.overscrollBehaviorY,
        scrollTop: node.scrollTop,
        scrollLeft: node.scrollLeft,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      };
    };
    const ancestorChain = [];
    for (let node = element; node && ancestorChain.length < 32; node = node.parentElement) ancestorChain.push(node);
    const diagnostics = window[diagnosticsProperty];
    const documentScroller = document.scrollingElement;
    const visualViewport = window.visualViewport;
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollEventCount: Number(element.getAttribute("data-e2e-scroll-event-count") ?? "0"),
      trustedScrollEventCount: Number(element.getAttribute("data-e2e-trusted-scroll-event-count") ?? "0"),
      trustedTouchStartCount: Number(element.getAttribute("data-e2e-trusted-touchstart-count") ?? "0"),
      trustedTouchMoveCount: Number(element.getAttribute("data-e2e-trusted-touchmove-count") ?? "0"),
      trustedTouchEndCount: Number(element.getAttribute("data-e2e-trusted-touchend-count") ?? "0"),
      trustedTouchCancelCount: Number(element.getAttribute("data-e2e-trusted-touchcancel-count") ?? "0"),
      box: { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom },
      cssTouchActionChain: ancestorChain.map(describe),
      scrollableAncestorOffsets: ancestorChain
        .filter(node => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)
        .map(describe),
      documentScroll: {
        scrollingElement: describe(documentScroller),
        body: describe(document.body),
        windowOffset: { scrollX: window.scrollX, scrollY: window.scrollY },
        visualViewport: visualViewport ? {
          offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop,
          pageLeft: visualViewport.pageLeft, pageTop: visualViewport.pageTop,
          width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale,
        } : null,
      },
      inputDiagnosticCursor: {
        touchOrdinal: diagnostics?.nextTouchOrdinal ?? 0,
        pointerOrdinal: diagnostics?.nextPointerOrdinal ?? 0,
        scrollOrdinal: diagnostics?.nextScrollOrdinal ?? 0,
        droppedTouchEvents: diagnostics?.droppedTouchEvents ?? 0,
        droppedPointerEvents: diagnostics?.droppedPointerEvents ?? 0,
        droppedScrollEvents: diagnostics?.droppedScrollEvents ?? 0,
      },
    };
  }, TOUCH_DIAGNOSTICS_PROPERTY);
}

async function waitForStableSessionsScrollMetrics(page, list, signal) {
  let previous = await readSessionsScrollMetrics(list);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error("Aborted while waiting for the Sessions list to settle");
    await page.evaluate(() => new Promise(resolveFrame => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolveFrame))));
    const current = await readSessionsScrollMetrics(list);
    if (current.scrollTop === previous.scrollTop && current.scrollHeight === previous.scrollHeight &&
      current.clientHeight === previous.clientHeight && current.scrollEventCount === previous.scrollEventCount) return current;
    previous = current;
  }
  throw new Error("Sessions scroll metrics did not stabilize within eight animation frames after trusted touch input");
}

async function readRowWithinSessionsScrollport(page, list, testId) {
  const row = page.locator(`[data-testid="${testId}"]`);
  const count = await row.count();
  if (count !== 1) return { rendered: false, intersectsScrollport: false };
  return row.evaluate((element, listSelector) => {
    const scrollport = globalThis.document.querySelector(listSelector);
    if (!scrollport) return { rendered: true, intersectsScrollport: false };
    const item = element.getBoundingClientRect();
    const port = scrollport.getBoundingClientRect();
    return { rendered: true, intersectsScrollport: item.bottom > port.top && item.top < port.bottom };
  }, '[data-testid="sessions-list"]');
}

function mockServer(id, label, workspace) {
  return { id, label, runtime: "kcoder", transport: "local", command: process.execPath, workspace };
}

function threadSummary(id, title, cwd) {
  return { id, title, cwd, status: "idle", model: "mock-local", createdAt: 1, updatedAt: 2 };
}

function deferredGate(name) {
  let resolve;
  let released = false;
  const promise = new Promise(done => { resolve = done; });
  return {
    name,
    held: false,
    get released() { return released; },
    promise,
    release(value) { if (released) return; released = true; resolve(value); },
  };
}

function recordForGate(record, phase, kind, role, serverId, method, id) {
  record({ phase, kind, role, server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(method), requestIdFingerprint: shortHash(rpcKey(id)) });
}

function historyAlias(id) {
  if (id === "A_HOME_FIRST") return "A_HOME_FIRST";
  if (id === "A_SESSIONS_FAST_0") return "A_SESSIONS_FAST_0";
  if (id === "B_AFTER_SWITCH_FIRST") return "B_AFTER_SWITCH_FIRST";
  return "OTHER";
}

function safeApiPath(pathname) {
  if (pathname === "/api/servers" || pathname === "/api/servers/status" || pathname === "/api/mobile/session") return pathname;
  return "/api/<other>";
}

function safeObservedRequestPath(pathname) {
  return pathname.startsWith("/api/") ? safeApiPath(pathname) : "non-api";
}

function safeMethod(value) {
  return typeof value === "string" && /^[a-z][a-zA-Z0-9./_-]{0,63}$/.test(value) ? value : "other";
}

function rpcKey(value) { return `${typeof value}:${String(value)}`; }

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function httpOrigin(value) {
  const url = new URL(value);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  return url.origin;
}

function visible(page, testId) { return page.locator(`[data-testid="${testId}"]:visible`); }

async function assertRowAdvertisesTitle(page, testId, expectedTitle) {
  const text = await visible(page, testId).innerText();
  assert.ok(text.includes(expectedTitle), `${testId} must visibly advertise its fixture title`);
}

function assertSessionsSocketOrdinals(events) {
  const phase = "sessions-a-first-pages-and-held-peer-cursor";
  const result = {};
  for (const server of ["A-fast", "A-slow"]) {
    const base = event => event.kind === "rpc-request" && event.role === "A" && event.server === server;
    const firstPage = events.find(event => base(event) && event.phase === phase && event.method === "thread/list" && event.hasCursor === false);
    const cursorPage = events.find(event => base(event) && event.phase === phase && event.method === "thread/list" && event.hasCursor === true);
    assert.ok(firstPage, `${server} Sessions default-page request must be observed`);
    assert.ok(cursorPage, `${server} Sessions cursor request must be observed`);
    assert.ok(Number.isSafeInteger(firstPage.socketOrdinal) && firstPage.socketOrdinal > 0,
      `${server} Sessions default page must have an owned socket ordinal`);
    assert.equal(cursorPage.socketOrdinal, firstPage.socketOrdinal,
      `${server} Sessions default and cursor pages must use the same WebSocket`);
    const initialize = events.find(event => base(event) && event.method === "initialize" && event.socketOrdinal === firstPage.socketOrdinal);
    assert.ok(initialize, `${server} Sessions pages must use the WebSocket that performed initialize`);
    assert.ok(initialize.atNodeMs <= firstPage.atNodeMs && firstPage.atNodeMs <= cursorPage.atNodeMs,
      `${server} initialize/default-page/cursor sequence must preserve request order`);
    result[server] = {
      socketOrdinal: firstPage.socketOrdinal,
      initializePhase: initialize.phase,
      initializeRequestIdFingerprint: initialize.requestIdFingerprint,
      defaultPageRequestIdFingerprint: firstPage.requestIdFingerprint,
      cursorRequestIdFingerprint: cursorPage.requestIdFingerprint,
    };
  }
  return result;
}

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function safeErrorName(error) {
  const allowed = new Set(["Error", "TypeError", "RangeError", "AssertionError", "TimeoutError", "AbortError", "AggregateError"]);
  return allowed.has(error?.name) ? error.name : "OtherError";
}
