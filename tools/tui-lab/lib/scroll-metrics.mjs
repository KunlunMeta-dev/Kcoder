import path from 'node:path';

import { interactionBudgetsForPlatform } from './platform-adapter.mjs';
import { captureStep } from './browser-evidence.mjs';

export async function pressRepeated(page, key, count, delayMs = 50) {
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press(key);
    await page.waitForTimeout(delayMs);
  }
}

export async function pressBurst(page, key, count) {
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press(key);
  }
}

export async function placeMouseOverTerminal(page) {
  const terminal = page.locator('#terminal');
  await terminal.click();
  const box = await terminal.boundingBox();
  if (!box) {
    throw new Error('terminal bounding box unavailable');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

export async function terminalCellGeometry(page) {
  const screen = page.locator('#terminal .xterm-screen');
  const viewport = page.locator('#terminal .xterm-viewport');
  const [screenBox, viewportBox] = await Promise.all([
    screen.boundingBox(),
    viewport.boundingBox(),
  ]);
  if (!screenBox || !viewportBox) {
    throw new Error('xterm screen bounding box unavailable');
  }
  const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
  const cols = Math.max(1, dimensions.cols || 1);
  const rows = Math.max(1, dimensions.rows || 1);
  // The screen can be taller than its visible viewport when xterm retains
  // host scrollback. Browser mouse events are mapped against the visible
  // viewport, so using the screen's scroll height shifts Windows coordinates
  // downward after resize.
  const box = {
    x: screenBox.x,
    y: viewportBox.y,
    width: screenBox.width,
    height: viewportBox.height,
  };
  return {
    box,
    dimensions,
    cellWidth: box.width / cols,
    cellHeight: viewportBox.height / rows,
  };
}

export async function internalScrollbarSample(page) {
  const sample = await page.evaluate(() => window.tuiLab.internalScrollbar());
  const runs = [];
  for (const row of sample.thumbRows) {
    const last = runs.at(-1);
    if (last && last.start + last.length === row) {
      last.length += 1;
    } else {
      runs.push({ start: row, length: 1 });
    }
  }
  return {
    ...sample,
    firstTrackRow: sample.trackRows.at(0) ?? null,
    lastTrackRow: sample.trackRows.at(-1) ?? null,
    firstThumbRow: sample.thumbRows.at(0) ?? null,
    lastThumbRow: sample.thumbRows.at(-1) ?? null,
    thumbRuns: runs,
  };
}

export function scrollbarPixelGeometry(geometry, sample) {
  if (sample.firstTrackRow == null || sample.lastTrackRow == null) {
    throw new Error('committed scrollbar track was not visible in xterm cells');
  }
  const { box, cellWidth, cellHeight } = geometry;
  const rowToY = (row) => box.y + (row + 0.5) * cellHeight;
  return {
    x: box.x + (sample.col + 0.5) * cellWidth,
    yTop: rowToY(sample.firstTrackRow),
    yBottom: rowToY(sample.lastTrackRow),
    yThumbMiddle: rowToY(
      sample.firstThumbRow == null || sample.lastThumbRow == null
        ? sample.lastTrackRow
        : (sample.firstThumbRow + sample.lastThumbRow) / 2,
    ),
  };
}

export function firstVisibleHistoryMarker(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    let match = line.match(/tui-lab-tool-line-(\d{3,})/);
    if (match) {
      return { kind: 'tool', line: Number(match[1]), score: Number(match[1]) };
    }
    match = line.match(/tui-lab-final-line-(\d{3,})/);
    if (match) {
      return { kind: 'final', line: Number(match[1]), score: 500 + Number(match[1]) };
    }
  }
  if (text.includes('tui-lab-tool-start')) {
    return { kind: 'tool-start', line: 0, score: 0 };
  }
  if (textHasMixedToolsSummary(text)) {
    return { kind: 'mixed-tools-summary', line: 0, score: 0 };
  }
  if (text.includes('tui-lab-final-sentinel')) {
    return { kind: 'final-sentinel', line: 121, score: 700 };
  }
  return null;
}

export function textHasMixedToolsSummary(text) {
  return text.includes('read x1 · grep x1 · TodoWrite x1 · bash x1');
}

export function textContainsAcrossWrap(text, needle) {
  // The committed scrollbar is terminal chrome, not part of wrapped content.
  // Only remove a trailing track/thumb cell; preserve interior content glyphs.
  const content = String(text || '').replace(/[│┃][ \t]*$/gm, '');
  const normalize = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const compact = (value) => normalize(value).replace(/\s+/g, '');
  return [text, content].some((candidate) =>
    normalize(candidate).includes(normalize(needle)) || compact(candidate).includes(compact(needle)),
  );
}

export function textHasEarlyToolHistory(text) {
  return (
    text.includes('tui-lab-tool-start') ||
    text.includes('tui-lab-tool-line-001') ||
    textHasMixedToolsSummary(text)
  );
}

export function textShowsEarlierHistory(text) {
  return textHasEarlyToolHistory(text) && !text.includes('tui-lab-final-line-120');
}

export async function waitForTextMatch(page, predicate, timeout = 1000) {
  const started = performance.now();
  await page.waitForFunction(predicate, null, { timeout });
  const textReadStart = performance.now();
  const text = await page.evaluate(() => window.tuiLab.text());
  return {
    waitMs: Math.round(textReadStart - started),
    readTextMs: Math.round(performance.now() - textReadStart),
    text,
  };
}

export function transcriptInteractionTimeoutMs() {
  const configured = Number.parseInt(process.env.KCODER_TUI_LAB_INTERACTION_TIMEOUT_MS || '', 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return process.platform === 'win32' ? 5000 : 1200;
}

async function fetchViewportDiagnostics(page, afterSequence = 0) {
  const url = new URL('/viewport-diagnostics', page.url());
  url.searchParams.set('after', String(afterSequence));
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`viewport diagnostics request failed: ${response.status}`);
  return response.json();
}

async function waitForViewportCommitBoundary(page, boundary, afterSequence, timeoutMs) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  let cursor = afterSequence;
  let latest = null;
  while (performance.now() < deadline) {
    const diagnostic = await fetchViewportDiagnostics(page, cursor);
    cursor = Math.max(cursor, diagnostic.latestSequence || 0);
    for (const event of diagnostic.events || []) {
      if (event.phase === 'commit') latest = event;
      if (event.phase === 'commit' && event.boundary === boundary) {
        return { event, waitMs: Math.round(performance.now() - started), latestSequence: cursor };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `viewport did not commit boundary ${boundary} after sequence ${afterSequence}; latest=${JSON.stringify(latest)}`,
  );
}

export async function measureTranscriptScrollbarDrag(page) {
  const geometry = await terminalCellGeometry(page);
  const { cellWidth, cellHeight, dimensions } = geometry;
  const scrollbar = await internalScrollbarSample(page);
  const { x, yTop, yBottom } = scrollbarPixelGeometry(geometry, scrollbar);
  const startText = await page.evaluate(() => window.tuiLab.text());
  const startMarker = firstVisibleHistoryMarker(startText);
  const startDiagnostic = await fetchViewportDiagnostics(page);

  const jumpTopStart = performance.now();
  await page.mouse.move(x, yTop);
  await page.mouse.down();
  await page.mouse.up();
  const jumpInjectionMs = performance.now() - jumpTopStart;
  const topCommit = await waitForViewportCommitBoundary(
    page,
    'top',
    startDiagnostic.latestSequence || 0,
    transcriptInteractionTimeoutMs(),
  );
  const topTextReadStart = performance.now();
  const topText = await page.evaluate(() => window.tuiLab.text());
  const topTextReadMs = performance.now() - topTextReadStart;
  const topMarker = firstVisibleHistoryMarker(topText);

  const dragStart = performance.now();
  await page.mouse.move(x, yTop);
  await page.mouse.down();
  const downStart = performance.now();
  await page.mouse.move(x, yBottom);
  await page.mouse.up();
  const dragInjectionMs = performance.now() - downStart;
  const bottomCommit = await waitForViewportCommitBoundary(
    page,
    'bottom',
    topCommit.latestSequence,
    transcriptInteractionTimeoutMs(),
  );
  const bottomTextReadStart = performance.now();
  const bottomText = await page.evaluate(() => window.tuiLab.text());
  const bottomTextReadMs = performance.now() - bottomTextReadStart;
  const bottomMarker = firstVisibleHistoryMarker(bottomText);
  const setupMs = downStart - dragStart;
  const responseMs = bottomCommit.waitMs;
  const gestureMs = dragInjectionMs + bottomCommit.waitMs;
  const maxTop = Math.max(0, Number(bottomCommit.event.content_rows) - Number(bottomCommit.event.viewport_rows));
  const top = Number(topCommit.event.top);
  const bottom = Number(bottomCommit.event.top);
  const coverageRows = Math.max(0, bottom - top);
  const coverageRatio = maxTop > 0 ? coverageRows / maxTop : 1;

  return {
    rows: dimensions.rows,
    cols: dimensions.cols,
    cellWidth: Number(cellWidth.toFixed(2)),
    cellHeight: Number(cellHeight.toFixed(2)),
    startMarker,
    topMarker,
    bottomMarker,
    reachedTop: topCommit.event.boundary === 'top' && top === 0,
    returnedToTail: Boolean(
      bottomCommit.event.boundary === 'bottom' && bottom === maxTop,
    ),
    top,
    bottom,
    maxTop,
    coverageRows,
    coverageRatio: Number(coverageRatio.toFixed(4)),
    coverageWithinOneDisplayRow: coverageRows >= Math.max(0, maxTop - 1),
    topCommitSequence: topCommit.event.sequence,
    bottomCommitSequence: bottomCommit.event.sequence,
    jumpTopMs: Math.round(jumpInjectionMs + topCommit.waitMs),
    jumpTopInjectionMs: Math.round(jumpInjectionMs),
    jumpTopPaintWaitMs: topCommit.waitMs,
    jumpTopTextReadMs: Math.round(topTextReadMs),
    dragDownMs: Math.round(responseMs),
    dragResponseMs: Math.round(responseMs),
    dragGestureMs: Math.round(gestureMs),
    dragSetupMs: Math.round(setupMs),
    dragInjectionMs: Math.round(dragInjectionMs),
    dragPaintWaitMs: bottomCommit.waitMs,
    dragTextReadMs: Math.round(bottomTextReadMs),
    historySpanScore:
      topMarker && bottomMarker ? Math.max(0, bottomMarker.score - topMarker.score) : null,
  };
}

export function terminalRightEdgeScrollbarStats(text) {
  let trackRows = 0;
  let thumbRows = 0;
  let currentThumbRun = 0;
  let currentThumbRunStart = 0;
  const thumbRuns = [];
  const thumbRunSpans = [];
  let firstTrackRow = null;
  let lastTrackRow = null;
  let firstThumbRow = null;
  let lastThumbRow = null;
  const thumbGlyphs = new Set(['█', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '▔', '▀', '┃', '|']);
  const lines = text.split('\n');
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    const trimmed = line.trimEnd();
    const edge = trimmed.at(-1);
    const isThumb = thumbGlyphs.has(edge);
    const isTrack = isThumb || edge === '░' || edge === '│' || edge === ':';
    if (isTrack) {
      trackRows += 1;
      firstTrackRow ??= row;
      lastTrackRow = row;
    }
    if (isThumb) {
      thumbRows += 1;
      firstThumbRow ??= row;
      lastThumbRow = row;
      if (currentThumbRun === 0) {
        currentThumbRunStart = row;
      }
      currentThumbRun += 1;
    } else if (currentThumbRun > 0) {
      thumbRuns.push(currentThumbRun);
      thumbRunSpans.push({ start: currentThumbRunStart, length: currentThumbRun });
      currentThumbRun = 0;
    }
  }
  if (currentThumbRun > 0) {
    thumbRuns.push(currentThumbRun);
    thumbRunSpans.push({ start: currentThumbRunStart, length: currentThumbRun });
  }
  return {
    trackRows,
    thumbRows,
    thumbRuns,
    thumbRunSpans,
    firstTrackRow,
    lastTrackRow,
    firstThumbRow,
    lastThumbRow,
    largestThumbRun: thumbRuns.length ? Math.max(...thumbRuns) : 0,
  };
}

export function textSignature(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('\n');
}

export function firstVisibleLine(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

export function uniqueValues(values) {
  return [...new Set(values.map((value) => JSON.stringify(value)))].map((value) => JSON.parse(value));
}

export function numericRange(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) {
    return 0;
  }
  return Math.max(...nums) - Math.min(...nums);
}

export function scrollbarPixelGeometryFromStats(geometry, stats) {
  if (stats.firstTrackRow == null || stats.lastTrackRow == null) {
    throw new Error('committed scrollbar track was not visible in terminal text');
  }
  const { box, cellWidth, cellHeight, dimensions } = geometry;
  const trackCol = stats.col ?? dimensions.cols - 2;
  const rowToY = (row) => box.y + (row + 0.5) * cellHeight;
  return {
    x: box.x + (trackCol + 0.5) * cellWidth,
    contentX: box.x + box.width * 0.45,
    edgeContentX: box.x + box.width - Math.max(1, cellWidth * 1.5),
    trackX: box.x + (trackCol + 0.5) * cellWidth,
    yTop: rowToY(stats.firstTrackRow),
    yBottom: rowToY(stats.lastTrackRow),
    yThumbMiddle:
      stats.firstThumbRow == null || stats.lastThumbRow == null
        ? rowToY(stats.lastTrackRow)
        : rowToY((stats.firstThumbRow + stats.lastThumbRow) / 2),
  };
}

export async function scrollbarTextSample(page, sample, phase) {
  const text = await page.evaluate(() => window.tuiLab.text());
  const internal = await internalScrollbarSample(page);
  const stats = {
    col: internal.col,
    trackRows: internal.trackRows.length,
    thumbRows: internal.thumbRows.length,
    thumbRuns: internal.thumbRuns.map((run) => run.length),
    thumbRunSpans: internal.thumbRuns,
    firstTrackRow: internal.firstTrackRow,
    lastTrackRow: internal.lastTrackRow,
    firstThumbRow: internal.firstThumbRow,
    lastThumbRow: internal.lastThumbRow,
    largestThumbRun: internal.thumbRuns.length
      ? Math.max(...internal.thumbRuns.map((run) => run.length))
      : 0,
  };
  return {
    sample,
    phase,
    marker: firstVisibleHistoryMarker(text),
    signature: textSignature(text),
    firstLine: firstVisibleLine(text),
    textLength: text.length,
    ...stats,
  };
}

export async function measureWheelFromTailSamples(page, trace, artifacts, label, sampleCount = 10) {
  await page.keyboard.press('End');
  await page.waitForTimeout(120);
  await placeMouseOverTerminal(page);
  const before = await scrollbarTextSample(page, 0, 'before-wheel');
  const screenshots = {
    before: path.join(artifacts.dir, `${label}-before.png`),
    first: path.join(artifacts.dir, `${label}-first.png`),
    after: path.join(artifacts.dir, `${label}-after.png`),
  };
  await captureOptionalStep(page, trace, `${label}-before`, screenshots.before);

  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    await page.mouse.wheel(0, -120);
    if (index === 0) {
      // ConPTY can acknowledge the wheel event and repaint the scrollbar a
      // frame before xterm.js exposes the updated transcript text. Wait for
      // the same text signature used by the assertion so a slow first frame
      // is not mistaken for a swallowed first wheel tick. A genuinely
      // swallowed tick still times out and fails below because no additional
      // input is sent while waiting.
      await page
        .waitForFunction(
          (previousSignature) =>
            (window.tuiLab?.text() || '')
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .slice(0, 8)
              .join('\n') !== previousSignature,
          before.signature,
          { timeout: transcriptInteractionTimeoutMs() },
        )
        .catch(() => {});
      await page.waitForTimeout(40);
    } else {
      await page.waitForTimeout(140);
    }
    const sample = await scrollbarTextSample(page, index + 1, 'wheel-up');
    sample.elapsedMs = Math.round(performance.now() - startedAt);
    sample.changedFromPrevious =
      sample.signature !== (samples.at(-1)?.signature ?? before.signature);
    samples.push(sample);
    if (index === 0) {
      await captureOptionalStep(page, trace, `${label}-first`, screenshots.first);
    }
  }
  await captureOptionalStep(page, trace, `${label}-after`, screenshots.after);

  return {
    before,
    samples,
    screenshots,
    firstEventChanged: samples[0]?.changedFromPrevious === true,
    changedEvents: samples.filter((sample) => sample.changedFromPrevious).length,
    firstChangedEvent:
      samples.find((sample) => sample.changedFromPrevious)?.sample ?? null,
  };
}

export async function measureNormalWheelToBounds(page, trace, artifacts, label, maxEvents = 220) {
  await page.keyboard.press('End');
  await page.waitForTimeout(150);
  await placeMouseOverTerminal(page);
  const screenshots = {
    top: path.join(artifacts.dir, `${label}-top.png`),
    bottom: path.join(artifacts.dir, `${label}-bottom.png`),
  };
  const runDirection = async (deltaY, reached) => {
    const startedAt = performance.now();
    let events = 0;
    let text = await page.evaluate(() => window.tuiLab.text());
    while (events < maxEvents && !reached(text)) {
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(70);
      text = await page.evaluate(() => window.tuiLab.text());
      events += 1;
    }
    return { events, reached: reached(text), elapsedMs: Math.round(performance.now() - startedAt) };
  };
  const up = await runDirection(-120, textShowsEarlierHistory);
  await captureOptionalStep(page, trace, `${label}-top`, screenshots.top);
  const down = await runDirection(
    120,
    (text) => text.includes('tui-lab-final-line-120') && text.includes('tui-lab-final-sentinel'),
  );
  await captureOptionalStep(page, trace, `${label}-bottom`, screenshots.bottom);
  return { up, down, screenshots };
}

export async function measureScrollbarThumbStabilityDuringDrag(page, sampleCount = 12) {
  const geometry = await terminalCellGeometry(page);
  const { dimensions } = geometry;
  const scrollbar = await internalScrollbarSample(page);
  const { x, yTop, yBottom } = scrollbarPixelGeometry(geometry, scrollbar);
  const samples = [];

  await page.mouse.move(x, yTop);
  await page.mouse.down();
  await page.mouse.up();
  await waitForTextMatch(
    page,
    () => {
      if (!window.tuiLab) {
        return false;
      }
      const text = window.tuiLab.text();
      return (
        text.includes('tui-lab-tool-start') ||
        text.includes('tui-lab-tool-line-001') ||
        /tui-lab-(?:tool|final)-line-\d{3,}/.test(text) ||
        text.includes('read x1 · grep x1 · TodoWrite x1 · bash x1')
      );
    },
    transcriptInteractionTimeoutMs(),
  );

  await page.mouse.move(x, yTop);
  await page.mouse.down();
  for (let index = 0; index < sampleCount; index += 1) {
    const ratio = sampleCount <= 1 ? 1 : index / (sampleCount - 1);
    const y = yTop + (yBottom - yTop) * ratio;
    await page.mouse.move(x, y, { steps: 2 });
    await page.waitForTimeout(16);
    const internal = await internalScrollbarSample(page);
    samples.push({
      sample: index + 1,
      trackRows: internal.trackRows.length,
      thumbRows: internal.thumbRows.length,
      thumbRuns: internal.thumbRuns.map((run) => run.length),
      thumbRunSpans: internal.thumbRuns,
      firstTrackRow: internal.firstTrackRow,
      lastTrackRow: internal.lastTrackRow,
      firstThumbRow: internal.firstThumbRow,
      lastThumbRow: internal.lastThumbRow,
    });
  }
  await page.mouse.up();

  const visibleSamples = samples.filter((sample) => sample.trackRows > 0);
  const thumbHeights = visibleSamples.map((sample) => sample.thumbRows);
  const uniqueThumbHeights = [...new Set(thumbHeights)];
  const minThumbRows = thumbHeights.length ? Math.min(...thumbHeights) : 0;
  const maxThumbRows = thumbHeights.length ? Math.max(...thumbHeights) : 0;
  const thumbHeightDeltaRows = maxThumbRows - minThumbRows;
  const contiguousThumb = visibleSamples.every((sample) => sample.thumbRuns.length <= 1);
  const thumbHeightCounts = new Map();
  for (const height of thumbHeights) {
    thumbHeightCounts.set(height, (thumbHeightCounts.get(height) || 0) + 1);
  }
  const dominantThumbHeightCount = Math.max(0, ...thumbHeightCounts.values());
  const dominantThumbHeightRatio = thumbHeights.length
    ? dominantThumbHeightCount / thumbHeights.length
    : 0;
  return {
    rows: dimensions.rows,
    cols: dimensions.cols,
    sampleCount,
    samplesWithScrollbar: visibleSamples.length,
    uniqueThumbHeights,
    minThumbRows,
    maxThumbRows,
    thumbHeightDeltaRows,
    dominantThumbHeightCount,
    dominantThumbHeightRatio,
    contiguousThumb,
    stableThumbHeight: Boolean(
      thumbHeights.length && contiguousThumb && dominantThumbHeightRatio >= 0.75,
    ),
    samples,
  };
}

export async function measureStreamingScrollbarDragDuringOutput(
  page,
  trace,
  artifacts,
  streamDelayMs = 0,
  dragDurationMs = 6000,
  sampleCount = 60,
) {
  const streamReady = await waitForTextMatch(
    page,
    () => {
      if (!window.tuiLab) {
        return false;
      }
      const text = window.tuiLab.text();
      return [...text.matchAll(/tui-lab-final-line-(\d+)/g)].some(match => Number(match[1]) >= 20) && !text.includes('tui-lab-final-sentinel');
    },
    15_000,
  );
  await captureStep(
    page,
    trace,
    'streaming-scrollbar-before-drag',
    artifacts.streamingScrollbarBeforeDragScreenshot,
  );

  let geometry = await terminalCellGeometry(page);
  const dimensions = geometry.dimensions;
  let internalStats = await internalScrollbarSample(page);
  let pixel = scrollbarPixelGeometry(geometry, internalStats);
  const beforeText = streamReady.text;
  const beforeMarker = firstVisibleHistoryMarker(beforeText);
  const beforeStats = internalStats;

  // Show the complete bottom-to-top gesture in recordings. A track click reaches the same
  // logical state, but it happens in only a few frames and is poor visual evidence that dragging
  // remains responsive across the full range.
  const topDragDurationMs = Math.min(3000, Math.max(1500, dragDurationMs / 2));
  const topDragSamples = Math.max(15, Math.min(30, Math.round(topDragDurationMs / 80)));
  const topDragStart = performance.now();
  await page.mouse.move(pixel.x, pixel.yThumbMiddle);
  await page.mouse.down();
  for (let index = 0; index < topDragSamples; index += 1) {
    const ratio = topDragSamples <= 1 ? 1 : index / (topDragSamples - 1);
    const targetElapsedMs = topDragDurationMs * ratio;
    const elapsedBeforeMove = performance.now() - topDragStart;
    if (targetElapsedMs > elapsedBeforeMove) {
      await page.waitForTimeout(targetElapsedMs - elapsedBeforeMove);
    }
    const y = pixel.yThumbMiddle + (pixel.yTop - pixel.yThumbMiddle) * ratio;
    await page.mouse.move(pixel.x, y, { steps: 2 });
  }
  await page.mouse.up();
  const topWait = await waitForTextMatch(
    page,
    () => {
      if (!window.tuiLab) {
        return false;
      }
      const text = window.tuiLab.text();
      return (
        text.includes('tui-lab-tool-start') ||
        text.includes('tui-lab-tool-line-001') ||
        /tui-lab-(?:tool|final)-line-\d{3,}/.test(text) ||
        text.includes('read x1 · grep x1 · TodoWrite x1 · bash x1')
      );
    },
    1500,
  );
  const topDragMs = performance.now() - topDragStart;
  await page.waitForTimeout(500);
  await captureStep(
    page,
    trace,
    'streaming-scrollbar-top',
    artifacts.streamingScrollbarTopScreenshot,
  );

  geometry = await terminalCellGeometry(page);
  internalStats = await internalScrollbarSample(page);
  pixel = scrollbarPixelGeometry(geometry, internalStats);
  await page.mouse.move(pixel.x, pixel.yThumbMiddle);
  await page.mouse.down();
  const samples = [];
  const dragStart = performance.now();
  const resizeAt = Math.floor(sampleCount / 2);
  const originalViewport = page.viewportSize();
  let resizedViewport = null;
  let markerBeforeResize = null;
  let markerAfterResize = null;
  let dimensionsBeforeResize = null;
  let dimensionsAfterResize = null;
  for (let index = 0; index < sampleCount; index += 1) {
    if (index === resizeAt && originalViewport) {
      markerBeforeResize = firstVisibleHistoryMarker(await page.evaluate(() => window.tuiLab.text()));
      dimensionsBeforeResize = await page.evaluate(() => window.tuiLab.dimensions());
      resizedViewport = {
        width: originalViewport.width,
        height: Math.max(560, originalViewport.height - 96),
      };
      await page.setViewportSize(resizedViewport);
      await page.waitForTimeout(300);
      await captureStep(
        page,
        trace,
        'streaming-scrollbar-resize-during-drag',
        path.join(artifacts.dir, 'streaming-scrollbar-resize-during-drag.png'),
      );
      markerAfterResize = firstVisibleHistoryMarker(await page.evaluate(() => window.tuiLab.text()));
      dimensionsAfterResize = await page.evaluate(() => window.tuiLab.dimensions());
      // Resize invalidates the old frame snapshot. Release and start a fresh
      // human drag against the newly painted thumb.
      await page.mouse.up();
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
      geometry = await terminalCellGeometry(page);
      internalStats = await internalScrollbarSample(page);
      pixel = scrollbarPixelGeometry(geometry, internalStats);
      // On ConPTY the first post-resize hit can be interpreted as a track
      // click because the terminal's mouse grid and the newly painted thumb
      // settle on adjacent frames. Complete that click, then sample and grab
      // the resulting thumb so the second half remains a real held drag.
      await page.mouse.move(pixel.x, pixel.yThumbMiddle);
      await page.mouse.down();
      await page.mouse.up();
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
      geometry = await terminalCellGeometry(page);
      internalStats = await internalScrollbarSample(page);
      pixel = scrollbarPixelGeometry(geometry, internalStats);
      await page.mouse.move(pixel.x, pixel.yThumbMiddle);
      await page.mouse.down();
    }
    const ratio = sampleCount <= 1 ? 1 : index / (sampleCount - 1);
    const y = pixel.yTop + (pixel.yBottom - pixel.yTop) * ratio;
    await page.mouse.move(pixel.x, y, { steps: 3 });
    await page.waitForTimeout(Math.max(16, dragDurationMs / sampleCount));
    const text = await page.evaluate(() => window.tuiLab.text());
    const scrollbar = await internalScrollbarSample(page);
    samples.push({
      sample: index + 1,
      marker: firstVisibleHistoryMarker(text),
      hasFinalSentinel: text.includes('tui-lab-final-sentinel'),
      hasFinalLine120: text.includes('tui-lab-final-line-120'),
      dimensions: await page.evaluate(() => window.tuiLab.dimensions()),
      ...scrollbar,
    });
  }
  await page.mouse.move(pixel.x, pixel.yBottom, { steps: 3 });
  await page.mouse.up();
  const bottomText = await page.evaluate(() => window.tuiLab.text());
  await captureStep(
    page,
    trace,
    'streaming-scrollbar-bottom',
    artifacts.streamingScrollbarBottomScreenshot,
  );

  const beforeFinalSamples = samples.filter((sample) => !sample.hasFinalSentinel);
  const visibleSamples = samples.filter((sample) => sample.trackRows.length > 0);
  const bottomMarker = firstVisibleHistoryMarker(bottomText);
  const bottomScore = bottomMarker?.score ?? -1;
  const beforeScore = beforeMarker?.score ?? -1;
  return {
    rows: dimensions.rows,
    cols: dimensions.cols,
    streamDelayMs,
    streamReadyWaitMs: streamReady.waitMs,
    startedBeforeFinalSentinel: !beforeText.includes('tui-lab-final-sentinel'),
    beforeMarker,
    beforeStats,
    topDragMs: Math.round(topDragMs),
    topDragDurationMs,
    topDragSamples,
    topReached: textHasEarlyToolHistory(topWait.text),
    topHadFinalSentinel: topWait.text.includes('tui-lab-final-sentinel'),
    dragMs: Math.round(performance.now() - dragStart),
    dragDurationMs,
    resizedDuringDrag: Boolean(resizedViewport),
    originalViewport,
    resizedViewport,
    markerBeforeResize,
    markerAfterResize,
    dimensionsBeforeResize,
    dimensionsAfterResize,
    resizeKeptVisibleAnchor:
      markerBeforeResize?.kind === markerAfterResize?.kind &&
      Math.abs((markerBeforeResize?.score ?? 0) - (markerAfterResize?.score ?? 0)) <=
        Math.abs((dimensionsBeforeResize?.rows ?? 0) - (dimensionsAfterResize?.rows ?? 0)) + 2,
    samplesBeforeFinalSentinel: beforeFinalSamples.length,
    samplesWithScrollbar: visibleSamples.length,
    contiguousThumbDuringDrag: visibleSamples.every((sample) => sample.thumbRuns.length <= 1),
    singleColumnRailDuringDrag: visibleSamples.every(
      (sample) => sample.adjacentRailRows.length === 0,
    ),
    bottomMarker,
    returnedToLiveTail: bottomScore >= beforeScore && bottomScore >= 500,
    bottomHasFinalSentinel: bottomText.includes('tui-lab-final-sentinel'),
    bottomHasFinalLine120: bottomText.includes('tui-lab-final-line-120'),
    samples,
  };
}

export async function measureReleasedMouseMoveStability(page, trace, artifacts) {
  const geometry = await terminalCellGeometry(page);
  const { box, cellWidth, cellHeight } = geometry;
  const contentX = box.x + box.width * 0.45;
  const firstY = box.y + cellHeight * 6;
  const secondY = box.y + box.height - cellHeight * 6;
  const beforeText = await page.evaluate(() => window.tuiLab.text());
  const beforeStats = await internalScrollbarSample(page);
  const beforeMarker = firstVisibleHistoryMarker(beforeText);

  for (let index = 0; index < 8; index += 1) {
    const y = index % 2 === 0 ? firstY : secondY;
    await page.mouse.move(contentX, y, { steps: 3 });
    await page.waitForTimeout(35);
  }
  const afterText = await page.evaluate(() => window.tuiLab.text());
  const afterStats = await internalScrollbarSample(page);
  const afterMarker = firstVisibleHistoryMarker(afterText);
  await captureStep(
    page,
    trace,
    'after-release-mouse-move',
    artifacts.afterReleaseMouseMoveScreenshot,
  );

  return {
    beforeMarker,
    afterMarker,
    beforeStats,
    afterStats,
    sameText: beforeText === afterText,
    sameMarker: JSON.stringify(beforeMarker) === JSON.stringify(afterMarker),
    sameThumbRows: JSON.stringify(beforeStats.thumbRows) === JSON.stringify(afterStats.thumbRows),
    sameThumbRuns: JSON.stringify(beforeStats.thumbRuns) === JSON.stringify(afterStats.thumbRuns),
  };
}

export async function captureOptionalStep(page, trace, name, file) {
  await captureStep(page, trace, name, file);
}

export async function measureHeldScrollbarDragSamples(page, trace, artifacts, label, options = {}) {
  const sampleCount = options.sampleCount ?? 14;
  const dragDurationMs = options.dragDurationMs ?? 980;
  const sampleDelayMs = Math.max(1, dragDurationMs / Math.max(1, sampleCount));
  const moveSteps = Math.max(1, Math.min(3, Math.round(sampleDelayMs / 40)));
  await page.keyboard.press('End');
  await page.waitForTimeout(120);
  const geometry = await terminalCellGeometry(page);
  const before = await scrollbarTextSample(page, 0, 'before-drag');
  const pixel = scrollbarPixelGeometryFromStats(geometry, before);
  const screenshots = {
    before: path.join(artifacts.dir, `${label}-before.png`),
    heldStart: path.join(artifacts.dir, `${label}-held-start.png`),
    heldMiddle: path.join(artifacts.dir, `${label}-held-middle.png`),
    heldEnd: path.join(artifacts.dir, `${label}-held-end.png`),
    afterUp: path.join(artifacts.dir, `${label}-after-up.png`),
  };
  await captureOptionalStep(page, trace, `${label}-before`, screenshots.before);

  const samples = [];
  await page.mouse.move(pixel.x, pixel.yThumbMiddle);
  await page.mouse.down();
  const startedAt = performance.now();
  for (let index = 0; index < sampleCount; index += 1) {
    const ratio = sampleCount <= 1 ? 1 : index / (sampleCount - 1);
    const targetElapsedMs = dragDurationMs * ratio;
    const elapsedBeforeMove = performance.now() - startedAt;
    if (targetElapsedMs > elapsedBeforeMove) {
      await page.waitForTimeout(targetElapsedMs - elapsedBeforeMove);
    }
    const y = pixel.yThumbMiddle + (pixel.yTop - pixel.yThumbMiddle) * ratio;
    await page.mouse.move(pixel.x, y, { steps: moveSteps });
    const sample = await scrollbarTextSample(page, index + 1, 'held');
    sample.elapsedMs = Math.round(performance.now() - startedAt);
    samples.push(sample);
    if (index === 0) {
      await captureOptionalStep(page, trace, `${label}-held-start`, screenshots.heldStart);
    } else if (index === Math.floor(sampleCount / 2)) {
      await captureOptionalStep(page, trace, `${label}-held-middle`, screenshots.heldMiddle);
    } else if (index === sampleCount - 1) {
      await captureOptionalStep(page, trace, `${label}-held-end`, screenshots.heldEnd);
    }
  }
  await page.mouse.up();
  await page.waitForTimeout(120);
  const afterUp = await scrollbarTextSample(page, sampleCount + 1, 'after-up');
  await captureOptionalStep(page, trace, `${label}-after-up`, screenshots.afterUp);

  const heldSignatures = samples.map((sample) => sample.signature);
  const heldThumbStarts = samples.map((sample) => sample.firstThumbRow);
  const heldThumbHeights = samples.map((sample) => sample.thumbRows);
  return {
    before,
    samples,
    afterUp,
    screenshots,
    contentChangedWhileHeld: uniqueValues(heldSignatures).length > 1,
    thumbMovedWhileHeld: numericRange(heldThumbStarts) > 0,
    thumbHeightDeltaRows: numericRange(heldThumbHeights),
    afterUpSignatureChanged:
      afterUp.signature !== (samples.at(-1)?.signature ?? before.signature),
    afterUpThumbJumpRows: Math.abs(
      (afterUp.firstThumbRow ?? 0) - (samples.at(-1)?.firstThumbRow ?? afterUp.firstThumbRow ?? 0),
    ),
    dragDurationTargetMs: dragDurationMs,
    dragDurationActualMs: Math.round(performance.now() - startedAt),
    sampleDelayMs: Math.round(sampleDelayMs),
    moveSteps,
  };
}

export async function measureReleasedMouseMoveDetailed(page, trace, artifacts, label, sampleCount = 12) {
  const geometry = await terminalCellGeometry(page);
  const before = await scrollbarTextSample(page, 0, 'before-move');
  const pixel = scrollbarPixelGeometryFromStats(geometry, before);
  const screenshots = {
    before: path.join(artifacts.dir, `${label}-before.png`),
    after: path.join(artifacts.dir, `${label}-after.png`),
  };
  await captureOptionalStep(page, trace, `${label}-before`, screenshots.before);

  const yUpper = geometry.box.y + geometry.cellHeight * 5;
  const yLower = geometry.box.y + geometry.box.height - geometry.cellHeight * 7;
  const xPositions = [
    { name: 'content', x: pixel.contentX },
    { name: 'edge-content', x: pixel.edgeContentX },
    { name: 'track-column', x: pixel.trackX },
  ];
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const point = xPositions[index % xPositions.length];
    const y = index % 2 === 0 ? yUpper : yLower;
    await page.mouse.move(point.x, y, { steps: 4 });
    await page.waitForTimeout(55);
    const sample = await scrollbarTextSample(page, index + 1, `move-${point.name}`);
    samples.push(sample);
  }
  const after = await scrollbarTextSample(page, sampleCount + 1, 'after-move');
  await captureOptionalStep(page, trace, `${label}-after`, screenshots.after);

  const signatures = samples.map((sample) => sample.signature);
  const thumbStarts = samples.map((sample) => sample.firstThumbRow);
  const thumbHeights = samples.map((sample) => sample.thumbRows);
  return {
    before,
    samples,
    after,
    screenshots,
    uniqueSignatures: uniqueValues(signatures).length,
    thumbTopDeltaRows: numericRange(thumbStarts),
    thumbHeightDeltaRows: numericRange(thumbHeights),
    stable:
      uniqueValues(signatures).length <= 1 &&
      numericRange(thumbStarts) <= 1 &&
      numericRange(thumbHeights) === 0,
  };
}

export async function measureRapidPageScroll(page) {
  const initialText = await page.evaluate(() => window.tuiLab.text());
  const upStart = performance.now();
  await pressBurst(page, 'PageUp', 3);
  await page.waitForFunction(
    (previous) => window.tuiLab && window.tuiLab.text() !== previous,
    initialText,
    { timeout: 1000 },
  );
  const upMs = performance.now() - upStart;
  const afterUpText = await page.evaluate(() => window.tuiLab.text());

  const downStart = performance.now();
  await pressBurst(page, 'PageDown', 3);
  await page.waitForFunction(
    () =>
      window.tuiLab &&
      window.tuiLab.text().includes('tui-lab-final-line-120') &&
      window.tuiLab.text().includes('tui-lab-final-sentinel'),
    null,
    { timeout: 1000 },
  );
  const downMs = performance.now() - downStart;
  const afterDownText = await page.evaluate(() => window.tuiLab.text());

  return {
    upMs: Math.round(upMs),
    downMs: Math.round(downMs),
    totalMs: Math.round(upMs + downMs),
    changedOnPageUp: afterUpText !== initialText,
    returnedToTail:
      afterDownText.includes('tui-lab-final-line-120') &&
      afterDownText.includes('tui-lab-final-sentinel'),
  };
}

export async function measureFullScrollCycles(page, cycles = 3, pressesPerDirection = 40) {
  const results = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const upStart = performance.now();
    await pressBurst(page, 'PageUp', pressesPerDirection);
    await page.waitForFunction(
      () => {
        if (!window.tuiLab) {
          return false;
        }
        const text = window.tuiLab.text();
        return (
          !text.includes('tui-lab-final-line-120') &&
          (text.includes('tui-lab-tool-start') ||
            text.includes('tui-lab-tool-line-001') ||
            text.includes('read x1 · grep x1 · TodoWrite x1 · bash x1'))
        );
      },
      null,
      { timeout: 2000 },
    );
    const upMs = performance.now() - upStart;
    const topText = await page.evaluate(() => window.tuiLab.text());

    const downStart = performance.now();
    await pressBurst(page, 'PageDown', pressesPerDirection);
    await page.waitForFunction(
      () =>
        window.tuiLab &&
        window.tuiLab.text().includes('tui-lab-final-line-120') &&
        window.tuiLab.text().includes('tui-lab-final-sentinel'),
      null,
      { timeout: 2000 },
    );
    const downMs = performance.now() - downStart;
    const bottomText = await page.evaluate(() => window.tuiLab.text());

    results.push({
      cycle: cycle + 1,
      upMs: Math.round(upMs),
      downMs: Math.round(downMs),
      totalMs: Math.round(upMs + downMs),
      reachedTop: textShowsEarlierHistory(topText),
      returnedToTail:
        bottomText.includes('tui-lab-final-line-120') &&
        bottomText.includes('tui-lab-final-sentinel'),
    });
  }

  const totals = results.map((result) => result.totalMs);
  const upTimes = results.map((result) => result.upMs);
  const downTimes = results.map((result) => result.downMs);
  return {
    cycles: results,
    maxTotalMs: totals.length ? Math.max(...totals) : 0,
    maxUpMs: upTimes.length ? Math.max(...upTimes) : 0,
    maxDownMs: downTimes.length ? Math.max(...downTimes) : 0,
    allReachedTop: results.every((result) => result.reachedTop),
    allReturnedToTail: results.every((result) => result.returnedToTail),
  };
}

export async function wheelUntil(page, deltaY, maxEvents, boundary, timeoutMs = 10_000) {
  await placeMouseOverTerminal(page);
  const start = performance.now();
  const initial = await fetchViewportDiagnostics(page);
  if (initial.latestCommit?.boundary === boundary) {
    return { ms: 0, events: 0, reached: true, boundary, commit: initial.latestCommit };
  }
  const producerId = await page.evaluate(
    ({ deltaY, maxEvents }) => {
      const id = `wheel-${Date.now()}-${Math.random()}`;
      window.__tuiLabWheelProducers ||= new Map();
      const target = document.querySelector('#terminal .xterm-viewport');
      if (!target) throw new Error('xterm viewport unavailable for wheel producer');
      const bounds = target.getBoundingClientRect();
      const state = { events: 0, done: false, interval: null };
      state.interval = setInterval(() => {
        if (state.events >= maxEvents) {
          clearInterval(state.interval);
          state.done = true;
          return;
        }
        target.dispatchEvent(new WheelEvent('wheel', {
          deltaY,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          bubbles: true,
          cancelable: true,
          clientX: bounds.x + bounds.width / 2,
          clientY: bounds.y + bounds.height / 2,
        }));
        state.events += 1;
      }, 30);
      window.__tuiLabWheelProducers.set(id, state);
      return id;
    },
    { deltaY, maxEvents },
  );
  let cursor = initial.latestSequence || 0;
  let reachedCommit = null;
  let producerResult = { events: 0, done: false };
  try {
    while (performance.now() - start < timeoutMs && !reachedCommit) {
      const diagnostic = await fetchViewportDiagnostics(page, cursor);
      cursor = Math.max(cursor, diagnostic.latestSequence || 0);
      reachedCommit = (diagnostic.events || []).find(
        (event) => event.phase === 'commit' && event.boundary === boundary,
      ) || null;
      if (!reachedCommit) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    producerResult = await page.evaluate((id) => {
      const state = window.__tuiLabWheelProducers?.get(id);
      if (!state) return { events: 0, done: true };
      clearInterval(state.interval);
      state.done = true;
      window.__tuiLabWheelProducers.delete(id);
      return { events: state.events, done: state.done };
    }, producerId);
  }
  return {
    ms: Math.round(performance.now() - start),
    events: producerResult.events,
    reached: Boolean(reachedCommit),
    boundary,
    commit: reachedCommit,
  };
}

export async function measureWheelScrollCycles(page, cycles = 3, maxWheelsPerDirection = 120) {
  const results = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const initialBottom = await wheelUntil(page, 720, maxWheelsPerDirection, 'bottom');
    const up = await wheelUntil(
      page,
      -720,
      maxWheelsPerDirection,
      'top',
    );
    const down = await wheelUntil(
      page,
      720,
      maxWheelsPerDirection,
      'bottom',
    );

    results.push({
      cycle: cycle + 1,
      startedAtBottom: initialBottom.reached,
      upMs: up.ms,
      downMs: down.ms,
      totalMs: up.ms + down.ms,
      upEvents: up.events,
      downEvents: down.events,
      reachedTop: initialBottom.reached && up.reached,
      returnedToTail: down.reached,
    });
  }

  const totals = results.map((result) => result.totalMs);
  const upTimes = results.map((result) => result.upMs);
  const downTimes = results.map((result) => result.downMs);
  return {
    cycles: results,
    maxTotalMs: totals.length ? Math.max(...totals) : 0,
    maxUpMs: upTimes.length ? Math.max(...upTimes) : 0,
    maxDownMs: downTimes.length ? Math.max(...downTimes) : 0,
    allReachedTop: results.every((result) => result.reachedTop),
    allReturnedToTail: results.every((result) => result.returnedToTail),
  };
}

function isOutwardBoundaryDwell(sample, distance) {
  if (distance !== 0) return false;
  return (
    (sample.boundaryAfter === 'top' && sample.direction < 0) ||
    (sample.boundaryAfter === 'bottom' && sample.direction > 0) ||
    sample.boundaryAfter === 'fit'
  );
}

function longestConsecutive(items, predicate) {
  let longest = 0;
  let current = 0;
  for (const item of items) {
    current = predicate(item) ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function directionSign(direction) {
  if (direction === 'up' || direction === -1) return -1;
  if (direction === 'down' || direction === 1) return 1;
  return 0;
}

function cancelReversedInputs(inputs) {
  const stack = [];
  for (const input of inputs) {
    let remaining = Math.abs(Number(input.accepted_delta ?? input.applied_delta) || 0);
    const sign = directionSign(input.direction);
    if (input.cancelled_pending_delta != null) {
      let cancelled = Math.abs(Number(input.cancelled_pending_delta) || 0);
      while (cancelled > 0 && stack.length && stack.at(-1).sign !== sign) {
        const previous = stack.at(-1);
        const removed = Math.min(cancelled, previous.remaining);
        previous.remaining -= removed;
        cancelled -= removed;
        if (previous.remaining === 0) stack.pop();
      }
      if (remaining > 0 && sign) stack.push({ ...input, sign, remaining });
      continue;
    }
    if (!remaining || !sign) continue;
    while (remaining > 0 && stack.length && stack.at(-1).sign !== sign) {
      const previous = stack.at(-1);
      const cancelled = Math.min(remaining, previous.remaining);
      remaining -= cancelled;
      previous.remaining -= cancelled;
      if (previous.remaining === 0) stack.pop();
    }
    if (remaining > 0) stack.push({ ...input, sign, remaining });
  }
  return stack;
}

function outwardAtBoundary(input, boundary) {
  const sign = directionSign(input.direction);
  return boundary === 'fit' || (boundary === 'top' && sign < 0) || (boundary === 'bottom' && sign > 0);
}

export function summarizeViewportSequenceEvents(events, durationMs = 10_000) {
  const ordered = [...events]
    .filter((event) => Number.isSafeInteger(event.sequence))
    .sort((left, right) => left.sequence - right.sequence);
  const inputs = ordered.filter((event) => event.phase === 'input');
  const commits = ordered.filter((event) => event.phase === 'commit');
  const inputBySequence = new Map(inputs.map((event) => [event.input_sequence, event]));
  const originMicros = inputs[0]?.timestamp_micros ?? commits[0]?.timestamp_micros ?? 0;
  const seconds = Array.from({ length: Math.ceil(durationMs / 1000) }, (_, index) => ({
    second: index + 1,
    effectiveInputs: 0,
    excludedOutwardInputs: 0,
    progressRows: 0,
    commitBatches: 0,
    stalled: false,
  }));
  const groups = [];
  const segments = [];
  let previousCommit = commits[0] || null;
  let appliedThrough = Number(previousCommit?.applied_through_input_sequence) || 0;

  for (const commit of commits.slice(previousCommit ? 1 : 0)) {
    const through = Number(commit.applied_through_input_sequence) || appliedThrough;
    if (through <= appliedThrough) {
      previousCommit = commit;
      continue;
    }
    const batch = [];
    for (let sequence = appliedThrough + 1; sequence <= through; sequence += 1) {
      const input = inputBySequence.get(sequence);
      if (input) batch.push(input);
    }
    const boundaryBefore = previousCommit?.boundary || 'none';
    const topBefore = Number(previousCommit?.top ?? previousCommit?.visible_top);
    const topAfter = Number(commit.top ?? commit.visible_top);
    const maxTop = Math.max(
      0,
      Number(previousCommit?.content_rows || commit.content_rows || 0) -
        Number(previousCommit?.viewport_rows || commit.viewport_rows || 0),
    );
    let virtualTop = topBefore;
    const excluded = [];
    const boundaryTruncated = [];
    const candidates = [];
    const coalesced = batch.filter((input) => Number(input.coalesced_delta) !== 0 && input.coalesced_delta != null);
    for (const input of cancelReversedInputs(batch)) {
      const delta = input.sign * input.remaining;
      const virtualBoundary = maxTop === 0 ? 'fit' : virtualTop <= 0 ? 'top' : virtualTop >= maxTop ? 'bottom' : 'none';
      const nextTop = Math.max(0, Math.min(maxTop, virtualTop + delta));
      if (nextTop === virtualTop && outwardAtBoundary(input, virtualBoundary)) excluded.push(input);
      else if (Math.abs(nextTop - virtualTop) < Math.abs(delta)) boundaryTruncated.push(input);
      else candidates.push(input);
      virtualTop = nextTop;
    }
    const effective = candidates;
    const progressRows = Number.isFinite(topBefore) && Number.isFinite(topAfter)
      ? Math.abs(topAfter - topBefore)
      : 0;
    const nonBoundary = boundaryBefore === 'none' && commit.boundary === 'none';
    // A clipped tick is exempt only from the full-tick minimum, not from
    // reaching the boundary it could still move toward.
    const boundaryProgressMet = boundaryTruncated.length === 0 || topAfter === virtualTop;
    const stalled = (effective.length > 0 && progressRows === 0 && nonBoundary)
      || !boundaryProgressMet;
    const group = {
      commitSequence: commit.sequence,
      appliedThroughInputSequence: through,
      inputSequences: batch.map((input) => input.input_sequence),
      effectiveInputSequences: effective.map((input) => input.input_sequence),
      excludedOutwardInputSequences: excluded.map((input) => input.input_sequence),
      boundaryTruncatedInputSequences: boundaryTruncated.map((input) => input.input_sequence),
      coalescedInputSequences: coalesced.map((input) => input.input_sequence),
      boundaryProgressMet,
      appliedDelta: Number(commit.applied_delta) || 0,
      topBefore,
      topAfter,
      boundaryBefore,
      boundaryAfter: commit.boundary,
      progressRows,
      effectiveInputs: effective.length,
      stalled,
    };
    groups.push(group);
    const atMs = Math.max(0, ((Number(commit.timestamp_micros) || originMicros) - originMicros) / 1000);
    const bucket = seconds[Math.min(seconds.length - 1, Math.floor(atMs / 1000))];
    if (bucket) {
      bucket.effectiveInputs += effective.length;
      bucket.excludedOutwardInputs += excluded.length;
      bucket.progressRows += progressRows;
      bucket.commitBatches += 1;
      bucket.stalled ||= stalled;
    }
    let groupSegment = null;
    for (const input of effective) {
      const direction = directionSign(input.direction);
      let segment = segments.at(-1);
      if (!segment || segment.direction !== direction) {
        segment = { direction, effectiveInputs: 0, progressRows: 0, inputSequences: [] };
        segments.push(segment);
      }
      segment.effectiveInputs += 1;
      segment.inputSequences.push(input.input_sequence);
      groupSegment = segment;
    }
    const movementDirection = Math.sign(topAfter - topBefore);
    if (groupSegment?.direction === movementDirection) groupSegment.progressRows += progressRows;
    appliedThrough = through;
    previousCommit = commit;
  }

  const effectiveInputs = groups.reduce((sum, group) => sum + group.effectiveInputs, 0);
  const excludedOutwardInputs = groups.reduce(
    (sum, group) => sum + group.excludedOutwardInputSequences.length,
    0,
  );
  const progressRows = groups.reduce((sum, group) => sum + group.progressRows, 0);
  const minimumProgressRows = inputs.find((event) => Number(event.minimum_progress_rows) > 0)
    ?.minimum_progress_rows ?? null;
  const progressPerEffectiveInput = effectiveInputs > 0 ? progressRows / effectiveInputs : 0;
  for (const bucket of seconds) {
    bucket.stalled ||= bucket.effectiveInputs > 0 && bucket.progressRows === 0;
  }
  const lateSeconds = seconds.slice(5);
  const maxInputSequence = Math.max(0, ...inputs.map((event) => Number(event.input_sequence) || 0));
  const maxCommittedInputSequence = Math.max(
    0,
    ...commits.map((event) => Number(event.applied_through_input_sequence) || 0),
  );
  return {
    events: ordered,
    groups,
    segments,
    seconds,
    observedTotal: inputs.length,
    committedTotal: commits.length,
    committedInputTotal: inputs.filter(
      (input) => Number(input.input_sequence) <= maxCommittedInputSequence,
    ).length,
    commitObserved: inputs.length > 0 && maxCommittedInputSequence >= maxInputSequence,
    observationFresh: groups.some(
      (group) => group.progressRows > 0 || group.excludedOutwardInputSequences.length > 0,
    ),
    effectiveInputs,
    excludedOutwardInputs,
    boundaryTruncatedInputs: groups.reduce((sum, group) => sum + group.boundaryTruncatedInputSequences.length, 0),
    coalescedInputs: groups.reduce((sum, group) => sum + group.coalescedInputSequences.length, 0),
    progressRows,
    minimumProgressRows,
    progressPerEffectiveInput: Number(progressPerEffectiveInput.toFixed(2)),
    progressRequirementMet:
      Number(minimumProgressRows) > 0 &&
      groups.every((group) => group.boundaryProgressMet && !group.stalled) &&
      effectiveInputs > 0 &&
      progressPerEffectiveInput >= Number(minimumProgressRows),
    staleObservationSeconds: seconds.filter((item) => item.stalled).map((item) => item.second),
    longestNonBoundaryStall: longestConsecutive(lateSeconds, (item) => item.stalled),
    earlyRowsPerSecond: Math.round(
      seconds.slice(0, 3).reduce((sum, item) => sum + item.progressRows, 0) / 3,
    ),
    lateRowsPerSecond: Math.round(
      lateSeconds.reduce((sum, item) => sum + item.progressRows, 0) / Math.max(1, lateSeconds.length),
    ),
  };
}

export function summarizeSustainedSamples(samples, durationMs = 10_000) {
  const seconds = Array.from({ length: Math.ceil(durationMs / 1000) }, (_, index) => ({
    second: index + 1,
    distance: 0,
    sent: 0,
    observed: 0,
    committed: 0,
    boundaryDwellSamples: 0,
  }));
  let previousSent = 0;
  let previousObserved = 0;
  let previousCommitted = 0;

  for (const sample of samples) {
    const bucketIndex = Math.min(seconds.length - 1, Math.max(0, Math.floor(sample.atMs / 1000)));
    const bucket = seconds[bucketIndex];
    const sent = Math.max(0, Number(sample.sent) || 0);
    const observed = Math.max(0, Number(sample.observed) || 0);
    const committed = Math.max(0, Number(sample.committed) || 0);
    const sentDelta = Math.max(0, sent - previousSent);
    const observedDelta = Math.max(0, observed - previousObserved);
    const committedDelta = Math.max(0, committed - previousCommitted);
    const distance = Number.isFinite(sample.topBefore) && Number.isFinite(sample.topAfter)
      ? Math.abs(sample.topAfter - sample.topBefore)
      : 0;
    bucket.sent += sentDelta;
    bucket.observed += observedDelta;
    bucket.committed += committedDelta;
    bucket.distance += distance;
    if (isOutwardBoundaryDwell(sample, distance) && sentDelta > 0) bucket.boundaryDwellSamples += 1;
    previousSent = sent;
    previousObserved = observed;
    previousCommitted = committed;
  }

  for (const bucket of seconds) {
    bucket.boundaryDwell = bucket.distance === 0 && bucket.boundaryDwellSamples > 0;
    bucket.inputNotDelivered = bucket.sent > 0 && bucket.observed === 0;
    bucket.inputNotCommitted = bucket.observed > 0 && bucket.committed === 0;
    bucket.observationStale = bucket.committed > 0 && bucket.distance === 0 && !bucket.boundaryDwell;
    bucket.stalled = bucket.observed > 0 && bucket.distance === 0 && !bucket.boundaryDwell;
  }

  const averageActiveDistance = (items) => {
    const active = items.filter((item) => !item.boundaryDwell);
    return active.reduce((sum, item) => sum + item.distance, 0) / Math.max(1, active.length);
  };
  const early = averageActiveDistance(seconds.slice(0, 3));
  const lateSeconds = seconds.slice(5);
  const late = averageActiveDistance(lateSeconds);
  const activeLateDistances = lateSeconds.filter((item) => !item.boundaryDwell).map((item) => item.distance);
  const sentTotal = seconds.reduce((sum, item) => sum + item.sent, 0);
  const observedTotal = seconds.reduce((sum, item) => sum + item.observed, 0);
  const committedTotal = seconds.reduce((sum, item) => sum + item.committed, 0);
  const finalSample = samples.at(-1);
  const finalInputTimestamp = finalSample?.inputTimestampMicros;
  const finalCommitTimestamp = finalSample?.commitTimestampMicros;
  const finalInputWasCommitted =
    !Number.isFinite(finalInputTimestamp) ||
    !Number.isFinite(finalCommitTimestamp) ||
    finalCommitTimestamp >= finalInputTimestamp;
  return {
    samples,
    seconds,
    sentTotal,
    observedTotal,
    committedTotal,
    inputDeliveryOk: sentTotal > 0 && observedTotal >= sentTotal,
    commitObserved: observedTotal > 0 && committedTotal > 0 && finalInputWasCommitted,
    observationFresh: lateSeconds.some((item) => item.distance > 0 || item.boundaryDwell),
    inputNotDeliveredSeconds: seconds.filter((item) => item.inputNotDelivered).map((item) => item.second),
    inputNotCommittedSeconds: seconds.filter((item) => item.inputNotCommitted).map((item) => item.second),
    staleObservationSeconds: seconds.filter((item) => item.observationStale).map((item) => item.second),
    earlyRowsPerSecond: Math.round(early),
    lateRowsPerSecond: Math.round(late),
    lateToEarlyRatio: early > 0 ? Number((late / early).toFixed(2)) : 0,
    minLateRowsPerSecond: activeLateDistances.length ? Math.min(...activeLateDistances) : 0,
    stalledLateSeconds: lateSeconds.filter((item) => item.stalled).length,
    longestLateStall: longestConsecutive(lateSeconds, (item) => item.stalled),
  };
}

export async function measureSustainedWheelScroll(page, durationMs = 10_000) {
  await placeMouseOverTerminal(page);
  const budgets = interactionBudgetsForPlatform(process.platform);
  const wheelDelta = budgets.sustainedWheelDelta;
  const samples = [];
  const started = performance.now();
  const readDiagnostics = (afterSequence = 0) => fetchViewportDiagnostics(page, afterSequence);
  const waitForTimer = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
  const initialDiagnostic = await readDiagnostics();
  const inputBaseline = initialDiagnostic.latestInput?.input_sequence || 0;
  let traceCursor = initialDiagnostic.latestSequence || 0;
  const traceEvents = initialDiagnostic.latestCommit ? [initialDiagnostic.latestCommit] : [];
  const inputPeriodMs = 30;
  const samplePeriodMs = 100;

  const producer = page.evaluate(
    ({ durationMs, wheelDelta, directionPeriodMs, inputPeriodMs, directionSampleMs, controllerStartSequence }) =>
      new Promise((resolve, reject) => {
        const producerStarted = performance.now();
        const sentEvents = [];
        const controllerAbort = new AbortController();
        let controllerSequence = controllerStartSequence;
        let direction = -1;
        let stopped = false;
        const target = document.querySelector('#terminal .xterm-viewport');
        if (!target) {
          reject(new Error('xterm viewport unavailable for sustained wheel producer'));
          return;
        }
        const bounds = target.getBoundingClientRect();
        const controller = (async () => {
          while (!stopped && !directionPeriodMs) {
            try {
              const response = await fetch(`/viewport-diagnostics?after=${controllerSequence}`, {
                cache: 'no-store',
                signal: controllerAbort.signal,
              });
              if (response.ok) {
                const diagnostic = await response.json();
                controllerSequence = Math.max(controllerSequence, diagnostic.latestSequence || 0);
                if (diagnostic.latestCommit?.boundary === 'top') direction = 1;
                if (diagnostic.latestCommit?.boundary === 'bottom') direction = -1;
              }
            } catch (error) {
              if (error?.name !== 'AbortError') throw error;
            }
            if (!stopped) await new Promise((resume) => setTimeout(resume, directionSampleMs));
          }
        })();
        const interval = setInterval(() => {
          const elapsed = performance.now() - producerStarted;
          if (directionPeriodMs) {
            direction = Math.floor(elapsed / directionPeriodMs) % 2 ? 1 : -1;
          }
          target.dispatchEvent(new WheelEvent('wheel', {
            deltaY: direction * wheelDelta,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            bubbles: true,
            cancelable: true,
            clientX: bounds.x + bounds.width / 2,
            clientY: bounds.y + bounds.height / 2,
          }));
          sentEvents.push({ sentAtMs: elapsed, direction });
        }, inputPeriodMs);
        setTimeout(async () => {
          clearInterval(interval);
          stopped = true;
          controllerAbort.abort();
          try {
            await controller;
            resolve({ sentEvents, stoppedAtMs: performance.now() - producerStarted });
          } catch (error) {
            reject(error);
          }
        }, durationMs);
      }),
    {
      durationMs,
      wheelDelta,
      directionPeriodMs: budgets.sustainedDirectionPeriodMs,
      inputPeriodMs,
      directionSampleMs: samplePeriodMs,
      controllerStartSequence: traceCursor,
    },
  );

  const sampler = async () => {
    let tick = 0;
    while (performance.now() - started < durationMs) {
      const diagnostic = await readDiagnostics(traceCursor);
      const newEvents = diagnostic.events || [];
      traceEvents.push(...newEvents);
      traceCursor = Math.max(traceCursor, diagnostic.latestSequence || 0);
      const newCommits = newEvents.filter((event) => event.phase === 'commit');
      const newInputs = newEvents.filter((event) => event.phase === 'input');
      samples.push({
        atMs: performance.now() - started,
        sent: 0,
        observed: traceEvents.filter((event) => event.phase === 'input').length,
        committed: traceEvents.filter((event) => event.phase === 'commit').length - 1,
        direction: directionSign(newInputs.at(-1)?.direction),
        topBefore: newCommits[0]?.top ?? null,
        topAfter: newCommits.at(-1)?.top ?? null,
        boundaryBefore: newCommits[0]?.boundary ?? null,
        boundaryAfter: diagnostic.latestCommit?.boundary ?? null,
        generation: diagnostic.latestCommit?.generation ?? null,
        firstSequence: newEvents[0]?.sequence ?? null,
        lastSequence: newEvents.at(-1)?.sequence ?? null,
      });
      tick += 1;
      const remaining = tick * samplePeriodMs - (performance.now() - started);
      if (remaining > 0) await waitForTimer(remaining);
    }
  };

  const [producerResult] = await Promise.all([producer, sampler()]);
  const expectedSent = producerResult.sentEvents.length;
  const drainDeadline = Date.now() + 1000;
  let finalDiagnostic;
  do {
    finalDiagnostic = await readDiagnostics(traceCursor);
    traceEvents.push(...(finalDiagnostic.events || []));
    traceCursor = Math.max(traceCursor, finalDiagnostic.latestSequence || 0);
    const observed = Math.max(0, (finalDiagnostic.latestInput?.input_sequence || 0) - inputBaseline);
    const committedThroughInput =
      (finalDiagnostic.latestCommit?.applied_through_input_sequence || 0) >= inputBaseline + expectedSent;
    if (observed >= expectedSent && committedThroughInput) break;
    await waitForTimer(50);
  } while (Date.now() < drainDeadline);
  samples.push({
    atMs: performance.now() - started,
    sent: 0,
    observed: Math.max(0, (finalDiagnostic.latestInput?.input_sequence || 0) - inputBaseline),
    committed: traceEvents.filter((event) => event.phase === 'commit').length - 1,
    direction: 0,
    topBefore: null,
    topAfter: finalDiagnostic.latestCommit?.top ?? null,
    boundaryBefore: null,
    boundaryAfter: finalDiagnostic.latestCommit?.boundary ?? null,
    generation: finalDiagnostic.latestCommit?.generation ?? null,
    firstSequence: null,
    lastSequence: finalDiagnostic.latestSequence || null,
  });
  let sent = 0;
  let direction = -1;
  for (const sample of samples) {
    while (producerResult.sentEvents[sent]?.sentAtMs <= sample.atMs) {
      direction = producerResult.sentEvents[sent].direction;
      sent += 1;
    }
    sample.sent = sent;
    sample.direction = direction;
  }
  const sequenceSummary = summarizeViewportSequenceEvents(traceEvents, durationMs);
  return {
    ...sequenceSummary,
    samples,
    sentTotal: producerResult.sentEvents.length,
    inputDeliveryOk: sequenceSummary.observedTotal >= producerResult.sentEvents.length,
    inputNotDeliveredSeconds:
      sequenceSummary.observedTotal >= producerResult.sentEvents.length ? [] : [Math.ceil(durationMs / 1000)],
    inputNotCommittedSeconds: sequenceSummary.commitObserved ? [] : [Math.ceil(durationMs / 1000)],
    longestLateStall: sequenceSummary.longestNonBoundaryStall,
    producer: {
      sent: producerResult.sentEvents.length,
      stoppedAtMs: producerResult.stoppedAtMs,
      drained:
        (finalDiagnostic.latestCommit?.applied_through_input_sequence || 0) >= inputBaseline + expectedSent,
    },
  };
}
