const TRANSCRIPT_ROW_TEST_IDS = new Set(["message-user", "message-assistant"]);

export async function readTranscriptViewport(page, { markerText = null, rowDomId = null, rowTestId = null } = {}) {
  assertTranscriptRowTestId(rowTestId);
  return page.evaluate(inspectTranscriptViewportInPage, {
    markerText,
    rowDomId,
    rowTestId,
    observeTrustedWheel: false,
  });
}

export async function armTrustedTranscriptWheelObservation(page, options = {}) {
  const snapshot = await armTrustedTranscriptWheelObservationWithViewport(page, options);
  return snapshot?.wheelStart ?? null;
}

/** Arm the audit and capture its starting geometry in the same page evaluation. */
export async function armTrustedTranscriptWheelObservationWithViewport(page, { markerText = null, rowDomId = null, rowTestId = null } = {}) {
  assertTranscriptRowTestId(rowTestId);
  return page.evaluate(inspectTranscriptViewportInPage, {
    markerText,
    rowDomId,
    rowTestId,
    observeTrustedWheel: true,
  });
}

export async function readTrustedTranscriptWheelTargetAtPoint(page, point) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    throw new TypeError("trusted wheel target inspection requires the measured marker/list intersection point");
  }
  return page.evaluate(({ x, y }) => {
    const list = document.querySelector('[data-testid="message-list"]');
    const target = document.elementFromPoint(x, y);
    const targetInsideList = Boolean(list && target && list.contains(target));
    const targetPath = [];
    if (targetInsideList) {
      let current = target;
      while (current && current instanceof HTMLElement && targetPath.length < 16) {
        const scrollHeight = Number.isFinite(current.scrollHeight) ? current.scrollHeight : 0;
        const clientHeight = Number.isFinite(current.clientHeight) ? current.clientHeight : 0;
        const testId = current.getAttribute("data-testid");
        targetPath.push({
          tagName: String(current.tagName ?? "").slice(0, 16),
          testId: testId === "message-list" || testId === "message-user" || testId === "message-assistant"
            ? testId : null,
          isHost: current === list,
          scrollTop: Number.isFinite(current.scrollTop) ? current.scrollTop : 0,
          scrollHeight,
          clientHeight,
          rnwScrollable: scrollHeight > clientHeight,
        });
        if (current === list) break;
        current = current.parentElement;
      }
    }
    return {
      targetInsideList,
      targetIsHost: target === list,
      targetPath,
      pathReachesHost: targetPath.at(-1)?.isHost === true,
    };
  }, point);
}

export async function readTrustedTranscriptWheelObservation(page) {
  return page.evaluate(() => ({
    events: window.__sessionCacheWheelAudit?.events?.slice(-8) ?? [],
    scrollSamples: window.__sessionCacheWheelAudit?.scrollSamples?.slice(-16) ?? [],
  }));
}

function assertTranscriptRowTestId(rowTestId) {
  if (rowTestId !== null && !TRANSCRIPT_ROW_TEST_IDS.has(rowTestId)) {
    throw new TypeError("transcript row scope must be message-user or message-assistant");
  }
}

function inspectTranscriptViewportInPage({ markerText, rowDomId, rowTestId, observeTrustedWheel }) {
  const round = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const summarizeRect = rect => rect ? {
    top: round(rect.top), bottom: round(rect.bottom), left: round(rect.left), right: round(rect.right),
    width: round(rect.width), height: round(rect.height),
  } : null;
  const intersects = (rect, bounds) => Boolean(rect && bounds && rect.width > 0 && rect.height > 0 &&
    rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right);
  const list = document.querySelector('[data-testid="message-list"]');
  if (!(list instanceof HTMLElement)) {
    return {
      listFound: false,
      rowMatchCount: 0,
      markerTextMatchCount: 0,
      markerIntersectsWindow: false,
      markerIntersectsList: false,
      wheelStart: null,
    };
  }

  const listRect = list.getBoundingClientRect();
  const listBounds = { top: listRect.top, bottom: listRect.bottom, left: listRect.left, right: listRect.right };
  const windowBounds = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  const roleSelector = rowTestId === "message-user"
    ? '[data-testid="message-user"]'
    : rowTestId === "message-assistant"
      ? '[data-testid="message-assistant"]'
      : '[data-testid="message-user"], [data-testid="message-assistant"]';
  const candidates = [...list.querySelectorAll(roleSelector)];
  const rowForRoleElement = element => {
    let current = element;
    while (current && current !== list) {
      if (typeof current.id === "string" && current.id.startsWith("message-")) return current;
      current = current.parentElement;
    }
    return element;
  };
  const rows = [...new Set(candidates.map(rowForRoleElement))];
  let candidateRows = rows;
  if (rowDomId !== null) {
    const exact = document.getElementById(rowDomId);
    const roleMatchCount = rowTestId === null || !exact ? null :
      (exact.getAttribute("data-testid") === rowTestId ? 1 : 0) +
      exact.querySelectorAll(roleSelector).length;
    candidateRows = exact && exact !== list && list.contains(exact) &&
      (roleMatchCount === null || roleMatchCount === 1) ? [exact] : [];
  }
  let matchedRows;
  let markerTextMatchCount = 0;
  let markerRange = null;
  if (typeof markerText === 'string' && markerText.length > 0) {
    const matches = [];
    for (const row of candidateRows) {
      const segments = [];
      let fullText = '';
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.nodeValue ?? '';
        segments.push({ node, start: fullText.length, end: fullText.length + text.length });
        fullText += text;
        node = walker.nextNode();
      }
      const occurrences = [];
      for (let offset = fullText.indexOf(markerText); offset >= 0; offset = fullText.indexOf(markerText, offset + 1)) occurrences.push(offset);
      if (occurrences.length > 0) {
        markerTextMatchCount += occurrences.length;
        matches.push(row);
        if (!markerRange) {
          const startOffset = occurrences[0];
          const endOffset = startOffset + markerText.length;
          const locate = offset => segments.find(segment => offset >= segment.start && offset < segment.end);
          const start = locate(startOffset);
          const end = locate(endOffset - 1);
          if (start && end) {
            const range = document.createRange();
            range.setStart(start.node, startOffset - start.start);
            range.setEnd(end.node, endOffset - end.start);
            markerRange = range;
          }
        }
      }
    }
    matchedRows = matches;
  } else {
    matchedRows = candidateRows;
  }

  const row = matchedRows[0] ?? null;
  const rowRect = row?.getBoundingClientRect() ?? null;
  const markerRect = markerRange?.getBoundingClientRect() ?? null;
  const markerStyle = markerRange?.startContainer?.parentElement
    ? getComputedStyle(markerRange.startContainer.parentElement)
    : null;
  const markerVisible = Boolean(markerRect && markerRect.width > 0 && markerRect.height > 0 &&
    markerStyle?.display !== 'none' && markerStyle?.visibility !== 'hidden' && Number(markerStyle?.opacity ?? 1) > 0);
  const markerSummary = markerRect ? {
    ...summarizeRect(markerRect),
    centerX: round((markerRect.left + markerRect.right) / 2),
    centerY: round((markerRect.top + markerRect.bottom) / 2),
    rangeClientRectCount: markerRange.getClientRects().length,
  } : null;

  const isScrollable = element => {
    if (!(element instanceof HTMLElement) || element.scrollHeight <= element.clientHeight + 16) return false;
    const overflowY = getComputedStyle(element).overflowY;
    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
  };
  const resolveScrollHost = targetRow => {
    let current = targetRow;
    while (current && list.contains(current)) {
      if (isScrollable(current)) return current;
      if (current === list) break;
      current = current.parentElement;
    }
    return list;
  };
  const host = resolveScrollHost(row);
  const hostRect = host.getBoundingClientRect();
  let wheelStart = null;
  if (observeTrustedWheel) {
    window.__sessionCacheWheelAudit?.cleanup?.();
    const audit = { events: [], scrollSamples: [] };
    const appendBounded = (items, value, limit) => {
      items.push(value);
      if (items.length > limit) items.shift();
    };
    const targetPath = target => {
      const path = [];
      let current = target;
      while (current && current instanceof HTMLElement && path.length < 16) {
        const scrollHeight = Number.isFinite(current.scrollHeight) ? current.scrollHeight : 0;
        const clientHeight = Number.isFinite(current.clientHeight) ? current.clientHeight : 0;
        const testId = current.getAttribute("data-testid");
        path.push({
          tagName: String(current.tagName ?? "").slice(0, 16),
          testId: testId === "message-list" || testId === "message-user" || testId === "message-assistant"
            ? testId : null,
          isHost: current === host,
          scrollTop: Number.isFinite(current.scrollTop) ? round(current.scrollTop) : 0,
          scrollHeight,
          clientHeight,
          rnwScrollable: scrollHeight > clientHeight,
        });
        if (current === list) break;
        current = current.parentElement;
      }
      return path;
    };
    const readHostScrollTop = () => round(host.scrollTop);
    const onScroll = event => appendBounded(audit.scrollSamples, {
      source: "scroll-event",
      targetIsHost: event.target === host,
      hostScrollTop: readHostScrollTop(),
    }, 16);
    const onWheel = event => {
      const record = {
        isTrusted: event.isTrusted,
        cancelable: event.cancelable,
        targetInsideList: event.target === list || list.contains(event.target),
        targetPath: targetPath(event.target),
        deltaY: Number.isFinite(event.deltaY) ? round(event.deltaY) : null,
        defaultPreventedAtCapture: event.defaultPrevented === true,
        defaultPreventedAfterDispatch: null,
        hostScrollTopAtCapture: readHostScrollTop(),
        hostScrollTopAfterDispatch: null,
        hostScrollTopAfterFrame: null,
      };
      appendBounded(audit.events, record, 8);
      setTimeout(() => {
        record.defaultPreventedAfterDispatch = event.defaultPrevented === true;
        record.hostScrollTopAfterDispatch = readHostScrollTop();
        requestAnimationFrame(() => {
          record.hostScrollTopAfterFrame = readHostScrollTop();
          appendBounded(audit.scrollSamples, {
            source: "wheel-frame",
            targetIsHost: true,
            hostScrollTop: record.hostScrollTopAfterFrame,
          }, 16);
        });
      }, 0);
    };
    list.addEventListener("wheel", onWheel, { capture: true, passive: true });
    document.addEventListener("scroll", onScroll, true);
    window.__sessionCacheWheelAudit = audit;
    audit.cleanup = () => {
      list.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("scroll", onScroll, true);
    };
    wheelStart = { scrollTop: host.scrollTop, scrollHeight: host.scrollHeight, clientHeight: host.clientHeight };
  }

  return {
    listFound: true,
    viewport: { width: round(window.innerWidth), height: round(window.innerHeight) },
    list: summarizeRect(listRect),
    host: {
      testId: host.getAttribute('data-testid'),
      rect: summarizeRect(hostRect),
      scrollTop: round(host.scrollTop),
      scrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
    },
    rowMatchCount: matchedRows.length,
    markerTextMatchCount,
    rowDomId: row?.id || null,
    row: rowRect ? {
      ...summarizeRect(rowRect),
      offsetFromList: round(rowRect.top - listRect.top),
      offsetFromHost: round(rowRect.top - hostRect.top),
    } : null,
    rowIntersectsWindow: intersects(rowRect, windowBounds),
    rowIntersectsList: intersects(rowRect, listBounds),
    marker: markerSummary,
    markerVisible,
    markerIntersectsWindow: markerVisible && intersects(markerRect, windowBounds),
    markerIntersectsList: markerVisible && intersects(markerRect, listBounds),
    wheelStart,
  };
}
