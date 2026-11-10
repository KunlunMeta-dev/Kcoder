// Private historical candidate mechanisms; construction starts no resources.
export function createPrivateScrollV1ViewLedger({
  activeDeltaChunksPerStream,
  assert,
  fixturePageSize,
  parseFrame,
  performance,
  readFile,
  readdir,
  serverId,
  suiteSourceSha256,
  threadId,
  transcriptVirtualizationTraceLimits,
  waitFor,
  waitForTwoFrames,
}) {
function installHistoryAndNotificationFixture(page, state) {
  page.routeWebSocket("**/rpc*", (socket) => {
    const socketUrl = new URL(socket.url());
    const routeOrdinal = state.websocketConnections.length;
    const routeWorkspace = socketUrl.searchParams.get("workspace");
    const routeInfo = {
      routeOrdinal,
      server: socketUrl.searchParams.get("server"),
      channel: socketUrl.searchParams.get("channel"),
      workspace: routeWorkspace,
      workspaceMatchesFixture: routeWorkspace === state.workspacePath,
    };
    state.websocketConnections.push(routeInfo);
    const upstream = socket.connectToServer();
    const socketRecord = { socket, routeInfo, closed: false, closeReason: null };
    state.websocketSocketRecords.push(socketRecord);
    socket.onClose((_code, reason) => {
      socketRecord.closed = true;
      socketRecord.closeReason = String(reason ?? "").slice(0, 100);
    });
    upstream.onClose((_code, reason) => {
      socketRecord.closed = true;
      socketRecord.closeReason = String(reason ?? "").slice(0, 100);
    });
    const requests = new Map();
    socket.onMessage((raw) => {
      const frame = parseFrame(raw);
      if (frame && typeof frame.method === "string") {
        state.rpcMethods[frame.method] = (state.rpcMethods[frame.method] ?? 0) + 1;
        if (frame.id !== undefined) requests.set(String(frame.id), frame);
        if (frame.method === "thread/read" && frame.id !== undefined) {
          state.readRequestStarted(frame);
          if (frame.params?.threadId === threadId
            && routeInfo.server === serverId
            && routeInfo.channel === "runtime"
            && routeInfo.workspaceMatchesFixture) {
            state.activeSocketRoute = { ...routeInfo, threadReadRequestId: frame.id };
            state.activeThreadReadRequestId = frame.id;
          }
        }
      }
      upstream.send(raw);
    });
    upstream.onMessage((raw) => {
      let outbound = raw;
      const frame = parseFrame(raw);
      const request = frame?.id === undefined ? null : requests.get(String(frame.id));
      if (frame && request?.method === "thread/read") {
        if (request.params?.limit === 1) {
          if (frame.id !== undefined) requests.delete(String(frame.id));
          socket.send(raw);
          return;
        }
        const requestedLimit = Number.isSafeInteger(request.params?.limit) && request.params.limit > 0
          ? request.params.limit
          : fixturePageSize;
        const initialHistoryRemaining = Number.isSafeInteger(state.initialHistoryTarget)
          ? Math.max(0, state.initialHistoryTarget - state.historyRowsDelivered)
          : 0;
        const boundedInitialLimit = initialHistoryRemaining > 0
          ? Math.min(requestedLimit, initialHistoryRemaining)
          : requestedLimit;
        const pageData = makeHistoryPage(
          state.historyMessageCount,
          request.params?.beforeCursor,
          boundedInitialLimit,
          state.workspacePath,
          state.markLatestHistoryTailForVisibility,
        );
        frame.result = {
          thread: { id: threadId, title: "Mobile render profile fixture", status: "idle", cwd: state.workspacePath, model: "mock-mobile" },
          ...pageData,
        };
        for (const message of pageData.messages) state.historyMessageIds.add(message.id);
        state.historyRowsDelivered = state.historyMessageIds.size;
        state.historyPages.push({
          requestId: String(frame.id),
          start: pageData.rangeStart,
          end: pageData.rangeEnd,
          count: pageData.messages.length,
          cursor: request.params?.beforeCursor ?? null,
          requestedLimit,
          boundedInitialLimit,
        });
        outbound = JSON.stringify(frame);
        state.historyResponseBytes = (state.historyResponseBytes ?? 0) + Buffer.byteLength(outbound);
      }
      if (frame?.id !== undefined) requests.delete(String(frame.id));
      socket.send(outbound);
    });
  });
}

async function readFocusState(page, step) {
  return page.evaluate((stepName) => {
    const describe = (element) => element instanceof Element ? {
      tag: element.tagName,
      testId: element.getAttribute("data-testid"),
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      ariaExpanded: element.getAttribute("aria-expanded"),
      ariaSelected: element.getAttribute("aria-selected"),
      ariaHidden: element.getAttribute("aria-hidden"),
      inert: element.hasAttribute("inert"),
      className: element instanceof HTMLElement ? String(element.className).slice(0, 100) : null,
      text: String(element.textContent ?? "").trim().slice(0, 80),
    } : null;
    const active = document.activeElement;
    const ancestors = [];
    let current = active instanceof Element ? active : null;
    for (let index = 0; current && index < 6; index += 1, current = current.parentElement) {
      const style = getComputedStyle(current);
      ancestors.push({ ...describe(current), display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents });
    }
    const overlays = [...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-modal="true"], [data-testid*="menu"], [data-testid*="dialog"]')]
      .filter((element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== "none")
      .slice(0, 12)
      .map(describe);
    const tabs = [...document.querySelectorAll('[role="tab"], [data-testid^="workspace-tab-"]')].slice(0, 12).map(describe);
    return {
      step: stepName,
      at: Number(performance.now().toFixed(3)),
      active: describe(active),
      ancestors,
      overlays,
      tabs,
      focusEvents: window.__phoneRenderFocusEvents?.() ?? [],
    };
  }, step);
}

async function connectMobile(page, gateway) {
  const login = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(login?.status(), 200, "isolated fixture Gateway must serve the selected Mobile Web bundle");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  const mockObserver = await page.evaluate(() => window.__phoneRenderInstallMockSocketSendObserver?.() ?? { installed: false, reason: "instrumentation init script did not run" });
  assert.equal(mockObserver.installed, true, `the app-facing Playwright WebSocketMock must be instrumented before Mobile opens its RPC clients: ${JSON.stringify(mockObserver)}`);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });
  const serverToggle = page.getByTestId(`toggle-server-${serverId}`);
  if ((await serverToggle.getAttribute("aria-expanded")) !== "true") await serverToggle.click();
  await page.getByTestId(`thread-${threadId}`).waitFor({ state: "visible", timeout: 30_000 });
}

async function loadHistoryToCount(page, state, targetCount) {
  const expectedRows = targetCount;
  let guard = 0;
  while (state.historyRowsDelivered < expectedRows) {
    assert.ok(guard++ < 50, "history pagination exceeded the fixture safety bound");
    const beforePages = state.historyPages.length;
    const button = page.getByTestId("load-older-messages");
    await button.waitFor({ state: "attached", timeout: 15_000 });
    await button.evaluate((element) => element.click());
    await waitFor(() => Promise.resolve(state.historyPages.length > beforePages), 15_000, "next synthetic thread/read page", 10);
    await waitForTwoFrames(page);
  }
  assert.equal(state.historyRowsDelivered, expectedRows, "fixture pagination must load the exact history row count");
}

function latestLoadedHistoryTail(state) {
  const fixtureHistoryIds = [...state.historyMessageIds]
    .map((id) => ({ id, match: /^history-(\d+)$/.exec(id) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ id: entry.id, index: Number(entry.match[1]) }));
  assert.ok(fixtureHistoryIds.length > 0, "the fixture must have delivered a history row before checking its tail");
  const latest = fixtureHistoryIds.reduce((current, candidate) => candidate.index > current.index ? candidate : current);
  const marker = `HISTORY-${String(latest.index).padStart(4, "0")}-TAIL`;
  const firstPage = state.historyPages[0] ?? null;
  assert.ok(firstPage && firstPage.end - 1 === latest.index, "the initial thread/read page must identify the newest loaded fixture row");
  return {
    fixtureMessageId: latest.id,
    historyIndex: latest.index,
    marker,
    role: latest.index % 2 === 0 ? "user" : "assistant",
    initialPage: {
      start: firstPage.start,
      end: firstPage.end,
      count: firstPage.count,
      cursor: firstPage.cursor,
      requestId: firstPage.requestId,
    },
  };
}

async function readTranscriptViewport(page, expectedTailMarker, includeMarkerGeometry = false, options = {}) {
  return page.evaluate(({ marker, includeMarkerGeometry, captureVirtualizedGeometry, captureMarkerVisibilityDiagnostics, captureScrollportTransform, scrollTraceKey, limits }) => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return { listFound: false, expectedTailMarker: marker };
    const rootRect = list.getBoundingClientRect();
    const scrollables = [list, ...list.querySelectorAll("*")].filter((element) =>
      element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
    ).sort((left, right) =>
      (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight),
    );
    const observedHost = list.querySelector("[data-phone-ux-scroll-host]");
    const host = observedHost instanceof HTMLElement ? observedHost : scrollables[0] ?? list;
    const scrollportTransform = captureScrollportTransform ? getComputedStyle(host).transform : null;
    const rows = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
    const target = typeof marker === "string"
      ? rows.find((row) => (row.textContent ?? "").includes(marker)) ?? null
      : rows.at(-1) ?? null;
    const rowRect = target?.getBoundingClientRect() ?? null;
    let targetMarkerGeometry = null;
    if (includeMarkerGeometry && target && typeof marker === "string" && marker.length > 0) {
      const textNodes = [];
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      let joinedText = "";
      while (textNode) {
        const text = textNode.nodeValue ?? "";
        textNodes.push({ node: textNode, startOffset: joinedText.length, endOffset: joinedText.length + text.length });
        joinedText += text;
        textNode = walker.nextNode();
      }
      const occurrenceOffsets = [];
      for (let offset = joinedText.indexOf(marker); offset >= 0; offset = joinedText.indexOf(marker, offset + 1)) occurrenceOffsets.push(offset);
      const selectedLastOccurrenceOffset = occurrenceOffsets.at(-1) ?? -1;
      const locateTextPosition = (offset) => {
        const textNodeIndex = textNodes.findIndex((entry) => offset >= entry.startOffset && offset < entry.endOffset);
        const segment = textNodes[textNodeIndex];
        return segment ? { node: segment.node, offset: offset - segment.startOffset, textNodeIndex } : null;
      };
      const firstCharacter = selectedLastOccurrenceOffset >= 0 ? locateTextPosition(selectedLastOccurrenceOffset) : null;
      const lastCharacterOffset = selectedLastOccurrenceOffset >= 0 ? selectedLastOccurrenceOffset + marker.length - 1 : -1;
      const lastCharacter = lastCharacterOffset >= 0 ? locateTextPosition(lastCharacterOffset) : null;
      if (firstCharacter && lastCharacter) {
        const fullMarkerRange = document.createRange();
        fullMarkerRange.setStart(firstCharacter.node, firstCharacter.offset);
        fullMarkerRange.setEnd(lastCharacter.node, lastCharacter.offset + 1);
        const markerRangeRects = [...fullMarkerRange.getClientRects()];
        const lastCharacterRange = document.createRange();
        lastCharacterRange.setStart(lastCharacter.node, lastCharacter.offset);
        lastCharacterRange.setEnd(lastCharacter.node, lastCharacter.offset + 1);
        const lastCharacterRangeRects = [...lastCharacterRange.getClientRects()];
        const lastCharacterRect = lastCharacterRange.getBoundingClientRect();
        const rect = {
          top: lastCharacterRect.top,
          bottom: lastCharacterRect.bottom,
          left: lastCharacterRect.left,
          right: lastCharacterRect.right,
          width: lastCharacterRect.width,
          height: lastCharacterRect.height,
        };
        const targetStyle = getComputedStyle(target);
        const listStyle = getComputedStyle(list);
        targetMarkerGeometry = {
          found: true,
          occurrenceCount: occurrenceOffsets.length,
          selectedOccurrenceIndex: occurrenceOffsets.length - 1,
          selectedLastOccurrenceOffset,
          lastCharacterOffset,
          textNodeCount: textNodes.length,
          firstCharacterTextNodeIndex: firstCharacter.textNodeIndex,
          firstCharacterTextNodeOffset: firstCharacter.offset,
          lastCharacterTextNodeIndex: lastCharacter.textNodeIndex,
          lastCharacterTextNodeOffset: lastCharacter.offset,
          rangeCount: markerRangeRects.length,
          lastCharacterRangeCount: lastCharacterRangeRects.length,
          lastCharacterRect: rect,
          visible: rect.width > 0 && rect.height > 0
            && targetStyle.display !== "none" && targetStyle.visibility !== "hidden"
            && listStyle.display !== "none" && listStyle.visibility !== "hidden",
        };
      } else {
        targetMarkerGeometry = {
          found: false,
          occurrenceCount: occurrenceOffsets.length,
          selectedOccurrenceIndex: occurrenceOffsets.length - 1,
          selectedLastOccurrenceOffset,
          lastCharacterOffset,
          textNodeCount: textNodes.length,
          firstCharacterTextNodeIndex: null,
          firstCharacterTextNodeOffset: null,
          lastCharacterTextNodeIndex: null,
          lastCharacterTextNodeOffset: null,
          rangeCount: 0,
          lastCharacterRangeCount: 0,
          lastCharacterRect: null,
          visible: false,
        };
      }
    }
    const targetVisibleWithinMessageList = Boolean(rowRect)
      && rowRect.width > 0 && rowRect.height > 0
      && rowRect.right > rootRect.left && rowRect.left < rootRect.right
      && rowRect.bottom > rootRect.top && rowRect.top < rootRect.bottom;
    const jump = document.querySelector('[data-testid="jump-to-latest"]');
    const jumpRect = jump?.getBoundingClientRect() ?? null;
    const jumpStyle = jump instanceof HTMLElement ? getComputedStyle(jump) : null;
    const jumpOpacity = jumpStyle ? Number.parseFloat(jumpStyle.opacity) : 1;
    const jumpToLatestVisible = Boolean(jumpRect)
      && jumpRect.width > 0 && jumpRect.height > 0
      && jumpStyle?.display !== "none" && jumpStyle?.visibility !== "hidden"
      && Number.isFinite(jumpOpacity) && jumpOpacity > 0.01;
    const composer = document.querySelector('[data-testid="message-input-root"]');
    const composerRect = composer?.getBoundingClientRect() ?? null;
    const composerStyle = composer instanceof HTMLElement ? getComputedStyle(composer) : null;
    const composerOpacity = composerStyle ? Number.parseFloat(composerStyle.opacity) : 1;
    const rectSnapshot = (rect) => rect ? {
      top: Number(rect.top.toFixed(2)),
      bottom: Number(rect.bottom.toFixed(2)),
      left: Number(rect.left.toFixed(2)),
      right: Number(rect.right.toFixed(2)),
      width: Number((rect.width ?? rect.right - rect.left).toFixed(2)),
      height: Number((rect.height ?? rect.bottom - rect.top).toFixed(2)),
    } : null;
    const rectIntersects = (left, right) => Boolean(left && right)
      && left.right > right.left && left.left < right.right
      && left.bottom > right.top && left.top < right.bottom;
    const rectIntersection = (left, right) => {
      if (!left || !right) return null;
      const intersection = {
        left: Math.max(left.left, right.left),
        top: Math.max(left.top, right.top),
        right: Math.min(left.right, right.right),
        bottom: Math.min(left.bottom, right.bottom),
      };
      if (intersection.right <= intersection.left || intersection.bottom <= intersection.top) return null;
      return { ...intersection, width: intersection.right - intersection.left, height: intersection.bottom - intersection.top };
    };
    const hostRect = host.getBoundingClientRect();
    const hostScaleX = host.offsetWidth > 0 ? Math.abs(hostRect.width / host.offsetWidth) : 1;
    const hostScaleY = host.offsetHeight > 0 ? Math.abs(hostRect.height / host.offsetHeight) : 1;
    const scrollportClientRect = {
      left: hostRect.left + host.clientLeft * hostScaleX,
      top: hostRect.top + host.clientTop * hostScaleY,
      right: hostRect.left + (host.clientLeft + host.clientWidth) * hostScaleX,
      bottom: hostRect.top + (host.clientTop + host.clientHeight) * hostScaleY,
    };
    const visualViewportObject = window.visualViewport;
    const visualViewportRect = {
      left: visualViewportObject?.offsetLeft ?? 0,
      top: visualViewportObject?.offsetTop ?? 0,
      right: (visualViewportObject?.offsetLeft ?? 0) + (visualViewportObject?.width ?? window.innerWidth),
      bottom: (visualViewportObject?.offsetTop ?? 0) + (visualViewportObject?.height ?? window.innerHeight),
    };
    const markerRect = targetMarkerGeometry?.lastCharacterRect ?? null;
    const markerCenter = markerRect ? {
      x: (markerRect.left + markerRect.right) / 2,
      y: (markerRect.top + markerRect.bottom) / 2,
    } : null;
    const visibleIntersection = rectIntersection(
      rectIntersection(scrollportClientRect, rootRect),
      visualViewportRect,
    );
    const markerCenterInsideRect = Boolean(markerCenter && visibleIntersection)
      && markerCenter.x >= visibleIntersection.left && markerCenter.x <= visibleIntersection.right
      && markerCenter.y >= visibleIntersection.top && markerCenter.y <= visibleIntersection.bottom;
    const hitElements = markerCenterInsideRect
      ? document.elementsFromPoint(markerCenter.x, markerCenter.y).slice(0, 6)
      : [];
    const topHit = hitElements[0] ?? null;
    const markerCenterHitTargetRow = Boolean(target && topHit && target.contains(topHit));
    const pointInside = (rect, point) => Boolean(rect && point)
      && point.x >= rect.left && point.x <= rect.right
      && point.y >= rect.top && point.y <= rect.bottom;
    const markerCenterCoveredByJump = jumpToLatestVisible && pointInside(jumpRect, markerCenter);
    const composerVisible = Boolean(composerRect && composerRect.width > 0 && composerRect.height > 0)
      && composerStyle?.display !== "none" && composerStyle?.visibility !== "hidden"
      && Number.isFinite(composerOpacity) && composerOpacity > 0.01;
    const markerCenterCoveredByComposer = composerVisible && pointInside(composerRect, markerCenter);
    let visibleStyleAncestors = true;
    let visibleStyleAncestorCount = 0;
    let visibleStyleChainReachedList = false;
    for (let element = target; element instanceof HTMLElement && visibleStyleAncestorCount < 16; element = element.parentElement) {
      const style = getComputedStyle(element);
      const opacity = Number.parseFloat(style.opacity);
      visibleStyleAncestorCount += 1;
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
        || (Number.isFinite(opacity) && opacity <= 0.01) || style.contentVisibility === "hidden") {
        visibleStyleAncestors = false;
      }
      if (element === list) {
        visibleStyleChainReachedList = true;
        break;
      }
    }
    visibleStyleAncestors = visibleStyleAncestors && visibleStyleChainReachedList;
    const targetMarkerVisibilityChecks = {
      markerRangePresent: Boolean(targetMarkerGeometry?.lastCharacterRangeCount > 0),
      markerIntersectsMessageList: rectIntersects(markerRect, rootRect),
      markerIntersectsScrollportClientClip: rectIntersects(markerRect, scrollportClientRect),
      markerIntersectsVisualViewport: rectIntersects(markerRect, visualViewportRect),
      markerCenterInsideCombinedClip: markerCenterInsideRect,
      markerCenterHitTargetRow,
      visibleStyleAncestors,
      visibleStyleAncestorCount,
      visibleStyleChainReachedList,
      markerCenterCoveredByJump,
      markerCenterCoveredByComposer,
    };
    const targetMarkerVisibleWithinMessageList = Boolean(targetMarkerGeometry?.visible)
      && targetMarkerVisibilityChecks.markerRangePresent
      && targetMarkerVisibilityChecks.markerIntersectsMessageList
      && targetMarkerVisibilityChecks.markerIntersectsScrollportClientClip
      && targetMarkerVisibilityChecks.markerIntersectsVisualViewport
      && targetMarkerVisibilityChecks.markerCenterInsideCombinedClip
      && targetMarkerVisibilityChecks.markerCenterHitTargetRow
      && targetMarkerVisibilityChecks.visibleStyleAncestors
      && !targetMarkerVisibilityChecks.markerCenterCoveredByJump
      && !targetMarkerVisibilityChecks.markerCenterCoveredByComposer;
    let targetMarkerVisibilityDiagnostics = null;
    if (captureMarkerVisibilityDiagnostics) {
      const clipAncestors = [];
      let clipAncestorReachedList = false;
      for (let element = target; element instanceof HTMLElement && clipAncestors.length < 12; element = element.parentElement) {
        const style = getComputedStyle(element);
        clipAncestors.push({
          tagName: element.tagName,
          testId: element.getAttribute("data-testid")?.slice(0, 48) ?? null,
          role: element.getAttribute("role")?.slice(0, 32) ?? null,
          rect: rectSnapshot(element.getBoundingClientRect()),
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          clip: style.clip?.slice(0, 120) ?? null,
          clipPath: style.clipPath?.slice(0, 120) ?? null,
          contain: style.contain?.slice(0, 80) ?? null,
          transform: style.transform?.slice(0, 120) ?? null,
          opacity: style.opacity,
          display: style.display,
          visibility: style.visibility,
          pointerEvents: style.pointerEvents,
        });
        if (element === list) {
          clipAncestorReachedList = true;
          break;
        }
      }
      const describeHit = (element) => element instanceof Element ? {
        tagName: element.tagName,
        testId: element.getAttribute("data-testid")?.slice(0, 48) ?? null,
        role: element.getAttribute("role")?.slice(0, 32) ?? null,
        classTokens: typeof element.className === "string" ? element.className.split(/\s+/).filter(Boolean).slice(0, 4) : [],
        rect: rectSnapshot(element.getBoundingClientRect()),
      } : null;
      targetMarkerVisibilityDiagnostics = {
        sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
        expectedMarker: marker,
        targetRowTestId: target?.getAttribute("data-testid") ?? null,
        targetRowRect: rectSnapshot(rowRect),
        lastCharacterRect: rectSnapshot(markerRect),
        messageListRect: rectSnapshot(rootRect),
        scrollport: {
          tagName: host.tagName,
          testId: host.getAttribute("data-testid")?.slice(0, 48) ?? null,
          borderRect: rectSnapshot(hostRect),
          clientClipRect: rectSnapshot(scrollportClientRect),
          clientLeft: host.clientLeft,
          clientTop: host.clientTop,
          clientWidth: host.clientWidth,
          clientHeight: host.clientHeight,
          offsetWidth: host.offsetWidth,
          offsetHeight: host.offsetHeight,
          scaleX: Number(hostScaleX.toFixed(4)),
          scaleY: Number(hostScaleY.toFixed(4)),
          overflowX: getComputedStyle(host).overflowX,
          overflowY: getComputedStyle(host).overflowY,
          transform: getComputedStyle(host).transform?.slice(0, 120) ?? null,
        },
        visualViewport: {
          rect: rectSnapshot(visualViewportRect),
          scale: visualViewportObject?.scale ?? null,
          windowInnerWidth: window.innerWidth,
          windowInnerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
        combinedVisibleClip: rectSnapshot(visibleIntersection),
        composer: {
          visible: composerVisible,
          rect: rectSnapshot(composerRect),
          display: composerStyle?.display ?? null,
          visibility: composerStyle?.visibility ?? null,
          pointerEvents: composerStyle?.pointerEvents ?? null,
        },
        jump: {
          visible: jumpToLatestVisible,
          rect: rectSnapshot(jumpRect),
          display: jumpStyle?.display ?? null,
          visibility: jumpStyle?.visibility ?? null,
          pointerEvents: jumpStyle?.pointerEvents ?? null,
        },
        markerCenter,
        checks: targetMarkerVisibilityChecks,
        hitTestTopToBottom: hitElements.map(describeHit),
        hitTestTopIsTargetRow: markerCenterHitTargetRow,
        clipAncestors,
        clipAncestorTraversalTruncated: !clipAncestorReachedList && clipAncestors.length === 12,
      };
    }
    let virtualizedGeometry = null;
    if (captureVirtualizedGeometry) {
      const rectOf = (element) => {
        if (!(element instanceof Element)) return null;
        const rect = element.getBoundingClientRect();
        return {
          top: Number(rect.top.toFixed(2)),
          bottom: Number(rect.bottom.toFixed(2)),
          left: Number(rect.left.toFixed(2)),
          right: Number(rect.right.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        };
      };
      const rowSelector = '[data-testid="message-user"], [data-testid="message-assistant"]';
      const mountedHistoryRows = rows.slice(0, limits.maxMountedHistoryRowsPerSample)
        .map((row, mountedDomIndex) => {
          const historyIndex = /HISTORY-(\d{4})/.exec(row.textContent ?? "")?.[1];
          if (historyIndex === undefined) return null;
          return {
            mountedDomIndex,
            role: row.getAttribute("data-testid") === "message-user" ? "user" : "assistant",
            historyIndex: Number(historyIndex),
            rect: rectOf(row),
          };
        }).filter(Boolean);
      const contentContainer = host.firstElementChild instanceof HTMLElement ? host.firstElementChild : null;
      const innerContent = contentContainer ? {
        tagName: contentContainer.tagName,
        testId: contentContainer.getAttribute("data-testid")?.slice(0, limits.maxTestIdLength) ?? null,
        childCount: contentContainer.children.length,
        rect: rectOf(contentContainer),
        scrollHeight: contentContainer.scrollHeight,
        clientHeight: contentContainer.clientHeight,
      } : null;
      const emptyLayoutCandidates = [];
      let visitedNodeCount = 0;
      let nodesOmitted = 0;
      let candidatesOmitted = 0;
      let traversalTruncated = false;
      const queue = contentContainer ? [{ element: contentContainer, depth: 0, path: "content" }] : [];
      while (queue.length > 0 && visitedNodeCount < limits.maxWalkNodesPerSample) {
        const current = queue.shift();
        const element = current?.element;
        if (!(element instanceof HTMLElement) || element.matches(rowSelector)) continue;
        visitedNodeCount += 1;
        const rect = rectOf(element);
        let hasDirectText = false;
        let inspectedChildNodes = 0;
        for (let node = element.firstChild; node && inspectedChildNodes < limits.maxChildrenPerNode; node = node.nextSibling) {
          inspectedChildNodes += 1;
          if (node.nodeType === Node.TEXT_NODE && /\S/.test(node.nodeValue ?? "")) hasDirectText = true;
        }
        const childNodesTruncated = inspectedChildNodes === limits.maxChildrenPerNode
          && element.childNodes.length > inspectedChildNodes;
        const children = element.children;
        const childCount = children.length;
        if (childNodesTruncated) traversalTruncated = true;
        if (current.depth > 0 && !hasDirectText && rect && rect.height > 0) {
          if (emptyLayoutCandidates.length < limits.maxEmptyLayoutCandidatesPerSample) {
            emptyLayoutCandidates.push({
              path: current.path.slice(0, limits.maxDomPathLength),
              depth: current.depth,
              kind: childCount === 0 ? "empty-leaf" : "empty-container",
              tagName: element.tagName,
              testId: element.getAttribute("data-testid")?.slice(0, limits.maxTestIdLength) ?? null,
              dataIndex: element.getAttribute("data-index")?.slice(0, 32) ?? null,
              childCount,
              rect,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
            });
          } else {
            candidatesOmitted += 1;
          }
        }
        if (children.length > limits.maxChildrenPerNode) {
          nodesOmitted += children.length - limits.maxChildrenPerNode;
          traversalTruncated = true;
        }
        if (current.depth >= limits.maxDepth) {
          nodesOmitted += Math.min(children.length, limits.maxChildrenPerNode);
          traversalTruncated ||= children.length > 0;
          continue;
        }
        for (let index = 0; index < Math.min(children.length, limits.maxChildrenPerNode); index += 1) {
          const child = children[index];
          if (child.matches(rowSelector)) continue;
          queue.push({
            element: child,
            depth: current.depth + 1,
            path: `${current.path}.${index}`.slice(0, limits.maxDomPathLength),
          });
        }
      }
      if (queue.length > 0) {
        nodesOmitted += queue.length;
        traversalTruncated = true;
      }
      const traceMap = window.__phoneRenderTranscriptVirtualizationTraces;
      const traceEntry = scrollTraceKey && traceMap instanceof Map ? traceMap.get(scrollTraceKey) : null;
      const scrollEventsSincePreviousSample = traceEntry
        ? traceEntry.state.events.splice(0, limits.maxScrollEventsPerSample)
        : [];
      virtualizedGeometry = {
        sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
        innerContent,
        mountedHistoryRows,
        mountedHistoryRowsOmitted: Math.max(0, rows.length - limits.maxMountedHistoryRowsPerSample),
        emptyLayoutCandidates,
        emptyLayoutCandidatesOmitted: candidatesOmitted,
        visitedNodeCount,
        nodesOmitted,
        traversalTruncated,
        scrollTraceStatus: traceEntry ? "ATTACHED" : "UNAVAILABLE",
        scrollEventsSincePreviousSample,
        scrollEventsDroppedTotal: traceEntry?.state.droppedCount ?? null,
      };
    }
    return {
      listFound: true,
      expectedTailMarker: marker ?? null,
      scrollHostTag: host.tagName,
      scrollHostTestId: host.getAttribute("data-testid"),
      scrollportTransform,
      scrollTop: Number(host.scrollTop.toFixed(2)),
      scrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
      bottomGapPx: Math.max(0, Number((host.scrollHeight - host.clientHeight - host.scrollTop).toFixed(2))),
      sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
      messageListRect: { top: rootRect.top, bottom: rootRect.bottom, height: rootRect.height },
      renderedMessageRowCount: rows.length,
      targetRowFound: Boolean(target),
      targetRowTestId: target?.getAttribute("data-testid") ?? null,
      targetRowTextLength: target?.textContent?.length ?? null,
      targetRowRect: rowRect ? { top: rowRect.top, bottom: rowRect.bottom, height: rowRect.height } : null,
      targetVisibleWithinMessageList,
      targetMarkerGeometryIncluded: includeMarkerGeometry,
      targetMarkerOccurrenceCount: targetMarkerGeometry?.occurrenceCount ?? null,
      targetMarkerSelectedOccurrenceIndex: targetMarkerGeometry?.selectedOccurrenceIndex ?? null,
      targetMarkerSelectedLastOccurrenceOffset: targetMarkerGeometry?.selectedLastOccurrenceOffset ?? null,
      targetMarkerTextNodeCount: targetMarkerGeometry?.textNodeCount ?? null,
      targetMarkerFirstCharacterTextNodeIndex: targetMarkerGeometry?.firstCharacterTextNodeIndex ?? null,
      targetMarkerFirstCharacterTextNodeOffset: targetMarkerGeometry?.firstCharacterTextNodeOffset ?? null,
      targetMarkerLastCharacterTextNodeIndex: targetMarkerGeometry?.lastCharacterTextNodeIndex ?? null,
      targetMarkerLastCharacterTextNodeOffset: targetMarkerGeometry?.lastCharacterTextNodeOffset ?? null,
      targetMarkerRangeCount: targetMarkerGeometry?.rangeCount ?? null,
      targetMarkerLastCharacterRangeCount: targetMarkerGeometry?.lastCharacterRangeCount ?? null,
      targetMarkerLastCharacterRect: targetMarkerGeometry?.lastCharacterRect ?? null,
      targetMarkerVisibilityChecks: includeMarkerGeometry ? targetMarkerVisibilityChecks : null,
      targetMarkerVisibilityDiagnostics,
      targetMarkerVisibleWithinMessageList: includeMarkerGeometry ? targetMarkerVisibleWithinMessageList : null,
      jumpToLatestVisible,
      ...(virtualizedGeometry ? { virtualizedGeometry } : {}),
    };
  }, {
    marker: expectedTailMarker,
    includeMarkerGeometry,
    captureVirtualizedGeometry: options.captureVirtualizedGeometry === true,
    captureMarkerVisibilityDiagnostics: options.captureMarkerVisibilityDiagnostics === true,
    captureScrollportTransform: options.captureScrollportTransform === true,
    scrollTraceKey: options.scrollTraceKey ?? null,
    limits: transcriptVirtualizationTraceLimits,
  });
}

async function captureBrowserMemory(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const [heap, dom] = await Promise.all([
      cdp.send("Runtime.getHeapUsage"),
      cdp.send("Memory.getDOMCounters"),
    ]);
    return {
      source: "Chromium CDP Runtime.getHeapUsage and Memory.getDOMCounters; snapshot only, no forced GC",
      usedHeapSizeBytes: heap.usedSize ?? null,
      totalHeapSizeBytes: heap.totalSize ?? null,
      embedderHeapUsedBytes: heap.embedderHeapUsedSize ?? null,
      backingStorageBytes: heap.backingStorageSize ?? null,
      documents: dom.documents ?? null,
      nodes: dom.nodes ?? null,
      eventListeners: dom.jsEventListeners ?? null,
    };
  } catch (error) {
    return { source: "Chromium CDP heap/DOM snapshot unavailable", error: String(error.message || error).slice(0, 240) };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function captureTranscriptEvidence(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="message-list"]');
    const rows = root?.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]') ?? [];
    const scrollHost = root instanceof HTMLElement
      ? [root, ...root.querySelectorAll("*")].filter((element) => element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16).sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0]
      : null;
    return {
      renderedMessageRows: rows.length,
      transcriptScrollHeight: scrollHost?.scrollHeight ?? null,
      transcriptClientHeight: scrollHost?.clientHeight ?? null,
      transcriptMaxScrollTop: scrollHost ? scrollHost.scrollHeight - scrollHost.clientHeight : null,
    };
  });
}

function makeHistoryPage(total, beforeCursor, requestedLimit, fixtureWorkspace, markLatestHistoryTailForVisibility = false) {
  let end = total;
  if (typeof beforeCursor === "string" && /^ux:\d+$/.test(beforeCursor)) end = Number(beforeCursor.slice(3));
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, fixturePageSize) : fixturePageSize;
  const start = Math.max(0, end - limit);
  const messages = Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset;
    return makeHistoryMessage(index, fixtureWorkspace, markLatestHistoryTailForVisibility && index === total - 1);
  });
  return {
    messages,
    rangeStart: start,
    rangeEnd: end,
    hasMoreBefore: start > 0,
    beforeCursor: start > 0 ? `ux:${start}` : null,
  };
}

function makeHistoryMessage(index, fixtureWorkspace, markTranscriptTail = false) {
  const marker = `HISTORY-${String(index).padStart(4, "0")}`;
  const code = Array.from({ length: 18 }, (_, line) => `export function fixture_${index}_${line}(value: number) { return value + ${line}; }`).join("\n");
  const markdown = [
    `# ${marker}: mobile transcript fixture`,
    "",
    `This is a long Markdown history entry used only by the isolated Chromium render profile. It contains a paragraph with enough prose to exercise line wrapping, text layout, and memoized row rendering at a 390 CSS-pixel viewport. ${"A fixed deterministic sentence gives this message a stable text shape. ".repeat(8)}`,
    "",
    "| step | result | detail |",
    "| --- | --- | --- |",
    `| parse | complete | synthetic fixture row ${index} |`,
    "| render | measured | no model request |",
    "",
    "```typescript",
    code,
    "```",
    ...(markTranscriptTail ? [`HISTORY-${String(index).padStart(4, "0")}-TAIL`] : []),
  ].join("\n");
  const blocks = [];
  if (index % 3 === 1) {
    blocks.push({ type: "tool", id: `tool-${index}`, tool_name: "read_file", status: "done", tool_input: { path: `src/fixture-${index}.ts`, range: { start: 1, end: 80 } }, tool_output: `${"tool output line for a long source excerpt; deterministic mock only.\n".repeat(18)}${marker}-TOOL-END` });
  }
  if (index % 5 === 2) {
    blocks.push({ type: "file_changes", fileChanges: { artifactId: `history-artifact-${index}`, workspacePath: fixtureWorkspace, fileCount: 12, additions: 88, deletions: 16, files: Array.from({ length: 12 }, (_, fileIndex) => `${fixtureWorkspace}/history-${index}-${fileIndex}.ts`), status: "active", revertible: true } });
  }
  return {
    id: `history-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: markdown,
    blocks,
    timestampMs: 1_790_000_000_000 + index * 1000,
  };
}

function createPageState(source, count, panelState, fixtureWorkspace, options = {}) {
  const reserveOlderHistoryPage = options.reserveOlderHistoryPage === true;
  return {
    source,
    count,
    panelState,
    workspacePath: fixtureWorkspace,
    historyMessageCount: count - 1 + (reserveOlderHistoryPage ? fixturePageSize : 0),
    initialHistoryTarget: reserveOlderHistoryPage ? count - 1 : null,
    markLatestHistoryTailForVisibility: options.markLatestHistoryTailForVisibility === true,
    historyRowsDelivered: 0,
    historyMessageIds: new Set(),
    historyPages: [],
    initialEntryTailEvidence: null,
    manualHistoryFollowResetEvidence: null,
    rpcMethods: Object.create(null),
    failedRequests: Object.create(null),
    activeThreadReadRequestId: null,
    websocketConnections: [],
    websocketSocketRecords: [],
    notificationBatches: [],
    nextSequence: 1,
    changesPanelMounted: false,
    tabFocusTrace: [],
    fixtureShape: {
      textMessages: count - 1,
      reservedOlderHistoryRows: reserveOlderHistoryPage ? fixturePageSize : 0,
      toolOutputMessages: Math.floor(count / 3),
      fileChangeHistoryMessages: Math.floor((count + 1) / 5),
      markdownCodeMessageBytesApprox: Buffer.byteLength(makeHistoryMessage(0, fixtureWorkspace).content),
      pageSize: fixturePageSize,
    },
    readRequestStarted(frame) {
      const beforeCursor = frame.params?.beforeCursor;
      this.pendingReadRequests = (this.pendingReadRequests ?? 0) + 1;
      this.lastRequestedCursor = beforeCursor ?? null;
    },
  };
}

function areNotificationBatchesOrdered(batches) {
  const expectedMethods = ["turn/started", "item/started", "item/delta", "turn/completed"];
  if (!Array.isArray(batches) || batches.length === 0) return false;
  let previousSequence = -1;
  return batches.every((batch) => {
    if (!batch.dispatchOrderValid || batch.methods.length !== expectedMethods.length || batch.sequences.length !== expectedMethods.length) return false;
    if (batch.methods.some((method, index) => method !== expectedMethods[index])) return false;
    if (batch.sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence <= previousSequence)) return false;
    previousSequence = batch.sequences.at(-1);
    return true;
  });
}

function summarizeObservations(observations) {
  const groups = new Map();
  for (const observation of observations) {
    const key = [observation.source, observation.scenario, observation.requestedMessages, observation.panelState ?? "none"].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const [source, scenario, countText, panelState] = key.split("|");
    const values = entries.filter((entry) => entry.ok && Number.isFinite(entry.durationMs)).map((entry) => entry.durationMs).sort((left, right) => left - right);
    const automationValues = entries.filter((entry) => entry.ok && Number.isFinite(entry.automationElapsedMs)).map((entry) => entry.automationElapsedMs).sort((left, right) => left - right);
    const harnessValues = entries.filter((entry) => entry.ok && Number.isFinite(entry.fixtureHarnessElapsedToAgentRevisionMs)).map((entry) => entry.fixtureHarnessElapsedToAgentRevisionMs).sort((left, right) => left - right);
    const taskValues = entries.filter((entry) => Number.isFinite(entry.synchronousEventTaskMs)).map((entry) => entry.synchronousEventTaskMs).sort((left, right) => left - right);
    const websocketDispatchTaskValues = entries.flatMap((entry) => entry.websocketDispatchHandlerSyncMs ?? []).filter(Number.isFinite).sort((left, right) => left - right);
    return {
      source,
      scenario,
      requestedMessages: Number(countText),
      panelState: panelState === "none" ? null : panelState,
      sampleCount: entries.length,
      successCount: entries.filter((entry) => entry.ok).length,
      errorCount: entries.filter((entry) => !entry.ok).length,
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95),
      maxMs: values.length ? values.at(-1) : null,
      automationElapsedP50Ms: percentile(automationValues, 0.5),
      automationElapsedP95Ms: percentile(automationValues, 0.95),
      automationElapsedMaxMs: automationValues.length ? automationValues.at(-1) : null,
      fixtureHarnessElapsedP50Ms: percentile(harnessValues, 0.5),
      fixtureHarnessElapsedP95Ms: percentile(harnessValues, 0.95),
      fixtureHarnessElapsedMaxMs: harnessValues.length ? harnessValues.at(-1) : null,
      synchronousEventTaskP50Ms: percentile(taskValues, 0.5),
      synchronousEventTaskP95Ms: percentile(taskValues, 0.95),
      synchronousEventTaskMaxMs: taskValues.length ? taskValues.at(-1) : null,
      websocketDispatchHandlerSyncTaskCount: websocketDispatchTaskValues.length,
      websocketDispatchHandlerSyncTaskP50Ms: percentile(websocketDispatchTaskValues, 0.5),
      websocketDispatchHandlerSyncTaskP95Ms: percentile(websocketDispatchTaskValues, 0.95),
      websocketDispatchHandlerSyncTaskMaxMs: websocketDispatchTaskValues.length ? websocketDispatchTaskValues.at(-1) : null,
      longTaskCount: entries.reduce((total, entry) => total + (entry.longTasks?.length ?? 0), 0),
      longTaskMaxMs: Math.max(0, ...entries.flatMap((entry) => (entry.longTasks ?? []).map((task) => task.durationMs))),
    };
  }).sort((left, right) => left.source.localeCompare(right.source) || left.requestedMessages - right.requestedMessages || left.scenario.localeCompare(right.scenario) || String(left.panelState).localeCompare(String(right.panelState)));
}

function summarizeLongTasks(observations) {
  const tasks = observations.flatMap((entry) => entry.longTasks ?? []);
  const durations = tasks.map((task) => task.durationMs).sort((left, right) => left - right);
  return {
    source: "PerformanceObserver longtask API; entries are browser tasks over 50ms",
    count: tasks.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length ? durations.at(-1) : null,
    entries: tasks.slice(0, 500),
  };
}

function summarizeLongAnimationFrames(observations) {
  const streamSamples = observations.filter((entry) => entry.scenario === "active-markdown-stream" && entry.longAnimationFrames);
  const frames = streamSamples.flatMap((entry) => (entry.longAnimationFrames.entries ?? []).map((frame) => ({
    source: entry.source,
    requestedMessages: entry.requestedMessages,
    panelState: entry.panelState,
    ...frame,
  })));
  const scripts = new Map();
  for (const frame of frames) {
    for (const script of frame.scripts ?? []) {
      const key = `${script.sourceFunctionName}|${script.sourceUrlPath}|${script.invokerType}|${script.invoker}`;
      const current = scripts.get(key) ?? {
        sourceFunctionName: script.sourceFunctionName,
        sourceUrlPath: script.sourceUrlPath,
        invokerType: script.invokerType,
        invoker: script.invoker,
        frameCount: 0,
        scriptDurationMs: 0,
        forcedStyleAndLayoutDurationMs: 0,
      };
      current.frameCount += 1;
      current.scriptDurationMs += script.durationMs;
      current.forcedStyleAndLayoutDurationMs += script.forcedStyleAndLayoutDurationMs;
      scripts.set(key, current);
    }
  }
  return {
    source: "PerformanceObserver long-animation-frame API; scripts identify browser-reported script entry points, not full JavaScript call stacks",
    supportedStreamSamples: streamSamples.filter((entry) => entry.longAnimationFrames.supported).length,
    unsupportedStreamSamples: streamSamples.filter((entry) => !entry.longAnimationFrames.supported).length,
    frameCount: frames.length,
    frames: frames.slice(0, 500),
    attributedScripts: [...scripts.values()].map((script) => ({
      ...script,
      scriptDurationMs: Number(script.scriptDurationMs.toFixed(3)),
      forcedStyleAndLayoutDurationMs: Number(script.forcedStyleAndLayoutDurationMs.toFixed(3)),
    })).sort((left, right) => right.scriptDurationMs - left.scriptDurationMs).slice(0, 80),
  };
}

function createCoverage(sourceNames, counts, samples, observations, fixtureEvidence, browserErrors, provenance, cpuProfiles) {
  const expectedSources = ["before", "after"];
  const core = [];
  for (const source of expectedSources) {
    for (const count of counts) {
      for (const panelState of ["unmounted", "mounted-hidden"]) {
        for (const scenario of ["input-feedback", "scroll-feedback", "active-markdown-stream", "active-markdown-final-flush", `hidden-changes-update-${panelState}`]) {
          const matches = observations.filter((entry) => entry.source === source && entry.requestedMessages === count && entry.panelState === panelState && entry.scenario === scenario && entry.ok).length;
          core.push({ source, requestedMessages: count, panelState, scenario, samples: matches, required: samples, status: matches >= samples ? "PASS" : "PARTIAL" });
        }
      }
    }
  }
  const deltaHandlerSubsamples = [];
  for (const source of expectedSources) {
    for (const count of counts) {
      for (const panelState of ["unmounted", "mounted-hidden"]) {
        const matches = observations.filter((entry) => entry.source === source && entry.requestedMessages === count && entry.panelState === panelState && entry.scenario === "active-markdown-delta-handler" && entry.ok).length;
        deltaHandlerSubsamples.push({ source, requestedMessages: count, panelState, samples: matches, required: samples * activeDeltaChunksPerStream, role: "within-stream handler subsamples; not independent stream samples", status: matches >= samples * activeDeltaChunksPerStream ? "PASS" : "PARTIAL" });
      }
    }
  }
  const everyFixture = sourceNames.length === expectedSources.length && expectedSources.every((source) => sourceNames.includes(source)) && fixtureEvidence.length === expectedSources.length * counts.length * 2 && fixtureEvidence.every((item) => item.historyRowsDelivered + 1 === item.requestedMessages);
  const noTurns = fixtureEvidence.every((item) => item.turnStartRpcCount === 0);
  const orderedNotifications = fixtureEvidence.length > 0 && fixtureEvidence.every((item) => item.notificationDispatchOrderValid);
  const activeStreamsOrdered = fixtureEvidence.length > 0 && fixtureEvidence.every((item) => item.activeMarkdownStream?.dispatchOrderValid === true && item.activeMarkdownStream?.burstCount === samples && item.activeMarkdownStream.bursts?.every((burst) => burst.dispatchOrderValid && burst.finalDeltaAndCompletionShareTask));
  const activeFinalFlushes = fixtureEvidence.length > 0 && fixtureEvidence.every((item) => item.activeMarkdownStream?.bursts?.length === samples && item.activeMarkdownStream.bursts.every((burst) => burst.finalFlushPendingAtCompletion === true && burst.finalAssistantRow?.finalMarkerPresent === true && burst.finalAssistantRow?.finalMarkerVisibleWithinMessageList === true && burst.finalAssistantRow?.finalMarkerVisibleAfterTwoFrames === true && burst.finalAssistantRow?.runtimeTerminalUi === true && burst.finalAssistantRow?.failureMarkerPresent === false && burst.finalAssistantRow?.unknownMarkerPresent === false));
  const memoryCaptured = fixtureEvidence.length > 0 && fixtureEvidence.every((item) => Number.isFinite(item.historyResponseBytes) && Number.isFinite(item.memoryBeforeMeasuredInteractions?.usedHeapSizeBytes) && Number.isFinite(item.memoryAfterActiveStream?.usedHeapSizeBytes));
  const expectedProfileCases = fixtureEvidence
    .filter((fixture) => fixture.activeMarkdownStackDiagnostic !== null)
    .map((fixture) => ({ source: fixture.source, requestedMessages: fixture.requestedMessages, panelState: fixture.panelState }));
  const cpuProfilesCaptured = expectedProfileCases.length > 0 && expectedProfileCases.every((expected) => cpuProfiles.some((profile) => profile.source === expected.source
    && profile.requestedMessages === expected.requestedMessages
    && profile.panelState === expected.panelState
    && profile.sampleCount > 0
    && profile.clockAlignment?.status === "ALIGNED_WITHIN_10MS"));
  const cpuProfileBoundaryStatus = expectedProfileCases.length === 0 ? "NOT_RUN_BY_DESIGN" : cpuProfilesCaptured ? "PASS" : "PARTIAL";
  const mainLongTaskCases = [...new Map(observations
    .filter((entry) => entry.scenario === "active-markdown-stream" && (entry.longTasks?.length ?? 0) > 0)
    .map((entry) => [`${entry.source}|${entry.requestedMessages}|${entry.panelState}`, {
      source: entry.source,
      requestedMessages: entry.requestedMessages,
      panelState: entry.panelState,
    }])).values()];
  const attributedLongTaskCases = mainLongTaskCases.filter((expected) => cpuProfiles.some((profile) => profile.source === expected.source
    && profile.requestedMessages === expected.requestedMessages
    && profile.panelState === expected.panelState
    && profile.longTaskStackAttribution?.some((task) => task.status === "PROFILE_SAMPLES_OVERLAP")));
  const longTaskStackAttributionComplete = attributedLongTaskCases.length === mainLongTaskCases.length;
  const mountedModalDismissed = fixtureEvidence.filter((item) => item.panelState === "mounted-hidden").length > 0
    && fixtureEvidence.filter((item) => item.panelState === "mounted-hidden").every((item) => item.tabModalDismiss?.dismissed === true);
  const allHistoryCounts = counts.length === 3 && [50, 500, 2000].every((count) => counts.includes(count));
  const status = samples >= 30 && allHistoryCounts && core.every((item) => item.status === "PASS") && everyFixture && noTurns && orderedNotifications && activeStreamsOrdered && activeFinalFlushes && mountedModalDismissed && memoryCaptured && cpuProfilesCaptured && longTaskStackAttributionComplete && browserErrors.length === 0 && provenance.length === 2 ? "PASS_WEB_ONLY" : "PARTIAL";
  return {
    overallStatus: status,
    note: "PASS_WEB_ONLY applies only to the listed isolated Chromium Mobile Web scenarios; Android/iOS native performance remains UNVERIFIED.",
    core,
    activeDeltaHandlerSubsamples: deltaHandlerSubsamples,
    boundaries: [
      { id: "50-500-2000-loaded-message-history", status: allHistoryCounts && everyFixture ? "PASS" : "PARTIAL", configuredCounts: counts, requiredCounts: [50, 500, 2000], fixtureCount: fixtureEvidence.length },
      { id: "hidden-changes-mounted-and-unmounted", status: fixtureEvidence.length > 0 && fixtureEvidence.every((item) => item.panelState === "unmounted" ? !item.changesPanelMounted : item.changesPanelMounted) ? "PASS" : "PARTIAL" },
      { id: "tab-modal-dismiss-before-mounted-input", status: mountedModalDismissed ? "PASS" : "PARTIAL", timingExcludedFromInputFeedback: true },
      { id: "no-model-or-active-user-session", status: noTurns ? "PASS" : "FAIL", turnStartRequests: 0, providerConfigured: false, syntheticNotificationsOnly: true },
      { id: "ordered-synthetic-runtime-notification-dispatch", status: orderedNotifications ? "PASS" : "PARTIAL", evidence: "test helper ledger confirms exact app-facing Mock dispatch order; Agent row mutation is checked separately", expectedOrder: ["turn/started", "item/started", "item/delta", "turn/completed"] },
      { id: "ordered-active-Markdown-delta-dispatch", status: activeStreamsOrdered ? "PASS" : "PARTIAL", evidence: "test helper ledger confirms dispatch order only; actual Agent row mutation and terminal composer UI are checked separately", independentBurstsPerFixture: samples, deltaFramesPerBurst: activeDeltaChunksPerStream, expectedOrder: ["turn/started", "item/started", "item/delta*", "turn/completed"] },
      { id: "active-Markdown-final-flush", status: activeFinalFlushes ? "PASS" : "PARTIAL", finalFlushSamples: fixtureEvidence.reduce((total, item) => total + (item.activeMarkdownStream?.bursts?.filter((burst) => burst.finalFlushPendingAtCompletion && burst.finalAssistantRow?.finalMarkerPresent && burst.finalAssistantRow?.finalMarkerVisibleWithinMessageList && burst.finalAssistantRow?.runtimeTerminalUi).length ?? 0), 0), requiredFlushes: fixtureEvidence.length * samples, finalDeltaAndCompletionShareBrowserTask: true, finalMarkerRequirement: "last-character DOM Range intersects message-list after stable tail viewport and two animation frames", checksComposerReturnedToNotRunningState: true },
      { id: "active-Markdown-handler-subsamples", status: deltaHandlerSubsamples.every((item) => item.status === "PASS") ? "PASS" : "PARTIAL", deltaFramesPerBurst: activeDeltaChunksPerStream, doesNotReplaceIndependentStreamSamples: true },
      { id: "active-assistant-message-growth", status: fixtureEvidence.length > 0 && fixtureEvidence.every((item) => item.activeAssistantTurnsCompleted === samples && item.expectedLogicalMessagesAfterActiveStreams === item.expectedLogicalMessagesBeforeActiveStreams + samples) ? "PASS" : "PARTIAL", assistantTurnsAddedPerFixture: samples, preservesIntermediateMessages: true },
      { id: "browser-heap-and-fixture-payload-bytes", status: memoryCaptured ? "PASS" : "PARTIAL", note: "CDP heap snapshots are approximate and were not forced through GC; fixture JSON response byte counts are recorded; durable transcript storage is not exercised" },
      { id: "active-Markdown-v8-cpu-profile", status: cpuProfileBoundaryStatus, profilerEnabledDuringCoreSamples: false, profiles: cpuProfiles.map((profile) => ({ source: profile.source, requestedMessages: profile.requestedMessages, panelState: profile.panelState, sampleCount: profile.sampleCount, totalSampledMs: profile.totalSampledMs, clockAlignment: profile.clockAlignment?.status, attributedLongTaskCount: profile.longTaskStackAttribution?.filter((task) => task.status === "PROFILE_SAMPLES_OVERLAP").length ?? 0 })), required: expectedProfileCases },
      { id: "cdp-v8-stack-attribution-for-longtask-cases", status: longTaskStackAttributionComplete ? "PASS" : "PARTIAL", coreLongTaskCases: mainLongTaskCases, attributedCases: attributedLongTaskCases, rule: "For each core active-stream case with a LongTask API entry, a separate same-source/count/panel CDP profile diagnostic must sample a LongTask interval; diagnostic samples are not included in core latency statistics" },
      { id: "before-after-source-and-complement-digests", status: provenance.length === 2 && provenance.every((item) => /^[a-f0-9]{64}$/.test(item.sourceTreeSha256) && /^[a-f0-9]{64}$/.test(item.sharedSourceInputSha256) && (item.sourceComplementSha256 === null || /^[a-f0-9]{64}$/.test(item.sourceComplementSha256)) && /^[a-f0-9]{64}$/.test(item.sourceFreezeEvidenceDigest)) && /^[a-f0-9]{64}$/.test(suiteSourceSha256) ? "PASS" : "PARTIAL", testSuiteSha256: suiteSourceSha256, measuredSources: provenance.map((item) => ({ source: item.source, sourceComplementSha256: item.sourceComplementSha256, sharedSourceInputSha256: item.sharedSourceInputSha256, sourceFreezeEvidenceDigest: item.sourceFreezeEvidenceDigest, sourceFreezeEvidenceKind: item.sourceFreezeEvidenceKind, frozenSourceEntryCount: item.frozenSourceEntryCount, sourceComplementMode: item.sourceComplementMode })) },
      { id: "30-samples-per-core-scenario", status: samples >= 30 && core.every((item) => item.status === "PASS") ? "PASS" : "PARTIAL", requestedSamples: samples, minimumRequired: 30 },
      { id: "android-ios-native-performance", status: "UNVERIFIED", reason: "system Chromium web emulation does not measure Hermes, native UI frames, operating-system keyboard, or native storage" },
    ],
  };
}

function percentile(values, quantile) {
  if (!values.length) return null;
  return values[Math.max(0, Math.ceil(values.length * quantile) - 1)];
}

async function sampleHostCpuWindow(phase) {
  const first = await readHostCpuSnapshot();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  const second = await readHostCpuSnapshot();
  const elapsedMs = Number((second.sampledAt - first.sampledAt).toFixed(1));
  const totalTicks = Math.max(0, second.systemCpu.totalTicks - first.systemCpu.totalTicks);
  const busyTicks = Math.max(0, second.systemCpu.busyTicks - first.systemCpu.busyTicks);
  const otherProcesses = [];
  for (const [pid, after] of second.processes) {
    const before = first.processes.get(pid);
    if (!before || pid === process.pid || before.startTimeTicks !== after.startTimeTicks) continue;
    const cpuTicks = Math.max(0, after.cpuTicks - before.cpuTicks);
    if (cpuTicks > 0) otherProcesses.push({ pid, name: after.name, cpuTicks, percentOfHostCpuCapacity: totalTicks > 0 ? Number((cpuTicks / totalTicks * 100).toFixed(2)) : null });
  }
  otherProcesses.sort((left, right) => right.cpuTicks - left.cpuTicks);
  return {
    phase,
    elapsedMs,
    systemCpuBusyPercent: totalTicks > 0 ? Number((busyTicks / totalTicks * 100).toFixed(2)) : null,
    loadAverage: second.loadAverage,
    nonSuiteProcessesWithCpu: otherProcesses.slice(0, 12),
    nonSuiteProcessCountWithCpu: otherProcesses.length,
    source: "/proc/stat and /proc/<pid>/stat; process command lines are not read; percentages are normalized to total host CPU capacity",
  };
}

async function readHostCpuSnapshot() {
  const sampledAt = performance.now();
  const [cpuStat, loadText, entries] = await Promise.all([
    readFile("/proc/stat", "utf8"),
    readFile("/proc/loadavg", "utf8").catch(() => ""),
    readdir("/proc").catch(() => []),
  ]);
  const cpuLine = cpuStat.split(/\r?\n/).find((line) => /^cpu\s/.test(line)) ?? "";
  const cpuValues = cpuLine.trim().split(/\s+/).slice(1, 9).map(Number);
  const totalTicks = cpuValues.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const idleTicks = (cpuValues[3] ?? 0) + (cpuValues[4] ?? 0);
  const processes = new Map();
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    const raw = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => null);
    if (!raw) return;
    const open = raw.indexOf("(");
    const close = raw.lastIndexOf(")");
    if (open < 0 || close <= open) return;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const userTicks = Number(fields[11]);
    const systemTicks = Number(fields[12]);
    const startTimeTicks = Number(fields[19]);
    if (![userTicks, systemTicks, startTimeTicks].every(Number.isFinite)) return;
    processes.set(Number(entry), {
      name: raw.slice(open + 1, close).slice(0, 80),
      cpuTicks: userTicks + systemTicks,
      startTimeTicks,
    });
  }));
  return {
    sampledAt,
    systemCpu: { totalTicks, busyTicks: Math.max(0, totalTicks - idleTicks) },
    loadAverage: loadText.trim().split(/\s+/).slice(0, 3).map(Number).filter(Number.isFinite),
    processes,
  };
}

return { installHistoryAndNotificationFixture, readFocusState, connectMobile, loadHistoryToCount, latestLoadedHistoryTail, readTranscriptViewport, captureBrowserMemory, captureTranscriptEvidence, makeHistoryPage, makeHistoryMessage, createPageState, areNotificationBatchesOrdered, summarizeObservations, summarizeLongTasks, summarizeLongAnimationFrames, createCoverage, percentile, sampleHostCpuWindow, readHostCpuSnapshot };
}
