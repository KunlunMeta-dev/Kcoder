import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { startChromium } from "../../harness/chromium.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileRoot = resolve(repoRoot, "apps/kcoder-studio/mobile");
const nodeModules = resolve(mobileRoot, "node_modules");
const mobileRequire = createRequire(resolve(mobileRoot, "package.json"));
const esbuild = mobileRequire("esbuild");
const fixture = fileURLToPath(new URL("../../fixtures/mobile/rnw-variable-height-scroll.jsx", import.meta.url));
const scenario = "reversed-data-inverted";
const viewport = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const rowCount = 500;
const seedGateMs = 10_000;
const gestureBudgetMs = 5_000;
const targetIndexes = [498, 490, 487];
const frontierIndex = 487;
const expectedFixtureSha256 = "cfd598b681e13f8ebbc9a7857053de90d5e6c888512d8312c5e39f40a8c6ad03";
const expectedInputSha256 = "0f4e5cc8527822708182bf0ded9311968e19418c5c708586f42c27b083925e44";

await runE2E(import.meta.url, {
  testId: "mobile-rnw-inverted-touch-history-mechanism",
  tier: "manual-live",
  modelPolicy: "Pinned React Native Web FlatList fixture with trusted CDP touch input; no KCoder product, Gateway, Provider, model task, or native-device claim",
}, async context => {
  const packages = await readPinnedPackages();
  const items = makeHistoryInput();
  assert.equal(items.length, rowCount, "touch fixture must use the same 500-row history input");
  const inputSha256 = hash(Buffer.from(JSON.stringify(items)));
  assert.equal(inputSha256, expectedInputSha256, "touch fixture history input must match the existing inverted-wheel fixture exactly");
  const rowTextLengths = items.map(row => row.blocks.reduce((total, block) => total + (block.text?.length ?? block.items?.join("").length ?? 0), 0));
  assert.ok(Math.min(...rowTextLengths) < Math.max(...rowTextLengths), "history rows must have naturally varying text payload lengths");

  const suiteSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  const fixtureSha256 = hash(await readFile(fixture));
  assert.equal(fixtureSha256, expectedFixtureSha256, "RNW fixture source must match the reviewed touch target");
  const build = await esbuild.build({
    entryPoints: [fixture], absWorkingDir: repoRoot, nodePaths: [nodeModules],
    bundle: true, write: false, metafile: true, platform: "browser", format: "iife",
    outfile: context.pathInState("rnw-inverted-touch-history.js"),
    target: ["chrome120"], jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  });
  const output = build.outputFiles.find(file => file.path.endsWith(".js"));
  assert.ok(output, "esbuild should return the fixture bundle");
  const bundle = Buffer.from(output.contents);
  const buildInputs = await hashBuildInputs(build.metafile.inputs);
  const dependencyEvidence = {
    node: { version: process.versions.node, executable: process.execPath },
    mobilePackageJsonSha256: hash(await readFile(resolve(mobileRoot, "package.json"))),
    mobilePackageLockSha256: hash(await readFile(resolve(mobileRoot, "package-lock.json"))),
    packages,
    esbuildVersion: esbuild.version,
    suiteSha256,
    fixtureSha256,
    inputSha256,
    bundleSha256: hash(bundle),
    bundleBytes: bundle.length,
    buildInputCount: buildInputs.length,
    buildInputManifestSha256: hash(Buffer.from(JSON.stringify(buildInputs))),
    buildInputs,
    controls: { getItemLayout: "omitted", disableVirtualization: "omitted" },
  };
  await context.writeArtifactJson("rnw-inverted-touch-dependencies.json", dependencyEvidence);
  await writeFile(context.pathInState("rnw-inverted-touch-history.js"), bundle, { flag: "wx", mode: 0o600 });

  const ownedBrowser = await startChromium(context, { label: "rnw-inverted-touch-chromium" });
  const browserVersion = await ownedBrowser.browser.version();
  const result = await runTouchCase(context, ownedBrowser, items, inputSha256, browserVersion);
  const summary = {
    evidenceKind: "RNW 0.21.2 variable-height FlatList mechanism reproduction only; trusted synthesized touch events are not physical phone or native Android/iOS evidence",
    browserVersion,
    viewport,
    scenario,
    rowCount,
    inputSha256,
    fixtureSha256,
    seedGateMs,
    gestureBudgetMs,
    requestedTouch: {
      cdpMethod: "Input.synthesizeScrollGesture",
      gestureSourceType: "touch",
      fingerDirection: "down toward older history",
      yDistanceCssPx: 660,
      repeatCount: 26,
      repeatDelayMs: 0,
      speedCssPxPerSecond: 8000,
      protocolDirectionNote: "CDP protocol describes positive yDistance as scrolling up; the observed trusted touch coordinates must independently show a downward finger path",
    },
    dependencyEvidence,
    result,
  };
  await context.writeArtifactJson("rnw-inverted-touch-history-summary.json", summary);
  assert.equal(result.gate, "trusted-down-touch-revealed-older-history", `touch history gate: ${result.gate}`);
  assert.deepEqual(result.errors, [], "touch history run should not have setup or interaction errors");
  assert.deepEqual(result.cleanupErrors, [], "touch history resources should clean up normally");
  return summary;
});

async function runTouchCase(context, ownedBrowser, items, inputSha256, browserVersion) {
  const result = {
    scenario,
    browserVersion,
    input: { count: items.length, sha256: inputSha256 },
    viewport: null,
    seed: { gate: "not-started", beforeTwoFrames: null, afterTwoFrames: null, stableAtMs: null },
    gate: "not-started",
    initial: null,
    final: null,
    frontier: { index: frontierIndex, initial: null, initialMountEventCount: null, firstMountAfterGesture: null, firstVisibleDuringGesture: null, final: null },
    gesture: {
      cdpMethod: "Input.synthesizeScrollGesture",
      gestureSourceType: "touch",
      fingerDirection: "down toward older history",
      yDistanceCssPx: 660,
      repeatCount: 26,
      repeatDelayMs: 0,
      speedCssPxPerSecond: 8000,
      budgetMs: gestureBudgetMs,
      elapsedMs: null,
      commandCompleted: false,
      commandTimedOut: false,
      inputWindowTimedOut: false,
      rawTouchDirection: null,
      trustedTouchEventCount: 0,
      trustedScrollEventCount: 0,
    },
    visibilityWindow: null,
    eventTrace: null,
    extent: null,
    errors: [],
    cleanupErrors: [],
    screenshot: null,
  };
  let page;
  let cdp;
  try {
    page = await ownedBrowser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
    });
    await page.setContent('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body,#root{width:100%;height:100%;margin:0;padding:0;overflow:hidden}*{box-sizing:border-box}body{font-family:Arial,sans-serif}</style><div id="root"></div>');
    await page.evaluate(rows => { window.__RNW_VARIABLE_HEIGHT_ITEMS__ = rows; }, items);
    await page.addScriptTag({ content: await readBundleText(context) });
    await page.evaluate(({ scenarioId, rows }) => window.mountRnwVariableHeightScenario(scenarioId, rows), { scenarioId: scenario, rows: items });

    const hostDeadline = performance.now() + seedGateMs;
    const hostHandle = await page.waitForFunction(() => {
      const host = document.querySelector('[data-testid="fixture-scroll-list"]');
      const rect = host?.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    }, null, { timeout: Math.max(1, hostDeadline - performance.now()), polling: 25 });
    await hostHandle.dispose();
    result.seed = await waitForStableTail(page);
    assert.equal(result.seed.gate, 'tail-range-stable-after-two-frames', "tail marker must be geometrically stable after two animation frames");
    result.viewport = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollHost: (() => {
        const host = document.querySelector('[data-testid="fixture-scroll-list"]');
        const rect = host?.getBoundingClientRect();
        return host && rect ? { clientWidth: host.clientWidth, clientHeight: host.clientHeight, left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
      })(),
    }));
    assert.equal(result.viewport.innerWidth, viewport.width, "actual browser innerWidth");
    assert.equal(result.viewport.innerHeight, viewport.height, "actual browser innerHeight");
    assert.equal(result.viewport.devicePixelRatio, viewport.deviceScaleFactor, "actual browser devicePixelRatio");
    assert.ok(result.viewport.scrollHost, "RNW scroll host must be mounted");
    assert.ok(Math.abs(result.viewport.scrollHost.width - viewport.width) <= 1, "RNW scroll host width must match viewport");
    assert.ok(Math.abs(result.viewport.scrollHost.height - viewport.height) <= 1, "RNW scroll host height must match viewport");

    const probeInstalled = await page.evaluate(indexes => {
      const host = document.querySelector('[data-testid="fixture-scroll-list"]');
      if (!host) return false;
      const state = window.__rnwVariableHeightState;
      const events = [];
      let dropped = 0;
      const push = item => {
        if (events.length >= 8192) { dropped += 1; return; }
        events.push({ sequence: events.length, atMs: +(performance.now() - (state?.startedAt ?? performance.now())).toFixed(2), ...item });
      };
      const recordTouch = event => {
        const touch = event.changedTouches?.[0] ?? event.touches?.[0] ?? null;
        const target = event.target?.closest?.('[data-testid]')?.getAttribute('data-testid') ?? null;
        push({
        family: 'touch', type: event.type, trusted: Boolean(event.isTrusted),
        clientX: touch?.clientX ?? null, clientY: touch?.clientY ?? null,
        changedTouchCount: event.changedTouches?.length ?? 0,
        targetWithinScrollHost: host.contains(event.target),
        targetTestId: target,
        });
      };
      const recordPointer = event => {
        const target = event.target?.closest?.('[data-testid]')?.getAttribute('data-testid') ?? null;
        push({ family: 'pointer', type: event.type, trusted: Boolean(event.isTrusted), pointerType: event.pointerType ?? null, clientX: event.clientX, clientY: event.clientY, targetTestId: target });
      };
      const recordScroll = event => push({
        family: 'scroll', type: event.type, trusted: Boolean(event.isTrusted),
        scrollTop: host.scrollTop, scrollHeight: host.scrollHeight,
        targetTestId: event.target?.getAttribute?.('data-testid') ?? null,
      });
      const touchListeners = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
      const pointerListeners = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'];
      for (const type of touchListeners) document.addEventListener(type, recordTouch, { capture: true, passive: true });
      for (const type of pointerListeners) document.addEventListener(type, recordPointer, { capture: true, passive: true });
      host.addEventListener('scroll', recordScroll, { capture: true, passive: true });
      const rectRecord = rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
      const snapshot = targets => {
        const hostRect = host.getBoundingClientRect();
        const rows = targets.map(index => {
          const node = document.querySelector(`[data-testid="fixture-row-${index}"]`);
          const rect = node?.getBoundingClientRect();
          const visible = Boolean(rect && rect.right > hostRect.left && rect.left < hostRect.right && rect.bottom > hostRect.top && rect.top < hostRect.bottom);
          return { index, mounted: Boolean(node), visible, rect: rect ? rectRecord(rect) : null };
        });
        return {
          atMs: +(performance.now() - (state?.startedAt ?? performance.now())).toFixed(2),
          tail: window.__rnwVariableHeightReadDom?.() ?? null,
          scrollHost: {
            clientHeight: host.clientHeight,
            scrollHeight: host.scrollHeight,
            scrollTop: host.scrollTop,
            maxScrollTop: Math.max(0, host.scrollHeight - host.clientHeight),
            bottomGap: host.scrollHeight - host.clientHeight - host.scrollTop,
            rect: rectRecord(hostRect),
          },
          rows,
          rowEvents: window.__rnwVariableHeightState?.summary()?.rowEvents ?? [],
        };
      };
      window.__rnwTouchHistoryProbe = {
        gestureStartedAtMs: null,
        snapshot,
        readEvents: () => ({ events: [...events], dropped }),
        markGestureStarted() { this.gestureStartedAtMs = +(performance.now() - (state?.startedAt ?? performance.now())).toFixed(2); return this.gestureStartedAtMs; },
        async observeFrameWindow(targets, frontier, budgetMs, gestureStartedAtMs) {
          const startedAtMs = +(performance.now() - (state?.startedAt ?? performance.now())).toFixed(2);
          const deadline = performance.now() + budgetMs;
          const firstVisibleByIndex = Object.fromEntries(targets.map(index => [String(index), null]));
          const frames = [];
          let droppedFrames = 0;
          while (performance.now() < deadline) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const observation = snapshot(targets);
            const touchMovesBeforeFrame = events.filter(event => event.family === 'touch'
              && event.type === 'touchmove'
              && event.trusted
              && event.atMs >= gestureStartedAtMs
              && event.atMs <= observation.atMs);
            const trustedTouchMove = touchMovesBeforeFrame.at(-1) ?? null;
            const scrollsAfterLatestTouch = trustedTouchMove
              ? events.filter(event => event.family === 'scroll'
                && event.trusted
                && event.sequence > trustedTouchMove.sequence
                && event.atMs >= trustedTouchMove.atMs
                && event.atMs <= observation.atMs)
              : [];
            const trustedScrollAfterTouch = scrollsAfterLatestTouch.at(-1) ?? null;
            const inputAssociation = trustedTouchMove && trustedScrollAfterTouch ? {
              trustedTouchMove: { sequence: trustedTouchMove.sequence, atMs: trustedTouchMove.atMs, clientY: trustedTouchMove.clientY, targetTestId: trustedTouchMove.targetTestId },
              trustedScroll: { sequence: trustedScrollAfterTouch.sequence, atMs: trustedScrollAfterTouch.atMs, scrollTop: trustedScrollAfterTouch.scrollTop, targetTestId: trustedScrollAfterTouch.targetTestId },
              scrollFollowedTouch: trustedScrollAfterTouch.sequence > trustedTouchMove.sequence,
            } : null;
            const firstFrontierMount = observation.rowEvents.find(event => event.kind === 'mounted' && event.fixtureRowIndex === frontier && event.atMs >= gestureStartedAtMs && event.atMs <= observation.atMs) ?? null;
            for (const row of observation.rows) {
              const key = String(row.index);
              if (firstVisibleByIndex[key] || !row.visible || !inputAssociation) continue;
              if (row.index === frontier && !firstFrontierMount) continue;
              firstVisibleByIndex[key] = {
                atMs: observation.atMs,
                row,
                scrollHost: observation.scrollHost,
                inputAssociation,
                frontierMountEvent: row.index === frontier ? firstFrontierMount : null,
              };
            }
            if (frames.length < 2048) {
              frames.push({
                atMs: observation.atMs,
                scrollHost: observation.scrollHost,
                rows: observation.rows,
                inputAssociation,
              });
            } else {
              droppedFrames += 1;
            }
            if (targets.every(index => firstVisibleByIndex[String(index)])) break;
          }
          const endedAtMs = +(performance.now() - (state?.startedAt ?? performance.now())).toFixed(2);
          return {
            startedAtMs,
            endedAtMs,
            budgetMs,
            frameCount: frames.length,
            droppedFrames,
            complete: targets.every(index => firstVisibleByIndex[String(index)]),
            firstVisibleByIndex,
            frames,
          };
        },
        dispose() {
          for (const type of touchListeners) document.removeEventListener(type, recordTouch, true);
          for (const type of pointerListeners) document.removeEventListener(type, recordPointer, true);
          host.removeEventListener('scroll', recordScroll, true);
          delete window.__rnwTouchHistoryProbe;
        },
      };
      return true;
    }, targetIndexes);
    assert.equal(probeInstalled, true, "touch and scroll event probe must install on the real RNW scroll host");

    result.initial = await page.evaluate(indexes => window.__rnwTouchHistoryProbe.snapshot(indexes), targetIndexes);
    result.frontier.initial = result.initial.rows.find(row => row.index === frontierIndex) ?? null;
    result.frontier.initialMountEventCount = result.initial.rowEvents.filter(event => event.kind === 'mounted' && event.fixtureRowIndex === frontierIndex).length;
    assert.ok(result.frontier.initial, "initial frontier row observation must exist");
    assert.equal(result.frontier.initial.mounted, false, "row 487 must be unmounted before the touch input");
    assert.equal(result.frontier.initialMountEventCount, 0, "row 487 must not have mounted before the touch input");

    const cdpSession = await page.context().newCDPSession(page);
    cdp = cdpSession;
    const point = {
      x: Math.round(result.initial.scrollHost.rect.left + result.initial.scrollHost.rect.width / 2),
      y: Math.round(result.initial.scrollHost.rect.top + 80),
    };
    const command = {
      x: point.x,
      y: point.y,
      xDistance: 0,
      yDistance: 660,
      speed: 8000,
      preventFling: true,
      gestureSourceType: 'touch',
      repeatCount: 26,
      repeatDelayMs: 0,
    };
    result.gesture.point = point;
    result.gesture.parameters = command;
    result.gesture.startScrollHost = result.initial.scrollHost;
    const inputWindowStart = performance.now();
    const budgetDeadline = inputWindowStart + gestureBudgetMs;
    result.gesture.gestureStartedAtMs = await page.evaluate(() => window.__rnwTouchHistoryProbe.markGestureStarted());
    const commandStart = performance.now();
    const frameBudgetMs = Math.max(1, Math.min(gestureBudgetMs - 150, budgetDeadline - performance.now() - 50));
    let commandOutcome = { settled: false, completed: false, error: null, elapsedMs: null };
    let observationOutcome = { settled: false, value: null, error: null };
    const commandPromise = cdpSession.send('Input.synthesizeScrollGesture', command).then(() => {
      commandOutcome = { settled: true, completed: true, error: null, elapsedMs: +(performance.now() - commandStart).toFixed(2) };
      return commandOutcome;
    }, error => {
      commandOutcome = { settled: true, completed: false, error: errorRecord(context, 'cdp-touch-gesture', error), elapsedMs: +(performance.now() - commandStart).toFixed(2) };
      return commandOutcome;
    });
    const observationPromise = page.evaluate(({ indexes, frontier, budgetMs, gestureStartedAtMs }) => (
      window.__rnwTouchHistoryProbe.observeFrameWindow(indexes, frontier, budgetMs, gestureStartedAtMs)
    ), { indexes: targetIndexes, frontier: frontierIndex, budgetMs: frameBudgetMs, gestureStartedAtMs: result.gesture.gestureStartedAtMs }).then(value => {
      observationOutcome = { settled: true, value, error: null };
      return observationOutcome;
    }, error => {
      observationOutcome = { settled: true, value: null, error: errorRecord(context, 'touch-frame-observation', error) };
      return observationOutcome;
    });
    try {
      await withTimeout(Promise.all([commandPromise, observationPromise]), Math.max(1, budgetDeadline - performance.now()), 'CDP touch gesture and RAF observation');
    } catch (error) {
      result.gesture.inputWindowTimedOut = /exceeded/i.test(error?.message || '');
      result.errors.push(errorRecord(context, 'touch-gesture-window', error));
    }
    result.gesture.commandCompleted = commandOutcome.completed;
    result.gesture.commandTimedOut = !commandOutcome.settled && result.gesture.inputWindowTimedOut;
    result.gesture.commandElapsedMs = commandOutcome.elapsedMs;
    if (commandOutcome.error) result.errors.push(commandOutcome.error);
    if (observationOutcome.error) result.errors.push(observationOutcome.error);
    result.gesture.elapsedMs = +(performance.now() - inputWindowStart).toFixed(2);
    result.visibilityWindow = observationOutcome.value;
    result.final = await page.evaluate(indexes => window.__rnwTouchHistoryProbe.snapshot(indexes), targetIndexes);
    result.frontier.final = result.final.rows.find(row => row.index === frontierIndex) ?? null;
    const stateEvents = result.final.rowEvents;
    result.frontier.firstMountAfterGesture = stateEvents.find(event => event.kind === 'mounted' && event.fixtureRowIndex === frontierIndex && event.atMs >= result.gesture.gestureStartedAtMs) ?? null;
    result.frontier.firstVisibleDuringGesture = result.visibilityWindow?.firstVisibleByIndex?.[String(frontierIndex)] ?? null;
    result.eventTrace = await page.evaluate(() => window.__rnwTouchHistoryProbe.readEvents());
    const touchSummary = summarizeTouches(result.eventTrace.events);
    const trustedTouchEvents = result.eventTrace.events.filter(event => event.family === 'touch' && event.trusted);
    const trustedScrollEvents = result.eventTrace.events.filter(event => event.family === 'scroll' && event.trusted);
    result.gesture.trustedTouchEventCount = trustedTouchEvents.length;
    result.gesture.trustedScrollEventCount = trustedScrollEvents.length;
    result.gesture.rawTouchDirection = touchSummary;
    result.extent = {
      initialScrollTop: result.initial.scrollHost.scrollTop,
      finalScrollTop: result.final.scrollHost.scrollTop,
      scrollTopDelta: +(result.final.scrollHost.scrollTop - result.initial.scrollHost.scrollTop).toFixed(2),
      initialScrollHeight: result.initial.scrollHost.scrollHeight,
      finalScrollHeight: result.final.scrollHost.scrollHeight,
      scrollHeightDelta: result.final.scrollHost.scrollHeight - result.initial.scrollHost.scrollHeight,
      initialMaxScrollTop: result.initial.scrollHost.maxScrollTop,
      finalMaxScrollTop: result.final.scrollHost.maxScrollTop,
      maxScrollTopObservedDuringGesture: Math.max(result.initial.scrollHost.scrollTop, ...(result.visibilityWindow?.frames || []).map(frame => frame.scrollHost.scrollTop)),
      mountedRowsBefore: result.initial.rows.filter(row => row.mounted).map(row => row.index),
      mountedRowsAfter: result.final.rows.filter(row => row.mounted).map(row => row.index),
      firstVisibleByIndex: result.visibilityWindow?.firstVisibleByIndex ?? null,
      finalSnapshotRows: result.final.rows,
    };

    const firstVisibleByIndex = result.visibilityWindow?.firstVisibleByIndex ?? {};
    const allTargetsVisibleDuringWindow = targetIndexes.every(index => {
      const observation = firstVisibleByIndex[String(index)];
      return Boolean(observation?.row?.visible
        && observation?.inputAssociation?.scrollFollowedTouch
        && observation.scrollHost.scrollTop > result.initial.scrollHost.scrollTop + 0.5);
    });
    const downTouchObserved = touchSummary.allCompletedSegmentsDown
      && touchSummary.trustedTouchStartInHostCount > 0
      && touchSummary.trustedTouchMoveCount > 0
      && touchSummary.trustedTouchEndCount > 0;
    const offsetAdvancedTowardOlder = result.extent.maxScrollTopObservedDuringGesture > result.initial.scrollHost.scrollTop + 0.5;
    const firstFrontierVisible = firstVisibleByIndex[String(frontierIndex)];
    const frontierAdvanced = !result.frontier.initial.mounted
      && result.frontier.initialMountEventCount === 0
      && Boolean(firstFrontierVisible?.row?.mounted && firstFrontierVisible.row.visible)
      && Boolean(firstFrontierVisible?.frontierMountEvent)
      && firstFrontierVisible.frontierMountEvent.atMs >= result.gesture.gestureStartedAtMs
      && firstFrontierVisible.frontierMountEvent.atMs <= firstFrontierVisible.atMs;
    const trustedScrollObserved = trustedScrollEvents.some(event => event.targetTestId === 'fixture-scroll-list');
    if (!result.gesture.commandCompleted) result.gate = result.gesture.commandTimedOut ? 'cdp-touch-gesture-timeout' : 'cdp-touch-gesture-error';
    else if (result.gesture.inputWindowTimedOut || result.gesture.elapsedMs > gestureBudgetMs) result.gate = 'gesture-budget-exceeded';
    else if (result.eventTrace.dropped > 0 || (result.visibilityWindow?.droppedFrames ?? 0) > 0) result.gate = 'event-trace-truncated';
    else if (!downTouchObserved) result.gate = 'no-trusted-down-touch-path';
    else if (!trustedScrollObserved) result.gate = 'no-trusted-scroll-event';
    else if (!offsetAdvancedTowardOlder) result.gate = 'scroll-offset-did-not-advance-toward-older';
    else if (!frontierAdvanced) result.gate = 'initially-unmounted-row-487-not-revealed';
    else if (!allTargetsVisibleDuringWindow) result.gate = 'not-every-target-visible-after-trusted-input-during-window';
    else result.gate = 'trusted-down-touch-revealed-older-history';
    if (result.gate !== 'trusted-down-touch-revealed-older-history') {
      try {
        await page.screenshot({ path: context.pathInArtifacts('rnw-inverted-touch-history-failure.png'), fullPage: false });
        result.screenshot = 'rnw-inverted-touch-history-failure.png';
      } catch (error) {
        result.errors.push(errorRecord(context, 'failure-screenshot', error));
      }
    }
  } catch (error) {
    result.gate = result.gate === 'not-started' ? 'setup-error' : result.gate;
    result.errors.push(errorRecord(context, 'touch-history', error));
    if (page && !page.isClosed()) {
      try {
        await page.screenshot({ path: context.pathInArtifacts('rnw-inverted-touch-history-failure.png'), fullPage: false });
        result.screenshot = 'rnw-inverted-touch-history-failure.png';
      } catch (screenshotError) {
        result.errors.push(errorRecord(context, 'failure-screenshot', screenshotError));
      }
    }
  } finally {
    if (page && !page.isClosed()) {
      await page.evaluate(() => window.__rnwTouchHistoryProbe?.dispose()).catch(error => {
        result.cleanupErrors.push(errorRecord(context, 'dispose-touch-probe', error));
      });
    }
    if (cdp) {
      await cdp.detach().catch(error => result.cleanupErrors.push(errorRecord(context, 'detach-cdp', error)));
    }
    if (page && !page.isClosed()) {
      await page.close().catch(error => result.cleanupErrors.push(errorRecord(context, 'close-page', error)));
    }
  }
  await context.writeArtifactJson('rnw-inverted-touch-case.json', result);
  return result;
}

async function waitForStableTail(page) {
  const deadline = performance.now() + seedGateMs;
  let beforeTwoFrames = null;
  let afterTwoFrames = null;
  while (performance.now() < deadline) {
    const remaining = Math.max(1, deadline - performance.now());
    const visibleHandle = await page.waitForFunction(() => Boolean(window.__rnwVariableHeightReadDom?.()?.tailVisible), null, {
      timeout: remaining,
      polling: 25,
    }).catch(() => null);
    if (!visibleHandle) break;
    await visibleHandle.dispose();
    const probe = await page.evaluate(async () => {
      const read = window.__rnwVariableHeightReadDom;
      const state = window.__rnwVariableHeightState;
      const before = read?.() ?? null;
      await window.__rnwVariableHeightWaitTwoFrames?.();
      const after = read?.() ?? null;
      const a = before?.lastCharacterRect;
      const b = after?.lastCharacterRect;
      const stable = Boolean(before?.tailVisible && after?.tailVisible && a && b && Math.abs(a.top - b.top) <= 1 && Math.abs(a.left - b.left) <= 1);
      if (stable && state) state.touchTailStableAtMs = after.atMs;
      return { before, after, stable, stableAtMs: stable ? after.atMs : null };
    });
    beforeTwoFrames = probe.before;
    afterTwoFrames = probe.after;
    if (probe.stable) {
      return { gate: 'tail-range-stable-after-two-frames', beforeTwoFrames, afterTwoFrames, stableAtMs: probe.stableAtMs };
    }
  }
  return { gate: 'tail-range-not-stable-before-deadline', beforeTwoFrames, afterTwoFrames, stableAtMs: null };
}

function summarizeTouches(events) {
  const touches = events.filter(event => event.family === 'touch');
  const trustedTouches = touches.filter(event => event.trusted);
  const segments = [];
  let current = null;
  for (const event of trustedTouches) {
    if (event.type === 'touchstart') {
      if (current) segments.push({ ...current, ended: false });
      current = { startY: event.clientY, lastY: event.clientY, moveCount: 0, endY: null, startedAtMs: event.atMs, endedAtMs: null };
    } else if (event.type === 'touchmove' && current) {
      if (Number.isFinite(event.clientY)) current.lastY = event.clientY;
      current.moveCount += 1;
    } else if ((event.type === 'touchend' || event.type === 'touchcancel') && current) {
      current.endY = event.clientY;
      current.endedAtMs = event.atMs;
      segments.push({ ...current, ended: event.type === 'touchend' });
      current = null;
    }
  }
  if (current) segments.push({ ...current, ended: false });
  const completedSegments = segments.filter(segment => segment.ended && segment.moveCount > 0 && Number.isFinite(segment.startY) && Number.isFinite(segment.lastY));
  const downSegments = completedSegments.filter(segment => segment.lastY > segment.startY + 1);
  const upSegments = completedSegments.filter(segment => segment.lastY < segment.startY - 1);
  return {
    touchEventCount: touches.length,
    trustedTouchEventCount: trustedTouches.length,
    trustedTouchStartCount: trustedTouches.filter(event => event.type === 'touchstart').length,
    trustedTouchStartInHostCount: trustedTouches.filter(event => event.type === 'touchstart' && event.targetWithinScrollHost).length,
    trustedTouchMoveCount: trustedTouches.filter(event => event.type === 'touchmove').length,
    trustedTouchEndCount: trustedTouches.filter(event => event.type === 'touchend').length,
    segments,
    trustedDownSegments: downSegments.length,
    trustedUpSegments: upSegments.length,
    allCompletedSegmentsDown: completedSegments.length > 0 && downSegments.length === completedSegments.length && upSegments.length === 0,
    largestDownDeltaCssPx: downSegments.reduce((largest, segment) => Math.max(largest, segment.lastY - segment.startY), 0),
  };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${Math.round(timeoutMs)}ms bound`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBundleText(context) {
  const path = context.pathInState("rnw-inverted-touch-history.js");
  return await readFile(path, "utf8");
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
  const entries = Object.entries(inputs || {}).sort(([left], [right]) => left.localeCompare(right));
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
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const blocks = Array.from({ length: 1 + (index * 7 + 3) % 5 }, (_, part) => ({
      kind: "paragraph",
      text: `${sentences[(index + part) % sentences.length]} ${sentences[(index + part + 1) % sentences.length].repeat(1 + (index + part * 3) % 5)}`,
    }));
    if (index % 7 === 0) blocks.push({ kind: "code", text: Array.from({ length: 2 + (index * 5) % 9 }, (_, line) => `const row_${index}_${line} = { id: "history-${index}", ready: ${line % 2 === 0} };`).join("\n") });
    if (index % 11 === 0) blocks.push({ kind: "list", items: Array.from({ length: 2 + (index * 3) % 6 }, (_, item) => `Checkpoint ${item + 1}: historical state remains available for review.`) });
    return { id: `history-${String(index).padStart(4, "0")}`, index, blocks };
  });
  assert.equal(rows.length, rowCount);
  assert.equal(new Set(rows.map(row => row.id)).size, rowCount);
  return rows;
}

function errorRecord(context, phase, error) {
  return { phase, name: error?.name || "Error", message: context.redactText(error?.message || String(error)).slice(0, 500) };
}

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
