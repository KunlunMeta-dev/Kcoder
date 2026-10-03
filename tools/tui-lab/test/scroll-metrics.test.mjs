import assert from 'node:assert/strict';
import test from 'node:test';

import { runAssertions } from '../lib/assertions.mjs';
import {
  firstVisibleHistoryMarker,
  summarizeScrollbarRange,
  numericRange,
  summarizeSustainedSamples,
  summarizeViewportSequenceEvents,
  terminalRightEdgeScrollbarStats,
  textContainsAcrossWrap,
  textHasEarlyToolHistory,
} from '../lib/scroll-metrics.mjs';

function viewportEvents(deltas, { startTop = 120, contentRows = 240, viewportRows = 30 } = {}) {
  let sequence = 1;
  let inputSequence = 0;
  let top = startTop;
  const events = [{
    id: 'commit-1',
    sequence: sequence++,
    phase: 'commit',
    input_sequence: 0,
    applied_through_input_sequence: 0,
    applied_delta: 0,
    top,
    boundary: top === 0 ? 'top' : 'none',
    content_rows: contentRows,
    viewport_rows: viewportRows,
    timestamp_micros: 0,
  }];
  for (const [index, delta] of deltas.entries()) {
    inputSequence += 1;
    events.push({
      id: `input-${sequence}`,
      sequence: sequence++,
      phase: 'input',
      input_sequence: inputSequence,
      applied_through_input_sequence: inputSequence - 1,
      applied_delta: delta,
      minimum_progress_rows: 3,
      direction: delta < 0 ? 'up' : 'down',
      top,
      boundary: top === 0 ? 'top' : 'none',
      timestamp_micros: index * 1_000_000 + 100_000,
    });
    top = Math.max(0, Math.min(contentRows - viewportRows, top + delta));
    events.push({
      id: `commit-${sequence}`,
      sequence: sequence++,
      phase: 'commit',
      input_sequence: inputSequence,
      applied_through_input_sequence: inputSequence,
      applied_delta: delta,
      direction: delta < 0 ? 'up' : 'down',
      top,
      boundary: top === 0 ? 'top' : top === contentRows - viewportRows ? 'bottom' : 'none',
      content_rows: contentRows,
      viewport_rows: viewportRows,
      timestamp_micros: index * 1_000_000 + 200_000,
    });
  }
  return events;
}

test('recognizes wrapped terminal evidence and ordered history markers', () => {
  assert.equal(textContainsAcrossWrap('final senti\nnel', 'final sentinel'), true);
  assert.equal(
    textHasEarlyToolHistory('Starting tool execution\nline-001\nread x1 · grep x1 · TodoWrite x1 · bash x1'),
    true,
  );
  assert.deepEqual(firstVisibleHistoryMarker('tui-lab-tool-line-042\ntui-lab-tool-line-099'), {
    kind: 'tool',
    line: 42,
    score: 42,
  });
});

test('recognizes the complete wrapped user message beside the committed scrollbar', () => {
  const message = 'Run the complete KCoder TUI automation scenario with user input, model thinking, tool calls, tool results, long counted output, and a final response.';
  const screen = ' › Run the complete KCoder TUI automation scenario with user input, model thinking, tool calls, tool results, long  ┃\n'
    + '   counted output, and a final response.                                                                           │';
  assert.equal(textContainsAcrossWrap(screen, message), true);
  assert.equal(textContainsAcrossWrap(screen.replace('tool results, ', ''), message), false);
  assert.equal(textContainsAcrossWrap('user │ content', 'user content'), false);
  assert.equal(textContainsAcrossWrap('literal trailing glyph │', 'literal trailing glyph │'), true);
});

test('summarizes right-edge scrollbar cells and numeric sample ranges', () => {
  const stats = terminalRightEdgeScrollbarStats('alpha ┃\nbeta  │\ngamma █');
  assert.equal(stats.trackRows, 3);
  assert.equal(stats.thumbRows, 2);
  assert.deepEqual(stats.thumbRuns, [1, 1]);
  assert.equal(numericRange([8, 3, 11]), 8);
  assert.equal(numericRange([]), 0);
});

function sustainedFixture(boundarySecond) {
  let top = 500;
  return Array.from({ length: 10 }, (_, index) => {
    const second = index + 1;
    const direction = second === boundarySecond ? -1 : second < 6 ? -1 : 1;
    const topBefore = top;
    if (second !== boundarySecond) top += direction * 100;
    return {
      atMs: index * 1000 + 500,
      sent: second * 8,
      observed: second * 8,
      committed: second * 8,
      direction,
      topBefore,
      topAfter: top,
      boundaryAfter: second === boundarySecond ? 'top' : 'none',
    };
  });
}

test('summarizes the same real movement identically when a boundary lands in second 3 or 6', () => {
  const third = summarizeSustainedSamples(sustainedFixture(3));
  const sixth = summarizeSustainedSamples(sustainedFixture(6));
  assert.equal(third.earlyRowsPerSecond, sixth.earlyRowsPerSecond);
  assert.equal(third.lateRowsPerSecond, sixth.lateRowsPerSecond);
  assert.equal(third.stalledLateSeconds, 0);
  assert.equal(sixth.stalledLateSeconds, 0);
});

test('distinguishes a true non-boundary stall from legitimate boundary dwell', () => {
  const stalled = sustainedFixture(3);
  stalled[6] = { ...stalled[6], topAfter: stalled[6].topBefore, boundaryAfter: 'none' };
  const stalledSummary = summarizeSustainedSamples(stalled);
  assert.equal(stalledSummary.stalledLateSeconds, 1);
  assert.deepEqual(stalledSummary.staleObservationSeconds, [7]);

  const boundary = summarizeSustainedSamples(sustainedFixture(6));
  assert.equal(boundary.seconds[5].boundaryDwell, true);
  assert.equal(boundary.seconds[5].stalled, false);
});

test('reports input delivery, render commit, and stale observation as separate assertions', () => {
  const result = runAssertions({
    text: '',
    ptyLog: '',
    hasScrollbar: false,
    trace: [],
    mode: 'single',
    scenario: 'full-turn',
    message: '',
    sustainedWheelScroll: {
      inputDeliveryOk: false,
      commitObserved: true,
      observationFresh: false,
      sentTotal: 8,
      observedTotal: 0,
      committedTotal: 2,
      inputNotDeliveredSeconds: [7],
      inputNotCommittedSeconds: [],
      staleObservationSeconds: [8],
      longestNonBoundaryStall: 2,
      progressRequirementMet: false,
      lateRowsPerSecond: 0,
      lateToEarlyRatio: 0,
      stalledLateSeconds: 2,
    },
  });
  const checks = Object.fromEntries(result.checks.map((check) => [check.name, check]));
  assert.equal(checks['sustained-wheel-input-reaches-tui'].ok, false);
  assert.equal(checks['sustained-wheel-input-produces-render-commits'].ok, true);
  assert.equal(checks['sustained-wheel-viewport-observation-is-fresh'].ok, false);
  assert.equal(checks['sustained-wheel-progress-per-effective-input'].ok, false);
  assert.equal(checks['sustained-wheel-scroll-does-not-stall-after-5s'].ok, false);
});

test('sequence aggregation gives low and accelerated high frequency the same minimum progress contract', () => {
  const low = summarizeViewportSequenceEvents(viewportEvents([-3, -3, -3, -3]));
  const highFrequency = viewportEvents([], { startTop: 120 });
  highFrequency.push(
    { sequence: 2, phase: 'input', input_sequence: 1, applied_delta: -3, minimum_progress_rows: 3, direction: 'up', top: 120, boundary: 'none', timestamp_micros: 100_000 },
    { sequence: 3, phase: 'input', input_sequence: 2, applied_delta: -6, minimum_progress_rows: 3, direction: 'up', top: 120, boundary: 'none', timestamp_micros: 110_000 },
    { sequence: 4, phase: 'input', input_sequence: 3, applied_delta: -24, minimum_progress_rows: 3, direction: 'up', top: 120, boundary: 'none', timestamp_micros: 120_000 },
    { sequence: 5, phase: 'commit', input_sequence: 3, applied_through_input_sequence: 3, applied_delta: -33, direction: 'up', top: 87, boundary: 'none', timestamp_micros: 200_000 },
  );
  const accelerated = summarizeViewportSequenceEvents(highFrequency);
  assert.equal(low.progressPerEffectiveInput, 3);
  assert.equal(low.progressRequirementMet, true);
  assert.ok(accelerated.progressPerEffectiveInput > low.progressPerEffectiveInput);
  assert.equal(accelerated.progressRequirementMet, true);
});

test('sequence aggregation excludes outward boundary input and handles a batched reversal', () => {
  const boundary = viewportEvents([-3, 3], { startTop: 0 });
  const boundarySummary = summarizeViewportSequenceEvents(boundary);
  assert.equal(boundarySummary.excludedOutwardInputs, 1);
  assert.equal(boundarySummary.effectiveInputs, 1);
  assert.equal(boundarySummary.progressPerEffectiveInput, 3);

  const batched = viewportEvents([], { startTop: 50 });
  batched.push(
    { sequence: 2, phase: 'input', input_sequence: 1, applied_delta: -3, minimum_progress_rows: 3, direction: 'up', top: 50, boundary: 'none', timestamp_micros: 100_000 },
    { sequence: 3, phase: 'input', input_sequence: 2, applied_delta: 3, minimum_progress_rows: 3, direction: 'down', top: 50, boundary: 'none', timestamp_micros: 120_000 },
    { sequence: 4, phase: 'commit', input_sequence: 2, applied_through_input_sequence: 2, applied_delta: 0, top: 50, boundary: 'none', timestamp_micros: 200_000 },
  );
  const batchSummary = summarizeViewportSequenceEvents(batched);
  assert.equal(batchSummary.effectiveInputs, 0);
  assert.equal(batchSummary.staleObservationSeconds.length, 0);
});

function cappedWheelFixture({ stalled = false, reversed = false } = {}) {
  const events = viewportEvents([], { startTop: 120 });
  for (let index = 1; index <= 40; index += 1) {
    events.push({ sequence: index + 1, phase: 'input', input_sequence: index,
      requested_delta: -3, accepted_delta: index <= 2 ? -3 : 0,
      applied_delta: index <= 2 ? -3 : 0, coalesced_delta: index <= 2 ? 0 : -3,
      cancelled_pending_delta: 0, minimum_progress_rows: 3, direction: 'up',
      top: 120, boundary: 'none', timestamp_micros: index * 1_000 });
  }
  if (reversed) events.push({ sequence: 42, phase: 'input', input_sequence: 41,
    requested_delta: 3, accepted_delta: 3, applied_delta: 3, coalesced_delta: 0,
    cancelled_pending_delta: -6, minimum_progress_rows: 3, direction: 'down',
    top: 120, boundary: 'none', timestamp_micros: 50_000 });
  events.push({ sequence: 43, phase: 'commit', applied_through_input_sequence: reversed ? 41 : 40,
    applied_delta: reversed ? 3 : -6, top: stalled ? 120 : reversed ? 123 : 114,
    boundary: 'none', timestamp_micros: 100_000 });
  return events;
}

test('counts capped inputs separately without relaxing progress for accepted input', () => {
  const summary = summarizeViewportSequenceEvents(cappedWheelFixture());
  assert.equal(summary.coalescedInputs, 38);
  assert.equal(summary.effectiveInputs, 2);
  assert.equal(summary.progressRows, 6);
  assert.equal(summary.progressRequirementMet, true);
  const stalled = summarizeViewportSequenceEvents(cappedWheelFixture({ stalled: true }));
  assert.equal(stalled.progressRequirementMet, false);
  assert.deepEqual(stalled.staleObservationSeconds, [1]);
});

test('a reversed replacement cancels the old pending burst, not the new accepted input', () => {
  const summary = summarizeViewportSequenceEvents(cappedWheelFixture({ reversed: true }));
  assert.equal(summary.effectiveInputs, 1);
  assert.deepEqual(summary.groups[0].effectiveInputSequences, [41]);
  assert.equal(summary.progressRows, 3);
  assert.equal(summary.progressRequirementMet, true);
});

test('reports a boundary-truncated accepted tick separately from full progress input', () => {
  const summary = summarizeViewportSequenceEvents(viewportEvents([-3, -3, -3], { startTop: 4 }));
  assert.equal(summary.boundaryTruncatedInputs, 1);
  assert.equal(summary.excludedOutwardInputs, 1);
  assert.equal(summary.effectiveInputs, 1);
  assert.equal(summary.progressRequirementMet, true);
});

test('a boundary-truncated tick must still perform its reachable movement', () => {
  const events = viewportEvents([-3, -3], { startTop: 4 });
  events.at(-1).top = 1;
  events.at(-1).boundary = 'none';
  const summary = summarizeViewportSequenceEvents(events);
  assert.equal(summary.boundaryTruncatedInputs, 1);
  assert.equal(summary.progressRequirementMet, false);
  assert.deepEqual(summary.staleObservationSeconds, [2]);
});

test('accelerated progress cannot hide a later accepted input with no movement', () => {
  const events = viewportEvents([-30, -3]);
  events.at(-1).top = 90;
  const summary = summarizeViewportSequenceEvents(events);
  assert.ok(summary.progressPerEffectiveInput > 3);
  assert.equal(summary.progressRequirementMet, false);
  assert.deepEqual(summary.staleObservationSeconds, [2]);
});

test('sequence aggregation is invariant when the same boundary dwell lands early or late', () => {
  const early = summarizeViewportSequenceEvents(viewportEvents([-30, -30, -60, 3, 3, 3], { startTop: 60 }));
  const late = summarizeViewportSequenceEvents(viewportEvents([-3, -3, -3, -30, -30, -51, -3], { startTop: 120 }));
  assert.equal(early.longestNonBoundaryStall, 0);
  assert.equal(late.longestNonBoundaryStall, 0);
  assert.ok(early.excludedOutwardInputs > 0);
  assert.ok(late.excludedOutwardInputs > 0);
  assert.equal(early.progressRequirementMet, true);
  assert.equal(late.progressRequirementMet, true);
});


test('scrollbar range uses logical resolved rows while preserving physical offsets', () => {
  const top = { boundary:'top', top:0, resolved_top:0 };
  const bottom = { boundary:'bottom', top:135, visible_top:135, resolved_top:133, content_rows:163, viewport_rows:30 };
  const range = summarizeScrollbarRange(top, bottom);
  assert.equal(range.returnedToTail, true);
  assert.equal(range.bottom, 133);
  assert.equal(range.visibleBottom, 135);
  assert.equal(range.coverageRatio, 1);
  assert.equal(summarizeScrollbarRange(top, { ...bottom, resolved_top:128 }).returnedToTail, false);
});
