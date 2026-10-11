import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startChromium } from "../../harness/chromium.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileRoot = resolve(repoRoot, "apps/kcoder-studio/mobile");
const nodeModules = resolve(mobileRoot, "node_modules");
const mobileRequire = createRequire(resolve(mobileRoot, "package.json"));
const esbuild = mobileRequire("esbuild");
const fixture = fileURLToPath(new URL("../../fixtures/mobile/rnw-variable-height-scroll.jsx", import.meta.url));
const scenarios = ["initial-index-zero-scroll-to-end", "initial-latest-measured-retry", "hydrate-empty-one-window-init", "reversed-data-inverted"];
const viewport = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const gateMs = 10_000;
const historyNavigationMs = 5_000;
const count = 500;

await runE2E(import.meta.url, {
  testId: "mobile-rnw-variable-height-scroll-mechanism",
  tier: "manual-live",
  modelPolicy: "Pinned React Native Web FlatList mechanism fixture in isolated Chromium; no KCoder MessageBubble, Gateway, Provider, model task, or native-platform claim",
}, async context => {
  const packages = await readPinnedPackages();
  const items = makeHistoryInput();
  const inputSha256 = hash(Buffer.from(JSON.stringify(items)));
  const rowTextLengths = items.map(row => row.blocks.reduce((total, block) => total + (block.text?.length ?? block.items?.join("").length ?? 0), 0));
  assert.ok(Math.min(...rowTextLengths) < Math.max(...rowTextLengths), "history rows must have naturally varying text payload lengths");
  const suiteSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  const fixtureSha256 = hash(await readFile(fixture));
  const build = await esbuild.build({
    entryPoints: [fixture], absWorkingDir: repoRoot, nodePaths: [nodeModules],
    bundle: true, write: false, metafile: true, platform: "browser", format: "iife",
    outfile: context.pathInState("rnw-variable-height-scroll.js"),
    target: ["chrome120"], jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  });
  const output = build.outputFiles.find(file => file.path.endsWith(".js"));
  assert.ok(output, "esbuild should return the fixture bundle");
  const bundle = Buffer.from(output.contents);
  const bundleInputs = await hashBuildInputs(build.metafile.inputs);
  const dependencyEvidence = {
    node: { version: process.versions.node, executable: process.execPath },
    mobilePackageJsonSha256: hash(await readFile(resolve(mobileRoot, "package.json"))),
    mobilePackageLockSha256: hash(await readFile(resolve(mobileRoot, "package-lock.json"))),
    packages, esbuildVersion: esbuild.version,
    suiteSha256, fixtureSha256, bundleSha256: hash(bundle), bundleBytes: bundle.length,
    buildInputCount: bundleInputs.length,
    buildInputManifestSha256: hash(Buffer.from(JSON.stringify(bundleInputs))),
    buildInputs: bundleInputs,
    controls: { getItemLayout: "omitted", disableVirtualization: "omitted" },
  };
  await context.writeArtifactJson("rnw-variable-height-dependencies.json", dependencyEvidence);
  await writeFile(context.pathInState("rnw-variable-height-scroll.js"), bundle, { flag: "wx", mode: 0o600 });

  const browser = await startChromium(context, { label: "rnw-variable-height-chromium" });
  const browserVersion = await browser.browser.version();
  const results = [];
  for (const scenario of scenarios) {
    const result = await runCase(context, browser, scenario, items, inputSha256, bundle, browserVersion);
    results.push(result);
  }
  const summary = {
    evidenceKind: "RNW 0.21.2 variable-height FlatList mechanism reproduction only; not KCoder transcript behavior, a performance benchmark, or Android/iOS native evidence",
    browserVersion, viewport, count, inputSha256, gateMs,
    rowTextCharacters: { min: Math.min(...rowTextLengths), max: Math.max(...rowTextLengths) },
    gate: "last ASCII marker character Range intersects the actual RNW scroll host and stays geometrically stable across two animation frames; after a stable tail, trusted wheel input must expose rows 498 and 490 and reveal initially unmounted row 487",
    cases: results, dependencyEvidence,
  };
  await context.writeArtifactJson("rnw-variable-height-summary.json", summary);
  const failed = results.filter(result => result.gate !== "visible-stable-after-two-frames" || result.errors.length || result.cleanupErrors.length || (result.scrollback?.gate !== "history-498-and-490-visible" && result.gate === "visible-stable-after-two-frames") || (result.scrollback?.frontier?.gate !== "frontier-row-mounted-and-visible-after-wheel" && result.gate === "visible-stable-after-two-frames"));
  assert.equal(failed.length, 0, `500-row mechanism case(s) failed: ${failed.map(item => `${item.scenario}=tail:${item.gate},history:${item.scrollback?.gate || "not-run"},frontier:${item.scrollback?.frontier?.gate || "not-run"}`).join(", ")}`);
  return summary;
});

async function runCase(context, browser, scenario, items, inputSha256, bundle, browserVersion) {
  const result = {
    scenario, browserVersion, input: { count: items.length, sha256: inputSha256 },
    gate: "not-started", firstVisiblePollUpperBoundMs: null,
    actualViewport: null, finalDom: null, trace: null, scrollback: null, errors: [], cleanupErrors: [], screenshot: null,
  };
  let page;
  try {
    page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
    });
    await page.setContent('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body,#root{width:100%;height:100%;margin:0;padding:0;overflow:hidden}*{box-sizing:border-box}body{font-family:Arial,sans-serif}</style><div id="root"></div>');
    await page.evaluate(rows => { window.__RNW_VARIABLE_HEIGHT_ITEMS__ = rows; }, items);
    await page.addScriptTag({ content: bundle.toString("utf8") });
    await page.evaluate(id => window.mountRnwVariableHeightScenario(id, window.__RNW_VARIABLE_HEIGHT_ITEMS__), scenario);
    const deadline = Date.now() + gateMs;
    try {
      const hostReady = await page.waitForFunction(() => {
        const host = document.querySelector('[data-testid="fixture-scroll-list"]');
        const rect = host?.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      }, null, { timeout: Math.max(1, deadline - Date.now()), polling: 50 });
      await hostReady.dispose();
      result.actualViewport = await page.evaluate(() => {
        const host = document.querySelector('[data-testid="fixture-scroll-list"]');
        const rect = host?.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          scrollHost: host && rect ? {
            clientWidth: host.clientWidth,
            clientHeight: host.clientHeight,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          } : null,
        };
      });
      assert.equal(result.actualViewport.innerWidth, viewport.width, "actual browser innerWidth");
      assert.equal(result.actualViewport.innerHeight, viewport.height, "actual browser innerHeight");
      assert.equal(result.actualViewport.devicePixelRatio, viewport.deviceScaleFactor, "actual browser devicePixelRatio");
      assert.ok(result.actualViewport.scrollHost, "actual RNW scroll host must be mounted");
      assert.ok(Math.abs(result.actualViewport.scrollHost.width - viewport.width) <= 1, "RNW scroll host width must match the mobile viewport");
      assert.ok(Math.abs(result.actualViewport.scrollHost.height - viewport.height) <= 1, "RNW scroll host height must match the mobile viewport");
      let stable = false;
      while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const visibleHandle = await page.waitForFunction(() => {
          const state = window.__rnwVariableHeightState;
          const read = window.__rnwVariableHeightReadDom;
          if (!state || !read) return false;
          const before = read();
          if (!before.tailVisible) return false;
          state.firstVisiblePollUpperBoundMs ??= before.atMs;
          return true;
        }, null, { timeout: remaining, polling: 50 });
        await visibleHandle.dispose();
        const stableAfterFrames = await page.evaluate(async () => {
          const state = window.__rnwVariableHeightState;
          const read = window.__rnwVariableHeightReadDom;
          if (!state || !read) return false;
          const before = read();
          if (!before.tailVisible) return false;
          await window.__rnwVariableHeightWaitTwoFrames();
          const after = read();
          const a = before.lastCharacterRect;
          const b = after.lastCharacterRect;
          const stable = Boolean(after.tailVisible && a && b && Math.abs(a.top - b.top) <= 1 && Math.abs(a.left - b.left) <= 1);
          if (stable) state.stableAtMs = after.atMs;
          return stable;
        });
        assert.equal(typeof stableAfterFrames, "boolean", "two-frame marker probe must return a boolean");
        if (stableAfterFrames === true) {
          stable = true;
          break;
        }
      }
      result.gate = stable ? "visible-stable-after-two-frames" : "timeout";
    } catch (error) {
      result.gate = error?.name === "TimeoutError" || /Timeout|timed out/i.test(error?.message || "") ? "timeout" : "gate-error";
      if (result.gate === "gate-error") result.errors.push(errorRecord(context, "visibility-gate", error));
    }
    const snapshot = await page.evaluate(() => ({ dom: window.__rnwVariableHeightReadDom?.() || null, trace: window.__rnwVariableHeightState?.summary() || null }));
    result.finalDom = snapshot.dom;
    result.trace = snapshot.trace;
    result.firstVisiblePollUpperBoundMs = snapshot.trace?.firstVisiblePollUpperBoundMs ?? null;
    if (result.gate !== "visible-stable-after-two-frames") {
      result.scrollback = { gate: "not-run-tail-gate-failed", before: null, steps: [], after: null, eventTrace: null, errors: [], cleanupErrors: [] };
      const path = `${scenario}-failure.png`;
      try {
        await page.screenshot({ path: context.pathInArtifacts(path), fullPage: false });
        result.screenshot = path;
      } catch (error) { result.errors.push(errorRecord(context, "failure-screenshot", error)); }
    } else {
      result.scrollback = await runHistoryNavigation(context, page);
      if (result.scrollback.gate !== "history-498-and-490-visible" || result.scrollback.frontier?.gate !== "frontier-row-mounted-and-visible-after-wheel") {
        const path = `${scenario}-history-scrollback-failure.png`;
        try {
          await page.screenshot({ path: context.pathInArtifacts(path), fullPage: false });
          result.scrollback.screenshot = path;
        } catch (error) { result.scrollback.errors.push(errorRecord(context, "history-scrollback-screenshot", error)); }
      }
    }
  } catch (error) {
    result.gate = result.gate === "not-started" ? "setup-error" : result.gate;
    result.errors.push(errorRecord(context, "setup", error));
  }
  if (page && !page.isClosed()) {
    try { await page.close(); }
    catch (error) { result.cleanupErrors.push(errorRecord(context, "close-page", error)); }
  }
  await context.writeArtifactJson(`rnw-variable-height-${scenario}.json`, result);
  return result;
}

async function runHistoryNavigation(context, page) {
  const targets = [498, 490, 487];
  const frontierIndex = 487;
  const requestedWheelDeltaY = -660;
  const result = {
    gate: "not-started", input: { method: "Playwright mouse.move + mouse.wheel", requestedWheelDeltaY, devicePixelRatio: viewport.deviceScaleFactor, expectedApproxObservedCssDeltaY: requestedWheelDeltaY / viewport.deviceScaleFactor, maxSteps: 32, deadlineMs: historyNavigationMs },
    wheelCalibration: { requestedWheelDeltaY, expectedApproxObservedCssDeltaY: requestedWheelDeltaY / viewport.deviceScaleFactor, observedTrustedWheelCount: 0, observedTrustedWheelDeltaYTotal: 0, observedAverageTrustedWheelDeltaY: null, cumulativeRequestedWheelDeltaY: 0, observedHostOffsetDelta: 0 },
    frontier: { index: frontierIndex, initial: null, initialMountEventCount: null, firstMountedDuringWheel: null, firstVisibleDuringWheel: null, final: null, gate: "not-started" },
    before: null, steps: [], after: null, eventTrace: null, reachedTargets: [], offsetChanged: false,
    errors: [], cleanupErrors: [], screenshot: null,
  };
  let probeInstalled = false;
  try {
    probeInstalled = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="fixture-scroll-list"]');
      if (!host) return false;
      const state = window.__rnwVariableHeightState;
      const events = [];
      let dropped = 0;
      const add = (kind, event) => {
        if (events.length >= 128) { dropped += 1; return; }
        events.push({
          kind,
          atMs: +((performance.now() - (state?.startedAt ?? performance.now())).toFixed(2)),
          trusted: Boolean(event.isTrusted),
          deltaY: kind === "wheel" ? event.deltaY : null,
          scrollTop: host.scrollTop,
          targetTestId: event.target?.closest?.("[data-testid]")?.getAttribute("data-testid") ?? null,
        });
      };
      const onWheel = event => add("wheel", event);
      const onScroll = event => add("scroll", event);
      host.addEventListener("wheel", onWheel, { capture: true, passive: true });
      host.addEventListener("scroll", onScroll, { capture: true, passive: true });
      const rectRecord = rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
      window.__rnwScrollbackProbe = {
        snapshot(indexes) {
          const hostRect = host.getBoundingClientRect();
          const rows = indexes.map(index => {
            const node = document.querySelector(`[data-testid="fixture-row-${index}"]`);
            const rect = node?.getBoundingClientRect();
            const visible = Boolean(rect && rect.right > hostRect.left && rect.left < hostRect.right && rect.bottom > hostRect.top && rect.top < hostRect.bottom);
            return { index, mounted: Boolean(node), visible, rect: rect ? rectRecord(rect) : null };
          });
          return {
            atMs: +((performance.now() - (state?.startedAt ?? performance.now())).toFixed(2)),
            scrollHost: {
              clientHeight: host.clientHeight,
              scrollHeight: host.scrollHeight,
              scrollTop: host.scrollTop,
              maxScrollTop: Math.max(0, host.scrollHeight - host.clientHeight),
              bottomGap: host.scrollHeight - host.clientHeight - host.scrollTop,
              rect: rectRecord(hostRect),
            },
            rows,
          };
        },
        readEvents() { return { events: [...events], dropped }; },
        dispose() {
          host.removeEventListener("wheel", onWheel, true);
          host.removeEventListener("scroll", onScroll, true);
          delete window.__rnwScrollbackProbe;
        },
      };
      return true;
    });
    if (!probeInstalled) {
      result.gate = "scroll-host-not-mounted";
      return result;
    }
    result.before = await page.evaluate(indexes => window.__rnwScrollbackProbe.snapshot(indexes), targets);
    const initialFrontier = result.before.rows.find(row => row.index === frontierIndex) ?? null;
    result.frontier.initial = initialFrontier;
    result.frontier.initialMountEventCount = await page.evaluate(index => (window.__rnwVariableHeightState?.summary()?.rowEvents ?? []).filter(event => event.kind === "mounted" && event.fixtureRowIndex === index).length, frontierIndex);
    result.frontier.gate = initialFrontier ? (initialFrontier.mounted ? "frontier-row-was-initially-mounted" : "frontier-row-initially-unmounted") : "frontier-row-initial-state-missing";
    const hostRect = result.before.scrollHost.rect;
    const deadline = Date.now() + historyNavigationMs;
    let previousTrustedWheelCount = 0;
    let previousTrustedWheelDeltaYTotal = 0;
    for (let step = 0; step < 32 && Date.now() < deadline; step += 1) {
      await page.mouse.move(hostRect.left + hostRect.width / 2, hostRect.top + hostRect.height / 2);
      await page.mouse.wheel(0, requestedWheelDeltaY);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const observation = await page.evaluate(indexes => window.__rnwScrollbackProbe.snapshot(indexes), targets);
      const wheelProgress = await page.evaluate(index => {
        const events = window.__rnwScrollbackProbe.readEvents().events;
        const trustedUp = events.filter(event => event.kind === "wheel" && event.trusted && event.deltaY < 0);
        return {
          trustedWheelCount: trustedUp.length,
          trustedWheelDeltaYTotal: trustedUp.reduce((total, event) => total + event.deltaY, 0),
          observedAverageTrustedWheelDeltaY: trustedUp.length ? trustedUp.reduce((total, event) => total + event.deltaY, 0) / trustedUp.length : null,
          firstTrustedWheelAtMs: trustedUp[0]?.atMs ?? null,
          lastTrustedWheelAtMs: trustedUp.at(-1)?.atMs ?? null,
          frontierMountEvents: (window.__rnwVariableHeightState?.summary()?.rowEvents ?? []).filter(event => event.kind === "mounted" && event.fixtureRowIndex === index),
        };
      }, frontierIndex);
      const stepTrustedWheelCount = wheelProgress.trustedWheelCount - previousTrustedWheelCount;
      const stepTrustedWheelDeltaYTotal = wheelProgress.trustedWheelDeltaYTotal - previousTrustedWheelDeltaYTotal;
      observation.inputProgress = {
        step: step + 1,
        requestedWheelDeltaY,
        stepTrustedWheelCount,
        stepTrustedWheelDeltaYTotal,
        cumulativeTrustedWheelCount: wheelProgress.trustedWheelCount,
        cumulativeTrustedWheelDeltaYTotal: wheelProgress.trustedWheelDeltaYTotal,
        firstTrustedWheelAtMs: wheelProgress.firstTrustedWheelAtMs,
        lastTrustedWheelAtMs: wheelProgress.lastTrustedWheelAtMs,
        observedAverageTrustedWheelDeltaY: wheelProgress.observedAverageTrustedWheelDeltaY,
        cumulativeRequestedWheelDeltaY: requestedWheelDeltaY * (step + 1),
        cumulativeObservedScrollOffsetY: observation.scrollHost.scrollTop - result.before.scrollHost.scrollTop,
      };
      result.steps.push(observation);
      result.wheelCalibration.observedTrustedWheelCount = wheelProgress.trustedWheelCount;
      result.wheelCalibration.observedTrustedWheelDeltaYTotal = wheelProgress.trustedWheelDeltaYTotal;
      result.wheelCalibration.observedAverageTrustedWheelDeltaY = wheelProgress.observedAverageTrustedWheelDeltaY;
      result.wheelCalibration.cumulativeRequestedWheelDeltaY = requestedWheelDeltaY * (step + 1);
      result.wheelCalibration.observedHostOffsetDelta = observation.scrollHost.scrollTop - result.before.scrollHost.scrollTop;
      previousTrustedWheelCount = wheelProgress.trustedWheelCount;
      previousTrustedWheelDeltaYTotal = wheelProgress.trustedWheelDeltaYTotal;
      const frontierRow = observation.rows.find(row => row.index === frontierIndex) ?? null;
      if (frontierRow?.mounted && !result.frontier.firstMountedDuringWheel) {
        const mountEvent = wheelProgress.frontierMountEvents.at(-1) ?? null;
        result.frontier.firstMountedDuringWheel = {
          atMs: observation.atMs,
          step: step + 1,
          stepTrustedWheelCount,
          stepTrustedWheelDeltaYTotal,
          cumulativeTrustedWheelCount: wheelProgress.trustedWheelCount,
          cumulativeTrustedWheelDeltaYTotal: wheelProgress.trustedWheelDeltaYTotal,
          firstTrustedWheelAtMs: wheelProgress.firstTrustedWheelAtMs,
          lastTrustedWheelAtMs: wheelProgress.lastTrustedWheelAtMs,
          mountEventAfterTrustedWheel: Boolean(mountEvent && wheelProgress.firstTrustedWheelAtMs !== null && mountEvent.atMs >= wheelProgress.firstTrustedWheelAtMs),
          cumulativeScrollOffsetY: observation.inputProgress.cumulativeObservedScrollOffsetY,
          mountEvent,
          row: frontierRow,
        };
      }
      if (frontierRow?.visible && !result.frontier.firstVisibleDuringWheel) {
        const mountEvent = wheelProgress.frontierMountEvents.at(-1) ?? null;
        result.frontier.firstVisibleDuringWheel = {
          atMs: observation.atMs,
          step: step + 1,
          stepTrustedWheelCount,
          stepTrustedWheelDeltaYTotal,
          cumulativeTrustedWheelCount: wheelProgress.trustedWheelCount,
          cumulativeTrustedWheelDeltaYTotal: wheelProgress.trustedWheelDeltaYTotal,
          firstTrustedWheelAtMs: wheelProgress.firstTrustedWheelAtMs,
          lastTrustedWheelAtMs: wheelProgress.lastTrustedWheelAtMs,
          cumulativeScrollOffsetY: observation.inputProgress.cumulativeObservedScrollOffsetY,
          mountEvent,
          row: frontierRow,
        };
      }
      for (const target of targets) {
        if (observation.rows.find(row => row.index === target)?.visible && !result.reachedTargets.includes(target)) result.reachedTargets.push(target);
      }
      if (result.reachedTargets.includes(498) && result.reachedTargets.includes(490) && result.reachedTargets.includes(frontierIndex)) break;
    }
    result.after = await page.evaluate(indexes => window.__rnwScrollbackProbe.snapshot(indexes), targets);
    result.frontier.final = result.after.rows.find(row => row.index === frontierIndex) ?? null;
    result.offsetChanged = result.steps.some(step => Math.abs(step.scrollHost.scrollTop - result.before.scrollHost.scrollTop) > 0.5);
    const wheelEvents = await page.evaluate(() => window.__rnwScrollbackProbe.readEvents());
    result.eventTrace = wheelEvents;
    const trustedUpWheelCount = wheelEvents.events.filter(event => event.kind === "wheel" && event.trusted && event.deltaY < 0).length;
    if (result.frontier.initial?.mounted || result.frontier.initialMountEventCount > 0) result.frontier.gate = "frontier-row-was-initially-mounted";
    else if (!result.frontier.initial) result.frontier.gate = "frontier-row-initial-state-missing";
    else if (!trustedUpWheelCount) result.frontier.gate = "no-trusted-wheel-for-frontier";
    else if (!result.frontier.firstMountedDuringWheel || result.frontier.firstMountedDuringWheel.stepTrustedWheelCount === 0 || !result.frontier.firstMountedDuringWheel.mountEvent || !result.frontier.firstMountedDuringWheel.mountEventAfterTrustedWheel) result.frontier.gate = "frontier-row-not-mounted-during-trusted-wheel";
    else if (!result.frontier.firstVisibleDuringWheel || result.frontier.firstVisibleDuringWheel.stepTrustedWheelCount === 0) result.frontier.gate = "frontier-row-not-visible-during-trusted-wheel";
    else result.frontier.gate = "frontier-row-mounted-and-visible-after-wheel";
    if (trustedUpWheelCount === 0) result.gate = "no-trusted-up-wheel-observed";
    else if (!result.offsetChanged) result.gate = "no-scroll-offset-change";
    else if (!result.reachedTargets.includes(498)) result.gate = "prior-row-498-not-visible";
    else if (!result.reachedTargets.includes(490)) result.gate = "older-row-490-not-visible";
    else result.gate = "history-498-and-490-visible";
  } catch (error) {
    result.gate = "history-scrollback-error";
    result.errors.push(errorRecord(context, "history-scrollback", error));
    if (probeInstalled) {
      result.after = await page.evaluate(indexes => window.__rnwScrollbackProbe?.snapshot(indexes) ?? null, targets).catch(() => null);
      result.eventTrace = await page.evaluate(() => window.__rnwScrollbackProbe?.readEvents() ?? null).catch(() => null);
    }
  } finally {
    if (probeInstalled) {
      await page.evaluate(() => window.__rnwScrollbackProbe?.dispose()).catch(error => {
        result.cleanupErrors.push(errorRecord(context, "history-scrollback-probe-dispose", error));
      });
    }
  }
  return result;
}

async function readPinnedPackages() {
  const lock = JSON.parse(await readFile(resolve(mobileRoot, "package-lock.json"), "utf8"));
  const expected = { react: "19.1.0", "react-dom": "19.1.0", "react-native-web": "0.21.2", esbuild: "0.28.1", "@esbuild/linux-x64": "0.28.1" };
  assert.equal(process.versions.node, "22.17.0", "run with pinned Node 22.17.0");
  for (const [name, version] of Object.entries(expected)) assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} package-lock version`);
  assert.equal(esbuild.version, expected.esbuild);
  const binary = await realpath(resolve(nodeModules, "@esbuild/linux-x64/bin/esbuild"));
  if (process.env.ESBUILD_BINARY_PATH) assert.equal(await realpath(process.env.ESBUILD_BINARY_PATH), binary, "ESBUILD_BINARY_PATH must be the pinned package binary");
  const result = [];
  for (const name of Object.keys(expected)) {
    const packagePath = resolve(nodeModules, name, "package.json");
    const packageBytes = await readFile(packagePath);
    const packageInfo = JSON.parse(packageBytes.toString("utf8"));
    assert.equal(packageInfo.version, expected[name], `${name} installed package version`);
    const entryPath = name === "@esbuild/linux-x64" ? binary : await realpath(mobileRequire.resolve(name));
    const entryBytes = await readFile(entryPath);
    result.push({ name, version: expected[name], packageJsonSha256: hash(packageBytes), entryPath, entrySha256: hash(entryBytes), entryBytes: entryBytes.length });
  }
  return result;
}

async function hashBuildInputs(inputs) {
  const entries = Object.entries(inputs || {}).sort(([a], [b]) => a.localeCompare(b));
  assert.ok(entries.length > 0 && entries.length <= 512, `unexpected esbuild input count: ${entries.length}`);
  return Promise.all(entries.map(async ([name, info]) => {
    const file = isAbsolute(name) ? name : resolve(repoRoot, name);
    const bytes = await readFile(file);
    return { path: relative(repoRoot, file), bytes: bytes.length, sha256: hash(bytes), bytesInOutput: info.bytesInOutput || 0 };
  }));
}

function makeHistoryInput() {
  const sentences = [
    "The transcript keeps older context available while the reader moves toward the newest response.",
    "Variable-length text changes natural line wrapping and therefore the measured height of this row.",
    "中文记录也参与自然换行，历史内容长度不同，列表不能使用一个伪造的固定行高。",
    "A stable record key identifies each item while paragraphs retain their ordinary browser layout.",
  ];
  const rows = Array.from({ length: count }, (_, index) => {
    const blocks = Array.from({ length: 1 + (index * 7 + 3) % 5 }, (_, part) => ({
      kind: "paragraph",
      text: `${sentences[(index + part) % sentences.length]} ${sentences[(index + part + 1) % sentences.length].repeat(1 + (index + part * 3) % 5)}`,
    }));
    if (index % 7 === 0) blocks.push({ kind: "code", text: Array.from({ length: 2 + (index * 5) % 9 }, (_, line) => `const row_${index}_${line} = { id: "history-${index}", ready: ${line % 2 === 0} };`).join("\n") });
    if (index % 11 === 0) blocks.push({ kind: "list", items: Array.from({ length: 2 + (index * 3) % 6 }, (_, item) => `Checkpoint ${item + 1}: historical state remains available for review.`) });
    return { id: `history-${String(index).padStart(4, "0")}`, index, blocks };
  });
  assert.equal(rows.length, 500);
  assert.equal(new Set(rows.map(row => row.id)).size, 500);
  return rows;
}

function errorRecord(context, phase, error) {
  return { phase, name: error?.name || "Error", message: context.redactText(error?.message || String(error)).slice(0, 500) };
}

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
