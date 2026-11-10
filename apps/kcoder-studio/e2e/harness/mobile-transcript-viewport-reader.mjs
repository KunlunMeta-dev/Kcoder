/** Bounded DOM geometry reader shared by the formal suite and retained candidate. */
export function createMobileTranscriptViewportReader(transcriptVirtualizationTraceLimits) {
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
  return readTranscriptViewport;
}
