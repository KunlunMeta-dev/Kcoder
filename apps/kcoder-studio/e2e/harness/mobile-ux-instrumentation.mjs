import { performance } from "node:perf_hooks";

/** Bounded page and routed-network observation; callers supply the original fixture and redaction callbacks. */
export function createMobileUxInstrumentation({
  THREAD_ID,
  captureThreadListFixtureFields,
  createTurnStartErrorFixtureFrame,
  epochNow,
  mobileApiPath,
  parseFrame,
  recordRoutedWebSocketCloseInvocation,
  round,
  rpcIdFingerprint,
  safePath,
  safeWebSocketRouteInfo,
  sha256,
  sumResponseDelayMs,
  waitUntilPerformanceDeadline,
}) {
async function installPageInstrumentation(page, pageId) {
  await page.addInitScript(({ pageId }) => {
    const activeKey = "__phoneUxActiveMeasurementsV1";
    const completedKey = "__phoneUxCompletedMeasurementsV1";
    const debugKey = "__phoneUxEventDebugV1";
    const readStored = key => {
      try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch { return []; }
    };
    const active = new Map(readStored(activeKey).map(measurement => [measurement.id, measurement]));
    const completed = new Map(readStored(completedKey));
    const longTasks = [];
    const events = readStored(debugKey);
    const appSocketKey = "__phoneUxApplicationWebSocketConnectionsV1";
    const appFrameKey = "__phoneUxApplicationWebSocketFramesV1";
    const appSockets = readStored(appSocketKey);
    const appFrames = readStored(appFrameKey);
    const pendingAppFrameWrites = new Set();
    const maxAppSockets = 512;
    const maxAppFrames = 8192;
    let socketOverflowCount = 0;
    let frameOverflowCount = 0;
    let storageWriteFailureCount = 0;
    let appSocketSequence = Math.max(0, ...appSockets.map(row => Number(row.socketId) || 0));
    const storeAppEvidence = () => {
      try {
        sessionStorage.setItem(appSocketKey, JSON.stringify(appSockets));
        sessionStorage.setItem(appFrameKey, JSON.stringify(appFrames));
      } catch { storageWriteFailureCount += 1; }
    };
    const digestFingerprint = async value => {
      const bytes = new TextEncoder().encode(String(value));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    };
    const applicationRouteInfo = async rawUrl => {
      try {
        const parsed = new URL(rawUrl, location.href);
        const fingerprint = async names => {
          for (const name of names) {
            const value = parsed.searchParams.get(name);
            if (value) return (await digestFingerprint(`${name}:${value}`)).slice(0, 12);
          }
          return null;
        };
        return {
          path: parsed.pathname,
          serverFingerprint: await fingerprint(["serverId", "server"]),
          channelFingerprint: await fingerprint(["channelId", "channel"]),
          workspaceFingerprint: await fingerprint(["workspaceId", "workspace"]),
        };
      } catch {
        return { path: "<invalid-url>", serverFingerprint: null, channelFingerprint: null, workspaceFingerprint: null };
      }
    };
    const recordApplicationFrame = (socket, direction, raw, atEpochMs, eventTimestampEpochMs = null) => {
      const pending = (async () => {
        if (typeof raw !== "string") return;
        let frame;
        try { frame = JSON.parse(raw); } catch { return; }
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
        const hasId = Object.hasOwn(frame, "id");
        const hasResult = Object.hasOwn(frame, "result");
        const hasError = Object.hasOwn(frame, "error");
        const method = typeof frame.method === "string" ? frame.method : null;
        if (!hasId && !hasResult && !hasError && method === null) return;
        const idFingerprint = hasId ? (await digestFingerprint(frame.id)).slice(0, 16) : null;
        const routeInfo = await socket.routeInfo;
        if (appFrames.length >= maxAppFrames) {
          frameOverflowCount += 1;
          return;
        }
        appFrames.push({
          pageId,
          direction,
          socketId: socket.socketId,
          ...routeInfo,
          method,
          rpcIdFingerprint: idFingerprint,
          hasId,
          hasResult,
          hasError,
          atEpochMs: Number(atEpochMs.toFixed(3)),
          eventTimestampEpochMs: Number.isFinite(eventTimestampEpochMs) ? Number(eventTimestampEpochMs.toFixed(3)) : null,
        });
        storeAppEvidence();
      })();
      pendingAppFrameWrites.add(pending);
      void pending.finally(() => pendingAppFrameWrites.delete(pending));
    };
    const NativeWebSocket = window.WebSocket;
    const nativeSend = NativeWebSocket.prototype.send;
    const socketMetadata = new WeakMap();
    NativeWebSocket.prototype.send = function phoneUxInstrumentedSend(raw) {
      const socket = socketMetadata.get(this);
      if (socket) recordApplicationFrame(socket, "sent", raw, performance.timeOrigin + performance.now());
      return nativeSend.call(this, raw);
    };
    const InstrumentedWebSocket = function PhoneUxInstrumentedWebSocket(...args) {
      if (!new.target) throw new TypeError("WebSocket constructor requires 'new'");
      const socket = Reflect.construct(NativeWebSocket, args, NativeWebSocket);
      const metadata = {
        pageId,
        socketId: ++appSocketSequence,
        routeInfo: applicationRouteInfo(args[0]),
      };
      socketMetadata.set(socket, metadata);
      const pendingSocketCapture = metadata.routeInfo.then(routeInfo => {
        if (appSockets.length >= maxAppSockets) {
          socketOverflowCount += 1;
          return;
        }
        appSockets.push({
          pageId,
          socketId: metadata.socketId,
          ...routeInfo,
          atEpochMs: Number((performance.timeOrigin + performance.now()).toFixed(3)),
        });
        storeAppEvidence();
      });
      pendingAppFrameWrites.add(pendingSocketCapture);
      void pendingSocketCapture.finally(() => pendingAppFrameWrites.delete(pendingSocketCapture));
      socket.addEventListener("message", event => {
        const callbackEpochMs = performance.timeOrigin + performance.now();
        const eventTimestampEpochMs = performance.timeOrigin + event.timeStamp;
        recordApplicationFrame(metadata, "received", event.data, callbackEpochMs, eventTimestampEpochMs);
      });
      return socket;
    };
    Object.setPrototypeOf(InstrumentedWebSocket, NativeWebSocket);
    InstrumentedWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = InstrumentedWebSocket;
    window.__phoneUxDrainApplicationWebSocketEvidence = async () => {
      while (pendingAppFrameWrites.size > 0) await Promise.all([...pendingAppFrameWrites]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      while (pendingAppFrameWrites.size > 0) await Promise.all([...pendingAppFrameWrites]);
      const evidence = {
        pageId,
        sockets: appSockets.slice(),
        frames: appFrames.slice(),
        socketOverflowCount,
        frameOverflowCount,
        storageWriteFailureCount,
        maxSocketsPerPage: maxAppSockets,
        maxFramesPerPage: maxAppFrames,
      };
      appSockets.length = 0;
      appFrames.length = 0;
      storeAppEvidence();
      return evidence;
    };
    storeAppEvidence();
    const absoluteNow = () => performance.timeOrigin + performance.now();
    const persist = () => {
      try {
        sessionStorage.setItem(activeKey, JSON.stringify([...active.values()]));
        sessionStorage.setItem(completedKey, JSON.stringify([...completed.entries()].slice(-64)));
        sessionStorage.setItem(debugKey, JSON.stringify(events.slice(-64)));
      } catch {}
    };
    const noteEvent = (measurement, eventType, target) => {
      events.push({ id: measurement.id, eventType, targetTag: target?.tagName ?? null, targetTestId: target?.getAttribute?.("data-testid") ?? null, at: Number(absoluteNow().toFixed(3)) });
      if (events.length > 64) events.splice(0, events.length - 64);
    };
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const passiveStrictVisibility = (element, hitTestAttribution = element) => {
      const hidden = reason => ({ visible: false, reason });
      if (document.visibilityState !== "visible") return hidden("document-not-visible");
      if (!(element instanceof Element) || !element.isConnected || element.getClientRects().length === 0) return hidden("no-connected-layout-box");
      const rect = element.getBoundingClientRect();
      if (![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
        return hidden("empty-or-invalid-element-bounds");
      }
      const visualViewport = window.visualViewport;
      const viewportLeft = Number.isFinite(visualViewport?.offsetLeft) ? visualViewport.offsetLeft : 0;
      const viewportTop = Number.isFinite(visualViewport?.offsetTop) ? visualViewport.offsetTop : 0;
      const viewportWidth = Number.isFinite(visualViewport?.width) ? visualViewport.width : document.documentElement.clientWidth;
      const viewportHeight = Number.isFinite(visualViewport?.height) ? visualViewport.height : document.documentElement.clientHeight;
      if (![viewportLeft, viewportTop, viewportWidth, viewportHeight].every(Number.isFinite) || viewportWidth <= 0 || viewportHeight <= 0) {
        return hidden("invalid-visual-viewport");
      }
      const bounds = {
        left: Math.max(rect.left, viewportLeft),
        top: Math.max(rect.top, viewportTop),
        right: Math.min(rect.right, viewportLeft + viewportWidth),
        bottom: Math.min(rect.bottom, viewportTop + viewportHeight),
      };
      const clips = value => ["hidden", "clip", "scroll", "auto", "overlay"].includes(value);
      let ancestor = element;
      let depth = 0;
      while (ancestor instanceof Element && depth < 64) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return hidden("hidden-ancestor-style");
        const opacity = Number.parseFloat(style.opacity);
        if (Number.isFinite(opacity) && opacity <= 0) return hidden("transparent-ancestor");
        if (ancestor !== element && (clips(style.overflowX) || clips(style.overflowY))) {
          const ancestorRect = ancestor.getBoundingClientRect();
          const scaleX = ancestor.offsetWidth > 0 ? ancestorRect.width / ancestor.offsetWidth : 1;
          const scaleY = ancestor.offsetHeight > 0 ? ancestorRect.height / ancestor.offsetHeight : 1;
          const clipLeft = ancestorRect.left + ancestor.clientLeft * scaleX;
          const clipTop = ancestorRect.top + ancestor.clientTop * scaleY;
          const clipRight = clipLeft + ancestor.clientWidth * scaleX;
          const clipBottom = clipTop + ancestor.clientHeight * scaleY;
          if (clips(style.overflowX)) {
            bounds.left = Math.max(bounds.left, clipLeft);
            bounds.right = Math.min(bounds.right, clipRight);
          }
          if (clips(style.overflowY)) {
            bounds.top = Math.max(bounds.top, clipTop);
            bounds.bottom = Math.min(bounds.bottom, clipBottom);
          }
        }
        if (ancestor === document.documentElement) break;
        ancestor = ancestor.parentElement;
        depth += 1;
      }
      if (depth >= 64 || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return hidden("clipped-outside-visible-bounds");
      const insetX = Math.min(1, (bounds.right - bounds.left) / 4);
      const insetY = Math.min(1, (bounds.bottom - bounds.top) / 4);
      const left = bounds.left + insetX;
      const right = bounds.right - insetX;
      const top = bounds.top + insetY;
      const bottom = bounds.bottom - insetY;
      const attributionIsParent = hitTestAttribution instanceof Element
        && hitTestAttribution !== element && hitTestAttribution.contains(element);
      const elementIgnoresHitTesting = getComputedStyle(element).pointerEvents === "none";
      const points = [
        [(left + right) / 2, (top + bottom) / 2],
        [left, top], [right, top], [left, bottom], [right, bottom],
      ];
      const hit = points.some(([x, y]) => {
        const hitElement = document.elementFromPoint(x, y);
        return hitElement === element || (hitElement instanceof Node && element.contains(hitElement))
          || (elementIgnoresHitTesting && attributionIsParent && hitElement === hitTestAttribution);
      });
      return hit ? { visible: true, reason: "viewport-intersection-hit-test" } : hidden("occluded-or-not-hit-testable");
    };
    const matches = (target, selector) => {
      if (!(target instanceof Element)) return false;
      try { return Boolean(target.closest(selector)); } catch { return false; }
    };
    const roundPageTimestamp = value => Number.isFinite(value) ? Number(value.toFixed(3)) : null;
    const pageClockNow = () => {
      const pagePerformanceMs = performance.now();
      const timeOriginEpochMs = performance.timeOrigin;
      return {
        pagePerformanceMs: roundPageTimestamp(pagePerformanceMs),
        epochMs: Number.isFinite(timeOriginEpochMs) && Number.isFinite(pagePerformanceMs)
          ? roundPageTimestamp(timeOriginEpochMs + pagePerformanceMs)
          : null,
      };
    };
    const domEventClock = event => {
      const eventTimeStampMs = Number(event?.timeStamp);
      const now = performance.now();
      const timeOriginEpochMs = performance.timeOrigin;
      const originValid = Number.isFinite(timeOriginEpochMs) && timeOriginEpochMs > 0;
      const relativeTimestampValid = Number.isFinite(eventTimeStampMs) && eventTimeStampMs >= 0
        && Number.isFinite(now) && eventTimeStampMs <= now + 2;
      const timeStampDomainValid = originValid && relativeTimestampValid;
      return {
        isTrusted: event?.isTrusted === true,
        timeStampDomain: "DOMHighResTimeStamp relative to performance.timeOrigin",
        timeStampDomainValid,
        timeOriginEpochMs: originValid ? roundPageTimestamp(timeOriginEpochMs) : null,
        eventTimeStampMs: timeStampDomainValid ? roundPageTimestamp(eventTimeStampMs) : null,
        eventEpochMs: timeStampDomainValid ? roundPageTimestamp(timeOriginEpochMs + eventTimeStampMs) : null,
        missingReason: timeStampDomainValid ? null : "event.timeStamp was outside the page performance time domain",
      };
    };

    let passiveSendProbe = null;
    const readComposerValue = () => {
      const input = document.querySelector('[data-testid="message-input"]');
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) return input.value;
      return input instanceof HTMLElement ? input.innerText ?? "" : "";
    };
    const findPassiveSendCandidate = probe => {
      for (const card of document.querySelectorAll('[data-testid="failed-submission"]')) {
        const content = card.querySelector('[data-testid="failed-submission-content"]');
        if (!content || (content.innerText ?? "").trim() !== probe.messageText
          || !passiveStrictVisibility(card).visible || !passiveStrictVisibility(content, card).visible) continue;
        if (probe.kind === "rejected-send") {
          const error = card.querySelector('[data-testid="failed-submission-error"]');
          if (passiveStrictVisibility(error, card).visible) return { kind: "definite-rejection-error", node: card };
        }
        return { kind: "pending-submission-content", node: card };
      }
      if (probe.kind === "accepted-send") {
        for (const node of document.querySelectorAll('[data-testid="message-user"]')) {
          if ((node.innerText ?? "").includes(probe.messageText) && passiveStrictVisibility(node).visible) {
            return { kind: "accepted-transcript-message", node };
          }
        }
      }
      return null;
    };
    const passiveSendSnapshot = probe => {
      const event = probe.pointerEvent;
      const firstFeedback = probe.firstFeedback;
      const stableTwoRaf = probe.stableTwoRaf;
      return {
        schemaVersion: 1,
        actionId: probe.actionId,
        status: probe.status,
        targetKind: probe.kind,
        messageFingerprint: probe.messageFingerprint,
        inputEvent: event ? {
          isTrusted: event.isTrusted,
          eventType: event.eventType,
          targetMatched: event.targetMatched,
          messageMatched: event.messageMatched,
          timeStampDomain: event.timeStampDomain,
          timeStampDomainValid: event.timeStampDomainValid,
          timeOriginEpochMs: event.timeOriginEpochMs,
          eventTimeStampMs: event.eventTimeStampMs,
          eventEpochMs: event.eventEpochMs,
          callbackPagePerformanceMs: event.callbackPagePerformanceMs,
          missingReason: event.missingReason,
        } : null,
        firstFeedback,
        stableTwoRaf,
        timingsMs: {
          trustedPointerdownToFirstVisibleFeedback: event?.timeStampDomainValid && Number.isFinite(firstFeedback?.epochMs)
            ? roundPageTimestamp(firstFeedback.epochMs - event.eventEpochMs) : null,
          trustedPointerdownToStableTwoRaf: event?.timeStampDomainValid && stableTwoRaf?.complete && Number.isFinite(stableTwoRaf.secondFrame?.epochMs)
            ? roundPageTimestamp(stableTwoRaf.secondFrame.epochMs - event.eventEpochMs) : null,
        },
      };
    };
    const scanPassiveSendFeedback = probe => {
      if (!probe || probe.status !== "WAITING_FOR_FEEDBACK" || !probe.pointerEvent) return;
      const candidate = findPassiveSendCandidate(probe);
      if (!candidate) return;
      const identity = `${candidate.kind}:${probe.messageFingerprint}`;
      const now = pageClockNow();
      if (!probe.firstFeedback) {
        probe.firstFeedback = {
          kind: candidate.kind,
          targetTestId: candidate.node.getAttribute("data-testid"),
          messageFingerprint: probe.messageFingerprint,
          exactMessageIdentity: true,
          visible: true,
          pagePerformanceMs: now.pagePerformanceMs,
          epochMs: now.epochMs,
        };
      }
      if (probe.stableTwoRaf || probe.scheduledIdentity === identity) return;
      probe.scheduledIdentity = identity;
      const generation = ++probe.scheduleGeneration;
      requestAnimationFrame(() => {
        if (probe.scheduleGeneration !== generation || probe.status !== "WAITING_FOR_FEEDBACK") return;
        const firstFrameCandidate = findPassiveSendCandidate(probe);
        if (!firstFrameCandidate || `${firstFrameCandidate.kind}:${probe.messageFingerprint}` !== identity) {
          probe.scheduledIdentity = null;
          scanPassiveSendFeedback(probe);
          return;
        }
        const firstFrame = pageClockNow();
        requestAnimationFrame(() => {
          if (probe.scheduleGeneration !== generation || probe.status !== "WAITING_FOR_FEEDBACK") return;
          const secondFrameCandidate = findPassiveSendCandidate(probe);
          if (!secondFrameCandidate || `${secondFrameCandidate.kind}:${probe.messageFingerprint}` !== identity) {
            probe.scheduledIdentity = null;
            scanPassiveSendFeedback(probe);
            return;
          }
          const secondFrame = pageClockNow();
          probe.stableTwoRaf = {
            complete: true,
            kind: candidate.kind,
            targetTestId: candidate.node.getAttribute("data-testid"),
            messageFingerprint: probe.messageFingerprint,
            exactMessageIdentityAtBothFrames: true,
            firstFrame,
            secondFrame,
          };
          probe.status = "CAPTURED";
          probe.observer?.disconnect();
          probe.observer = null;
        });
      });
    };
    document.addEventListener("pointerdown", event => {
      const probe = passiveSendProbe;
      if (!probe || probe.status !== "ARMED" || !event.isTrusted
        || !matches(event.target, '[data-testid="send-message"]')) return;
      const messageMatched = readComposerValue() === probe.messageText;
      if (!messageMatched) {
        probe.rejectedTrustedInput = { targetMatched: true, messageMatched: false };
        return;
      }
      const clock = domEventClock(event);
      const callbackPagePerformanceMs = pageClockNow().pagePerformanceMs;
      probe.pointerEvent = {
        ...clock,
        eventType: event.type,
        targetMatched: true,
        messageMatched: true,
        callbackPagePerformanceMs,
      };
      probe.status = "WAITING_FOR_FEEDBACK";
      probe.observer = new MutationObserver(() => scanPassiveSendFeedback(probe));
      probe.observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      scanPassiveSendFeedback(probe);
    }, true);
    window.__phoneUxArmPassiveSendV1 = spec => {
      if (!spec || typeof spec.actionId !== "string" || typeof spec.messageText !== "string"
        || typeof spec.messageFingerprint !== "string" || !["accepted-send", "rejected-send"].includes(spec.kind)) {
        return { armed: false, reason: "invalid exact sample identity" };
      }
      passiveSendProbe?.observer?.disconnect();
      passiveSendProbe = {
        actionId: spec.actionId,
        kind: spec.kind,
        messageText: spec.messageText,
        messageFingerprint: spec.messageFingerprint,
        status: "ARMED",
        pointerEvent: null,
        firstFeedback: null,
        stableTwoRaf: null,
        observer: null,
        scheduledIdentity: null,
        scheduleGeneration: 0,
        rejectedTrustedInput: null,
      };
      return { armed: true, actionId: spec.actionId, messageFingerprint: spec.messageFingerprint };
    };
    window.__phoneUxGetPassiveSendV1 = actionId => passiveSendProbe?.actionId === actionId ? passiveSendSnapshot(passiveSendProbe) : null;
    window.__phoneUxClearPassiveSendV1 = actionId => {
      if (passiveSendProbe?.actionId !== actionId) return false;
      passiveSendProbe.observer?.disconnect();
      passiveSendProbe = null;
      return true;
    };

    let passiveBackgroundProbe = null;
    const readPassiveBackgroundTarget = probe => {
      const node = document.querySelector(probe.selector);
      const textMatches = Boolean(node) && (node.innerText ?? "") === probe.expectedText;
      const visibility = passiveStrictVisibility(node);
      return { node, visible: visibility.visible, visibilityReason: visibility.reason, textMatches, exactContentVisible: visibility.visible && textMatches };
    };
    const passiveBackgroundSnapshot = probe => ({
      schemaVersion: 1,
      actionId: probe.actionId,
      status: probe.status,
      view: probe.view,
      selector: probe.selector,
      contentFingerprint: probe.contentFingerprint,
      hiddenEvent: probe.hiddenEvent,
      activeEvent: probe.activeEvent,
      stableTwoRaf: probe.stableTwoRaf,
      timingsMs: {
        trustedVisibleEventToStableTwoRaf: probe.activeEvent?.timeStampDomainValid && probe.stableTwoRaf?.complete
          && Number.isFinite(probe.stableTwoRaf.secondFrame?.epochMs)
          ? roundPageTimestamp(probe.stableTwoRaf.secondFrame.epochMs - probe.activeEvent.eventEpochMs) : null,
      },
    });
    document.addEventListener("visibilitychange", event => {
      const probe = passiveBackgroundProbe;
      if (!probe || !event.isTrusted) return;
      const clock = domEventClock(event);
      if (document.visibilityState === "hidden" && !probe.hiddenEvent && !probe.activeEvent) {
        probe.hiddenEvent = { ...clock, visibilityState: "hidden" };
        return;
      }
      if (document.visibilityState !== "visible" || !probe.hiddenEvent || probe.activeEvent) return;
      probe.activeEvent = { ...clock, visibilityState: "visible" };
      requestAnimationFrame(() => {
        const firstFrameTarget = readPassiveBackgroundTarget(probe);
        const firstFrame = { ...pageClockNow(), visible: firstFrameTarget.visible, exactContentMatch: firstFrameTarget.textMatches };
        requestAnimationFrame(() => {
          const secondFrameTarget = readPassiveBackgroundTarget(probe);
          const secondFrame = { ...pageClockNow(), visible: secondFrameTarget.visible, exactContentMatch: secondFrameTarget.textMatches };
          probe.stableTwoRaf = {
            complete: firstFrame.visible && firstFrame.exactContentMatch && secondFrame.visible && secondFrame.exactContentMatch,
            contentFingerprint: probe.contentFingerprint,
            exactRetainedContentAtBothFrames: firstFrame.exactContentMatch && secondFrame.exactContentMatch,
            firstFrame,
            secondFrame,
          };
          probe.status = "CAPTURED";
        });
      });
    }, true);
    window.__phoneUxArmPassiveBackgroundV1 = spec => {
      if (!spec || typeof spec.actionId !== "string" || typeof spec.selector !== "string"
        || typeof spec.expectedText !== "string" || typeof spec.contentFingerprint !== "string"
        || !["home", "task"].includes(spec.view) || document.visibilityState !== "visible") {
        return { armed: false, reason: "invalid retained-content identity or page visibility" };
      }
      const target = readPassiveBackgroundTarget(spec);
      if (!target.exactContentVisible) return { armed: false, reason: "exact retained content was not visible at arm time" };
      passiveBackgroundProbe = {
        actionId: spec.actionId,
        view: spec.view,
        selector: spec.selector,
        expectedText: spec.expectedText,
        contentFingerprint: spec.contentFingerprint,
        hiddenEvent: null,
        activeEvent: null,
        stableTwoRaf: null,
        status: "WAITING_FOR_VISIBILITY",
      };
      return { armed: true, actionId: spec.actionId, contentFingerprint: spec.contentFingerprint };
    };
    window.__phoneUxGetPassiveBackgroundV1 = actionId => passiveBackgroundProbe?.actionId === actionId ? passiveBackgroundSnapshot(passiveBackgroundProbe) : null;
    window.__phoneUxClearPassiveBackgroundV1 = actionId => {
      if (passiveBackgroundProbe?.actionId !== actionId) return false;
      passiveBackgroundProbe = null;
      return true;
    };
    const stillReady = measurement => {
      const element = document.querySelector(measurement.targetSelector);
      const textMatches = measurement.targetText === undefined || (element?.textContent ?? "").includes(measurement.targetText);
      if (measurement.requireTargetTransition) {
        const isVisible = visible(element) && textMatches;
        if (isVisible) measurement.targetWasVisible = true;
        return measurement.targetWasVisible === true && !isVisible;
      }
      let ready = visible(element) === measurement.targetVisible && (measurement.targetVisible ? textMatches : true);
      if (measurement.targetValue !== undefined) ready = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value === measurement.targetValue
        : false;
      return ready;
    };
    const finish = measurement => {
      if (measurement.startedAt === null || measurement.domReadyAt !== null || !stillReady(measurement)) return;
      measurement.domReadyAt = absoluteNow();
      measurement.domReadyMs = Number((measurement.domReadyAt - measurement.startedAt).toFixed(3));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!stillReady(measurement)) {
          measurement.domReadyAt = null;
          measurement.domReadyMs = null;
          persist();
          return;
        }
        measurement.finishedAt = absoluteNow();
        measurement.paintFeedbackMs = Number((measurement.finishedAt - measurement.startedAt).toFixed(3));
        completed.set(measurement.id, {
          action: measurement.action ?? null,
          startedAtEpochMs: measurement.startedAt,
          domReadyAtEpochMs: measurement.domReadyAt,
          paintFeedbackAtEpochMs: measurement.finishedAt,
          domReadyMs: measurement.domReadyMs,
          paintFeedbackMs: measurement.paintFeedbackMs,
        });
        active.delete(measurement.id);
        persist();
      }));
    };
    window.__phoneUxArm = spec => {
      active.set(spec.id, { ...spec, startedAt: null, domReadyAt: null, finishedAt: null, domReadyMs: null, paintFeedbackMs: null });
      persist();
    };
    window.__phoneUxMeasure = id => completed.get(id) || null;
    window.__phoneUxDebug = ids => {
      const values = Array.isArray(ids) ? ids : [ids];
      return Object.fromEntries(values.map(id => [id, {
        active: active.get(id) ?? null,
        completed: completed.get(id) ?? null,
        events: events.filter(event => event.id === id),
        url: location.href,
      }]));
    };
    const begin = (event, eventType) => {
      for (const measurement of active.values()) {
        if (measurement.targetValue !== undefined && eventType !== "input") continue;
        if (measurement.targetValue === undefined && eventType !== "pointerdown") continue;
        if (measurement.startedAt !== null || !matches(event.target, measurement.sourceSelector)) continue;
        measurement.startedAt = absoluteNow();
        measurement.eventType = eventType;
        noteEvent(measurement, eventType, event.target);
        persist();
        if (eventType === "input") finish(measurement);
      }
    };
    document.addEventListener("pointerdown", event => begin(event, "pointerdown"), true);
    document.addEventListener("click", event => begin(event, "click"), true);
    document.addEventListener("input", event => begin(event, "input"), true);
    new MutationObserver(() => {
      for (const measurement of active.values()) finish(measurement);
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    for (const measurement of active.values()) finish(measurement);
    if (typeof PerformanceObserver === "function") {
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) longTasks.push({ startTimeMs: Number(entry.startTime.toFixed(3)), durationMs: Number(entry.duration.toFixed(3)) });
        }).observe({ type: "longtask", buffered: true });
      } catch {}
    }
    window.__phoneUxLongTasks = () => longTasks.slice();
  }, { pageId });
}

async function installNetworkInstrumentation(page, pageId, ledger, delayControl, gatewayCalls) {
  page.on("websocket", socket => {
    const routeInfo = safeWebSocketRouteInfo(socket.url());
    const path = routeInfo.path;
    const socketId = ++ledger.browserSocketSequence;
    const atMs = round(performance.now());
    ledger.browserWebSocketPaths.push(path);
    ledger.browserWebSocketConnections.push({ id: socketId, ...routeInfo, atMs, atEpochMs: round(epochNow()), stage: ledger.currentStage, actionId: ledger.currentActionId });
    const recordFrame = (direction, event) => {
      const frame = parseFrame(event?.payload);
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
      const method = typeof frame.method === "string" ? frame.method : null;
      const hasId = Object.hasOwn(frame, "id");
      const hasResult = Object.hasOwn(frame, "result");
      const hasError = Object.hasOwn(frame, "error");
      if (method === null && !hasId && !hasResult && !hasError) return;
      if (direction === "sent" && method !== null) ledger.browserFrameMethodCounts[method] = (ledger.browserFrameMethodCounts[method] ?? 0) + 1;
      ledger.browserFrames.push({
        direction,
        socketId,
        ...routeInfo,
        method,
        rpcIdFingerprint: hasId ? rpcIdFingerprint(frame.id) : null,
        hasId,
        hasResult,
        hasError,
        atMs: round(performance.now()),
        atEpochMs: round(epochNow()),
        stage: ledger.currentStage,
        actionId: ledger.currentActionId,
      });
    };
    socket.on("framesent", event => recordFrame("sent", event));
    socket.on("framereceived", event => recordFrame("received", event));
  });
  page.on("request", request => {
    const path = safePath(request.url());
    if (mobileApiPath(path).startsWith("/api/")) ledger.requestStarts.set(request, { path, method: request.method(), at: performance.now() });
  });
  page.on("response", response => {
    const request = response.request();
    const start = ledger.requestStarts.get(request);
    if (!start) return;
    ledger.http.push({ path: start.path, method: start.method, status: response.status(), durationMs: round(performance.now() - start.at), configuredDelayMs: delayControl.delayMs ?? 0 });
  });
  await page.route("**/api/**", async route => {
    ledger.pendingHttpResponses += 1;
    try {
      const path = safePath(route.request().url());
      const apiPath = mobileApiPath(path);
      const method = route.request().method();
      const routeRequestOrdinal = ++ledger.httpRouteRequestSequence;
      const requestStartedAtMs = round(performance.now());
      const requestStartedAtEpochMs = round(epochNow());
      const routeRequest = {
        routeRequestOrdinal,
        path,
        apiPath,
        method,
        stage: ledger.currentStage,
        scenario: delayControl.scenarioId ?? null,
        startedAtMs: requestStartedAtMs,
        startedAtEpochMs: requestStartedAtEpochMs,
      };
      ledger.httpRouteRequests.push(routeRequest);
      const response = await route.fetch();
      const homeRevisionProbe = delayControl.homeServersRevisionDiagnostic;
      if (typeof homeRevisionProbe?.observeHttpResponse === "function") {
        await homeRevisionProbe.observeHttpResponse({
          apiPath,
          request: route.request(),
          routeRequest,
          response,
          ledger,
        });
      }
      const jitter = delayControl.responseJitter?.next("http", apiPath) ?? { sampleIndex: null, delayMs: 0 };
      const configuredDelayMs = sumResponseDelayMs(
        delayControl.delayMs ?? 0,
        apiPath === "/api/servers/status" ? (delayControl.statusProbeDelayMs ?? 0) : 0,
        delayControl.httpPathDelayMs?.[apiPath] ?? 0,
        jitter.delayMs,
      );
      const responsePathHoldStartedAt = performance.now();
      const responsePathHoldDeadline = responsePathHoldStartedAt + configuredDelayMs;
      if (configuredDelayMs > 0) await waitUntilPerformanceDeadline(responsePathHoldDeadline);
      const appliedDelayMs = round(performance.now() - responsePathHoldStartedAt);
      const injectedStatus = delayControl.httpStatusOverrides?.[apiPath];
      if (Number.isInteger(injectedStatus)) {
        await route.fulfill({ response, status: injectedStatus });
        ledger.injectedHttpStatuses.push({ path, apiPath, status: injectedStatus, stage: ledger.currentStage, scenario: delayControl.scenarioId ?? null });
      } else {
        await route.fulfill({ response });
      }
      ledger.httpResponsePathDelays.push({
        routeRequestOrdinal,
        path,
        apiPath,
        method,
        requestStartedAtMs,
        requestStartedAtEpochMs,
        forwardedAtEpochMs: round(epochNow()),
        configuredDelayMs,
        jitterSampleIndex: jitter.sampleIndex,
        jitterDelayMs: jitter.delayMs,
        appliedDelayMs,
        ...(routeRequest.manualStatusHoldApplied === true ? {
          testControlledManualRelease: true,
          manualReleaseRequestedAtEpochMs: homeRevisionProbe?.statusHold?.releaseRequestedAtEpochMs ?? null,
          manualReleaseCompletedAtEpochMs: homeRevisionProbe?.statusHold?.releasedAtEpochMs ?? null,
        } : {}),
        status: injectedStatus ?? response.status(),
        stage: ledger.currentStage,
        scenario: delayControl.scenarioId ?? null,
      });
    } finally {
      ledger.pendingHttpResponses = Math.max(0, ledger.pendingHttpResponses - 1);
    }
  });
  const methodResponseHoldTimers = new Set();
  page.on("close", () => {
    const cancelledHoldCount = methodResponseHoldTimers.size;
    for (const timer of methodResponseHoldTimers) clearTimeout(timer);
    methodResponseHoldTimers.clear();
    ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - cancelledHoldCount);
  });
  await page.routeWebSocket(url => url.pathname.endsWith("/rpc"), socket => {
    const routeSocketId = ++ledger.routedSocketSequence;
    const socketUrl = typeof socket.url === "function" ? socket.url() : socket.url;
    const routeInfo = typeof socketUrl === "string" ? safeWebSocketRouteInfo(socketUrl) : { path: null };
    ledger.routedWebSocketConnections.push({
      id: routeSocketId,
      owningPageId: pageId,
      ...routeInfo,
      atMs: round(performance.now()),
      atEpochMs: round(epochNow()),
      stage: ledger.currentStage,
      actionId: ledger.currentActionId,
    });
    const upstream = socket.connectToServer();
    const pendingRpc = new Map();
    let deliverQueue = Promise.resolve();
    socket.onMessage(raw => {
      const frame = parseFrame(raw);
      if (typeof frame?.method === "string") {
        const idFingerprint = frame.id !== undefined ? rpcIdFingerprint(frame.id) : null;
        ledger.rpcMethodCounts[frame.method] = (ledger.rpcMethodCounts[frame.method] ?? 0) + 1;
        ledger.rpcEvents.push({
          direction: "request",
          method: frame.method,
          rpcIdFingerprint: idFingerprint,
          hasId: frame.id !== undefined,
          atMs: round(performance.now()),
          atEpochMs: round(epochNow()),
          stage: ledger.currentStage,
          actionId: ledger.currentActionId,
          routeSocketId,
          ...routeInfo,
        });
        if (frame.method === "turn/start" && delayControl.scenarioId) {
          ledger.faultFixtureEvents.push({
            scenario: delayControl.scenarioId,
            kind: "turn-start-request",
            rpcIdFingerprint: idFingerprint,
            threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
            clientMessageIdFingerprint: typeof frame.params?.clientMessageId === "string" ? sha256(frame.params.clientMessageId).slice(0, 16) : null,
            routeSocketId,
            atMs: round(performance.now()),
            stage: ledger.currentStage,
          });
        }
        if (frame.method === "turn/interrupt" && delayControl.scenarioId) {
          ledger.faultFixtureEvents.push({
            scenario: delayControl.scenarioId,
            kind: "turn-interrupt-request",
            rpcIdFingerprint: idFingerprint,
            threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
            turnIdFingerprint: typeof frame.params?.turnId === "string" ? sha256(frame.params.turnId).slice(0, 16) : null,
            routeSocketId,
            atMs: round(performance.now()),
            stage: ledger.currentStage,
          });
        }
        if (frame.method === "turn/start") gatewayCalls.turnStart += 1;
        if (frame.method === "runtime.models.list") gatewayCalls.modelCatalogRpcRequests += 1;
        if (frame.id !== undefined) {
          const receiptRequestIdentity = frame.method === "turn/start"
            ? delayControl.receiptFixture?.observeTurnStartRequest(frame.params, delayControl.receiptScope, routeSocketId)
            : null;
          pendingRpc.set(String(frame.id), {
            method: frame.method,
            stage: ledger.currentStage,
            sentAt: performance.now(),
            sentAtEpochMs: epochNow(),
            rpcIdFingerprint: idFingerprint,
            actionId: ledger.currentActionId,
            routeSocketId,
            threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
            turnIdFingerprint: typeof frame.params?.turnId === "string" ? sha256(frame.params.turnId).slice(0, 16) : null,
            threadListArchived: frame.method === "thread/list" ? frame.params?.archived === true : null,
            threadListCursorPresent: frame.method === "thread/list"
              ? [frame.params?.cursor, frame.params?.nextCursor].some(value => typeof value === "string" && value.length > 0)
              : null,
            receiptRequestIdentity,
            ...routeInfo,
          });
          ledger.pendingRpcMethodCounts[frame.method] = (ledger.pendingRpcMethodCounts[frame.method] ?? 0) + 1;
          if (frame.method === "turn/start" && delayControl.turnStartErrorFixture === true) {
            const request = pendingRpc.get(String(frame.id));
            const errorFrame = createTurnStartErrorFixtureFrame(frame);
            const receivedAt = performance.now();
            const receivedAtEpochMs = epochNow();
            const configuredDelayMs = sumResponseDelayMs(
              delayControl.methodResponseHoldMs?.["turn/start"] ?? 0,
            );
            const eligibleAt = receivedAt + configuredDelayMs;
            ledger.pendingWebSocketDeliveries += 1;
            deliverQueue = deliverQueue
              .then(async () => {
                if (configuredDelayMs > 0) await waitUntilPerformanceDeadline(eligibleAt);
                socket.send(JSON.stringify(errorFrame));
                const deliveredAt = performance.now();
                const appliedDelayMs = round(deliveredAt - receivedAt);
                const fixtureEvent = {
                  scenario: delayControl.scenarioId ?? "unspecified",
                  kind: "turn-start-error-fixture",
                  responseSource: "test-generated request-id-correlated JSON-RPC error at Playwright WebSocket route",
                  requestIdFingerprint: request.rpcIdFingerprint,
                  clientMessageIdFingerprint: typeof frame.params?.clientMessageId === "string" ? sha256(frame.params.clientMessageId).slice(0, 16) : null,
                  threadIdFingerprint: request.threadIdFingerprint,
                  routeSocketId,
                  requestIdPreserved: errorFrame.id === frame.id,
                  errorCode: errorFrame.error.code,
                  configuredDelayMs,
                  appliedDelayMs,
                  stage: request.stage,
                  atMs: round(deliveredAt),
                };
                ledger.websocketFrames += 1;
                ledger.faultFixtureEvents.push(fixtureEvent);
                ledger.websocketResponsePathDelays.push({
                  method: "turn/start",
                  configuredDelayMs,
                  appliedDelayMs,
                  isRpcResponse: true,
                  rpcIdFingerprint: request.rpcIdFingerprint,
                  actionId: request.actionId,
                  routeSocketId,
                  ...routeInfo,
                  receivedAtEpochMs: round(receivedAtEpochMs),
                  forwardedAtEpochMs: round(epochNow()),
                  stage: request.stage,
                  scenario: delayControl.scenarioId ?? null,
                  responseSource: "test-generated request-id-correlated JSON-RPC error; bypasses KCODER_STUDIO_MOCK runMock",
                });
                ledger.rpc.push({
                  method: "turn/start",
                  rpcIdFingerprint: request.rpcIdFingerprint,
                  actionId: request.actionId,
                  routeSocketId,
                  ...routeInfo,
                  durationMs: round(deliveredAt - request.sentAt),
                  configuredDelayMs,
                  methodResponseHoldMs: configuredDelayMs,
                  appliedMethodResponseHoldMs: appliedDelayMs,
                  responsePathAppliedDelayMs: appliedDelayMs,
                  requestSentAtEpochMs: round(request.sentAtEpochMs),
                  responseReceivedAtEpochMs: round(receivedAtEpochMs),
                  responseForwardedAtEpochMs: round(epochNow()),
                  ok: false,
                  errorCode: errorFrame.error.code,
                  responseSource: fixtureEvent.responseSource,
                });
                ledger.methodResponseHolds.push({
                  method: "turn/start",
                  configuredHoldMs: configuredDelayMs,
                  measuredHoldMs: appliedDelayMs,
                  ok: false,
                  responseSource: "test-generated JSON-RPC error fixture",
                  scenario: delayControl.scenarioId ?? null,
                  stage: request.stage,
                });
                ledger.rpcEvents.push({
                  direction: "response-forwarded",
                  method: "turn/start",
                  rpcIdFingerprint: request.rpcIdFingerprint,
                  atMs: round(deliveredAt),
                  atEpochMs: round(epochNow()),
                  stage: request.stage,
                  actionId: request.actionId,
                  routeSocketId,
                  ...routeInfo,
                  ok: false,
                  errorCode: errorFrame.error.code,
                  responseSource: "test-generated JSON-RPC error fixture",
                });
                pendingRpc.delete(String(frame.id));
                ledger.pendingRpcMethodCounts["turn/start"] = Math.max(0, (ledger.pendingRpcMethodCounts["turn/start"] ?? 1) - 1);
              })
              .catch(() => {
                ledger.websocketForwardErrors += 1;
                pendingRpc.delete(String(frame.id));
                ledger.pendingRpcMethodCounts["turn/start"] = Math.max(0, (ledger.pendingRpcMethodCounts["turn/start"] ?? 1) - 1);
              })
              .finally(() => { ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - 1); });
            return;
          }
          if (frame.method === "turn/receipt/read" && delayControl.receiptFixture) {
            const request = pendingRpc.get(String(frame.id));
            const receipt = delayControl.receiptFixture.read(frame.params, delayControl.receiptScope, routeSocketId);
            const response = { jsonrpc: frame.jsonrpc || "2.0", id: frame.id, result: { receipt } };
            socket.send(JSON.stringify(response));
            ledger.rpc.push({
              method: frame.method,
              rpcIdFingerprint: idFingerprint,
              actionId: ledger.currentActionId,
              routeSocketId,
              ...routeInfo,
              durationMs: round(performance.now() - request.sentAt),
              configuredDelayMs: 0,
              methodResponseHoldMs: 0,
              responsePathAppliedDelayMs: 0,
              responseSource: "in-memory fixture populated from observed isolated mock turn/start response",
              ok: Boolean(receipt),
            });
            ledger.rpcEvents.push({
              direction: "response-forwarded",
              method: frame.method,
              rpcIdFingerprint: idFingerprint,
              atMs: round(performance.now()),
              atEpochMs: round(epochNow()),
              stage: ledger.currentStage,
              actionId: ledger.currentActionId,
              routeSocketId,
              ...routeInfo,
              responseSource: "in-memory-test-fixture",
            });
            ledger.faultFixtureEvents.push({
              scenario: delayControl.scenarioId ?? "unspecified",
              kind: "turn-receipt-readback",
              exactObservedAcceptanceMatched: Boolean(receipt),
              receiptScopeFingerprint: receipt ? delayControl.receiptFixture.summary().acceptedIdentityFingerprints.find(row => row.threadIdFingerprint === sha256(frame.params?.threadId).slice(0, 16) && row.clientMessageIdFingerprint === sha256(frame.params?.clientMessageId).slice(0, 16))?.scopeFingerprint ?? null : null,
              threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
              receiptClientMessageIdFingerprint: typeof frame.params?.clientMessageId === "string" ? sha256(frame.params.clientMessageId).slice(0, 16) : null,
              routeSocketId,
              receiptFixtureKind: "in-memory isolated mock only; not durable Rust app-server evidence",
            });
            pendingRpc.delete(String(frame.id));
            ledger.pendingRpcMethodCounts[frame.method] = Math.max(0, (ledger.pendingRpcMethodCounts[frame.method] ?? 1) - 1);
            return;
          }
        }
      }
      upstream.send(raw);
    });
    upstream.onMessage(async raw => {
      const receivedAt = performance.now();
      const receivedAtEpochMs = epochNow();
      let frame = parseFrame(raw);
      const request = frame?.id !== undefined ? pendingRpc.get(String(frame.id)) : null;
      const method = request?.method ?? (typeof frame?.method === "string" ? frame.method : "notification");
      if (request?.method === "thread/list" && Array.isArray(frame?.result?.threads)) {
        const thread = frame.result.threads.find(item => item?.id === THREAD_ID);
        if (thread) {
          const fixtureUpdatedAt = delayControl.homeThreadFixtureUpdatedAtEpochMs;
          const updatedAtFixtureApplied = Number.isFinite(fixtureUpdatedAt);
          if (updatedAtFixtureApplied) thread.updatedAt = fixtureUpdatedAt;
          ledger.homeThreadSnapshots.push({
            stage: request.stage,
            actionId: request.actionId,
            routeSocketId,
            threadIdFingerprint: sha256(thread.id).slice(0, 16),
            fields: captureThreadListFixtureFields(thread),
            updatedAtFixtureApplied,
            responseAtEpochMs: round(receivedAtEpochMs),
          });
        }
      }
      const homeRevisionProbe = delayControl.homeServersRevisionDiagnostic;
      if (typeof homeRevisionProbe?.observeRpcResponse === "function") {
        frame = homeRevisionProbe.observeRpcResponse({
          frame,
          request,
          routeInfo,
          routeSocketId,
          pageId,
          receivedAtEpochMs,
          ledger,
        });
      }
      if (delayControl.scenarioId && ["turn/started", "turn/completed"].includes(frame?.method)) {
        const params = frame.params ?? {};
        ledger.faultFixtureEvents.push({
          scenario: delayControl.scenarioId,
          kind: "turn-lifecycle-upstream-frame",
          method: frame.method,
          threadIdFingerprint: typeof params.threadId === "string" ? sha256(params.threadId).slice(0, 16) : null,
          turnIdFingerprint: typeof params.turnId === "string" ? sha256(params.turnId).slice(0, 16) : null,
          turnStatus: typeof params.turn?.status === "string" ? params.turn.status : null,
          routeSocketId,
          atMs: round(receivedAt),
          stage: ledger.currentStage,
          source: "upstream-mock-gateway-frame",
        });
      }
      if (delayControl.scenarioId && request?.method === "turn/interrupt") {
        ledger.faultFixtureEvents.push({
          scenario: delayControl.scenarioId,
          kind: "turn-interrupt-upstream-response",
          interrupted: frame?.result?.interrupted === true,
          rpcIdFingerprint: request.rpcIdFingerprint,
          threadIdFingerprint: request.threadIdFingerprint,
          turnIdFingerprint: request.turnIdFingerprint,
          routeSocketId,
          atMs: round(receivedAt),
          stage: ledger.currentStage,
          source: "upstream-mock-gateway-response",
        });
      }
      if (delayControl.threadModelFixture && request && ["thread/read", "thread/resume"].includes(request.method) && frame?.result?.thread) {
        frame = {
          ...frame,
          result: {
            ...frame.result,
            thread: { ...frame.result.thread, model: "MiniMax-M3", modelProvider: "kunlunmeta" },
          },
        };
        ledger.faultFixtureEvents.push({
          scenario: delayControl.scenarioId ?? "unspecified",
          kind: "typed-thread-model-fixture",
          method: request.method,
          modelFixture: "mock-minimax from KCODER_STUDIO_MOCK catalog",
          routeSocketId,
        });
      }
      if (request?.method === "initialize" && delayControl.testCapabilities && frame?.result?.capabilities) {
        frame = {
          ...frame,
          result: {
            ...frame.result,
            capabilities: {
              ...frame.result.capabilities,
              experimental: {
                ...frame.result.capabilities.experimental,
                ...delayControl.testCapabilities,
              },
            },
          },
        };
      }
      if (request?.method === "turn/start" && delayControl.receiptFixture) {
        request.receiptAcceptedAtMockResponse = delayControl.receiptFixture.observeTurnStartResponse(request.receiptRequestIdentity, frame, routeSocketId);
      }
      const responseJitter = delayControl.responseJitter?.next("rpc", method) ?? { sampleIndex: null, delayMs: 0 };
      const configuredDelayMs = sumResponseDelayMs(
        delayControl.delayMs ?? 0,
        delayControl.methodDelayMs?.[method] ?? 0,
        responseJitter.delayMs,
      );
      const dropResponse = Boolean(request)
        && delayControl.dropFirstResponseForMethod === method
        && !ledger.injectedWebSocketResponseDrops.some(row => row.scenario === delayControl.scenarioId && row.method === method);
      if (dropResponse) {
        ledger.injectedWebSocketResponseDrops.push({
          scenario: delayControl.scenarioId ?? "unspecified",
          method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          responseReceivedAtEpochMs: round(receivedAtEpochMs),
          acceptedObservedFromMockGateway: method === "turn/start" && request.receiptAcceptedAtMockResponse === true,
          threadIdFingerprint: request.receiptRequestIdentity ? sha256(request.receiptRequestIdentity.threadId).slice(0, 16) : null,
          clientMessageIdFingerprint: request.receiptRequestIdentity ? sha256(request.receiptRequestIdentity.clientMessageId).slice(0, 16) : null,
          receiptScopeFingerprint: request.receiptRequestIdentity?.scopeFingerprint ?? null,
          routeSocketId,
          responseForwarded: false,
          transportLayer: "single JSON-RPC response dropped in Playwright WebSocket route; not IP/TCP packet loss",
        });
        ledger.rpc.push({
          method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          actionId: request.actionId,
          routeSocketId,
          ...routeInfo,
          durationMs: round(performance.now() - request.sentAt),
          configuredDelayMs,
          responsePathAppliedDelayMs: null,
          responseReceivedAtEpochMs: round(receivedAtEpochMs),
          responseForwardedAtEpochMs: null,
          responseDroppedByFixture: true,
          ok: !frame?.error,
        });
        ledger.rpcEvents.push({
          direction: "response-dropped",
          method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          atMs: round(performance.now()),
          atEpochMs: round(epochNow()),
          stage: ledger.currentStage,
          actionId: request.actionId,
          routeSocketId,
          ...routeInfo,
        });
        pendingRpc.delete(String(frame.id));
        ledger.pendingRpcMethodCounts[method] = Math.max(0, (ledger.pendingRpcMethodCounts[method] ?? 1) - 1);
        if (delayControl.closeAfterDroppedResponse) {
          ledger.faultFixtureEvents.push({ scenario: delayControl.scenarioId ?? "unspecified", kind: "socket-closed-after-dropped-response", method });
          recordRoutedWebSocketCloseInvocation(ledger, routeSocketId, { code: 1012, reason: "isolated test reconnect", stage: ledger.currentStage, actionId: ledger.currentActionId });
          await socket.close({ code: 1012, reason: "isolated test reconnect" });
        }
        return;
      }
      // The WSS application delay starts when the upstream response frame arrives.
      const eligibleAt = receivedAt + configuredDelayMs;
      ledger.pendingWebSocketDeliveries += 1;
      const deliver = async appliedMethodResponseHoldMs => {
        ledger.websocketFrames += 1;
        if (configuredDelayMs > 0) await waitUntilPerformanceDeadline(eligibleAt);
        socket.send(frame && JSON.stringify(frame) !== String(raw) ? JSON.stringify(frame) : raw);
        const deliveredAt = performance.now();
        if (delayControl.scenarioId && ["turn/started", "turn/completed"].includes(frame?.method)) {
          const params = frame.params ?? {};
          ledger.faultFixtureEvents.push({
            scenario: delayControl.scenarioId,
            kind: "turn-lifecycle-frame",
            method: frame.method,
            threadIdFingerprint: typeof params.threadId === "string" ? sha256(params.threadId).slice(0, 16) : null,
            turnIdFingerprint: typeof params.turnId === "string" ? sha256(params.turnId).slice(0, 16) : null,
            turnStatus: typeof params.turn?.status === "string" ? params.turn.status : null,
            routeSocketId,
            atMs: round(deliveredAt),
            stage: ledger.currentStage,
            source: "route-forwarded-to-browser",
          });
        }
        const appliedDelayMs = round(deliveredAt - receivedAt);
        ledger.websocketResponsePathDelays.push({
          method,
          configuredDelayMs,
          jitterSampleIndex: responseJitter.sampleIndex,
          jitterDelayMs: responseJitter.delayMs,
          appliedDelayMs,
          isRpcResponse: Boolean(request),
          rpcIdFingerprint: request?.rpcIdFingerprint ?? (frame?.id !== undefined ? rpcIdFingerprint(frame.id) : null),
          actionId: request?.actionId ?? ledger.currentActionId,
          routeSocketId,
          ...routeInfo,
          receivedAtEpochMs: round(receivedAtEpochMs),
          forwardedAtEpochMs: round(epochNow()),
          stage: ledger.currentStage,
          scenario: delayControl.scenarioId ?? null,
        });
        if (request) {
          ledger.rpc.push({
            method,
            rpcIdFingerprint: request.rpcIdFingerprint,
            actionId: request.actionId,
            routeSocketId,
            ...routeInfo,
            durationMs: round(performance.now() - request.sentAt),
            configuredDelayMs,
            methodResponseHoldMs: delayControl.methodResponseHoldMs?.[method] ?? 0,
            appliedMethodResponseHoldMs,
            responsePathAppliedDelayMs: appliedDelayMs,
            requestSentAtEpochMs: round(request.sentAtEpochMs),
            responseReceivedAtEpochMs: round(receivedAtEpochMs),
            responseForwardedAtEpochMs: round(epochNow()),
            ok: !frame?.error,
            timingBoundary: "browser RPC request to delayed response frame delivery through loopback Gateway; not physical RTT",
          });
          if ((delayControl.methodResponseHoldMs?.[method] ?? 0) > 0) ledger.methodResponseHolds.push({
            method,
            configuredHoldMs: delayControl.methodResponseHoldMs[method],
            measuredHoldMs: appliedMethodResponseHoldMs,
            ok: !frame?.error,
            scenario: delayControl.scenarioId ?? null,
            stage: request.stage,
          });
          pendingRpc.delete(String(frame.id));
          ledger.pendingRpcMethodCounts[method] = Math.max(0, (ledger.pendingRpcMethodCounts[method] ?? 1) - 1);
          ledger.rpcEvents.push({
            direction: "response-forwarded",
            method,
            rpcIdFingerprint: request.rpcIdFingerprint,
            atMs: round(performance.now()),
            atEpochMs: round(epochNow()),
            stage: ledger.currentStage,
            actionId: request.actionId,
            routeSocketId,
            ...routeInfo,
            ...(request.homeRevisionThreadListResponse
              ? { homeRevisionThreadListResponse: request.homeRevisionThreadListResponse }
              : {}),
          });
        }
        if (request && delayControl.disconnectAfterMethodResponse === method) {
          const alreadyClosed = ledger.faultFixtureEvents.some(row => row.scenario === delayControl.scenarioId && row.kind === "socket-closed-after-response");
          if (!alreadyClosed) {
            ledger.faultFixtureEvents.push({ scenario: delayControl.scenarioId ?? "unspecified", kind: "socket-closed-after-response", method });
            recordRoutedWebSocketCloseInvocation(ledger, routeSocketId, { code: 1012, reason: "isolated test reconnect", stage: ledger.currentStage, actionId: ledger.currentActionId });
            await socket.close({ code: 1012, reason: "isolated test reconnect" });
          }
        }
      };
      const methodResponseHoldMs = sumResponseDelayMs(delayControl.methodResponseHoldMs?.[method] ?? 0);
      if (methodResponseHoldMs > 0 && request) {
        // Keep the original hold duration boundary at upstream-frame receipt.
        const methodResponseHoldDeadline = receivedAt + methodResponseHoldMs;
        const timer = setTimeout(() => {
          methodResponseHoldTimers.delete(timer);
          void (async () => {
            await waitUntilPerformanceDeadline(methodResponseHoldDeadline);
            const measuredHoldMs = round(performance.now() - receivedAt);
            await deliver(measuredHoldMs);
          })()
            .catch(() => { ledger.websocketForwardErrors += 1; })
            .finally(() => { ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - 1); });
        }, Math.max(0, methodResponseHoldDeadline - performance.now()));
        methodResponseHoldTimers.add(timer);
        return;
      }
      deliverQueue = deliverQueue
        .then(() => deliver(0))
        .catch(() => { ledger.websocketForwardErrors += 1; })
        .finally(() => { ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - 1); });
    });
    socket.onClose(() => {
      ledger.routedWebSocketCloseEvents.push({
        routeSocketId,
        atMs: round(performance.now()),
        atEpochMs: round(epochNow()),
        stage: ledger.currentStage,
        actionId: ledger.currentActionId,
        pendingRequests: [...pendingRpc.values()].map(request => ({
          method: request.method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          routeSocketId,
          startedAtEpochMs: round(request.sentAtEpochMs),
          stage: request.stage,
          actionId: request.actionId,
        })),
      });
      for (const request of pendingRpc.values()) {
        ledger.pendingRpcMethodCounts[request.method] = Math.max(0, (ledger.pendingRpcMethodCounts[request.method] ?? 1) - 1);
      }
      pendingRpc.clear();
    });
  });
}

  return { installPageInstrumentation, installNetworkInstrumentation };
}
