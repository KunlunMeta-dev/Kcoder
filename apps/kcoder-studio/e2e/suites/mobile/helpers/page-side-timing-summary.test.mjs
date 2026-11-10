import assert from "node:assert/strict";
import test from "node:test";
import { summarizePageSideTimingSamples } from "./page-side-timing-summary.mjs";

const TIME_DOMAIN = "DOMHighResTimeStamp relative to performance.timeOrigin";

function sendSample(value, overrides = {}) {
  const messageFingerprint = "message-fingerprint";
  return {
    pageSideTiming: {
      sendFeedback: {
        messageFingerprint,
        inputEvent: {
          isTrusted: true,
          eventType: "pointerdown",
          targetMatched: true,
          messageMatched: true,
          timeStampDomain: TIME_DOMAIN,
          timeStampDomainValid: true,
          timeOriginEpochMs: 1_000,
          eventTimeStampMs: 10,
          eventEpochMs: 1_010,
        },
        firstFeedback: {
          kind: "pending-submission-content",
          visible: true,
          exactMessageIdentity: true,
          messageFingerprint,
          epochMs: 1_010 + value,
        },
        stableTwoRaf: {
          complete: true,
          exactMessageIdentityAtBothFrames: true,
          messageFingerprint,
          kind: "pending-submission-content",
        },
        timingsMs: {
          trustedPointerdownToFirstVisibleFeedback: value,
          trustedPointerdownToStableTwoRaf: value + 2,
        },
        ...overrides,
      },
    },
  };
}

function backgroundSample(value, overrides = {}) {
  const hiddenEvent = {
    isTrusted: true,
    visibilityState: "hidden",
    timeStampDomain: TIME_DOMAIN,
    timeStampDomainValid: true,
    timeOriginEpochMs: 1_000,
    eventTimeStampMs: 10,
    eventEpochMs: 1_010,
  };
  const activeEvent = {
    isTrusted: true,
    visibilityState: "visible",
    timeStampDomain: TIME_DOMAIN,
    timeStampDomainValid: true,
    timeOriginEpochMs: 1_000,
    eventTimeStampMs: 20,
    eventEpochMs: 1_020,
  };
  return {
    pageSideTiming: {
      backgroundRetention: {
        hiddenEvent,
        activeEvent,
        helperTraceCrossCheck: {
          status: "MATCHED",
          active: "MATCHED",
          hidden: "MATCHED",
          activeEventEpochMs: activeEvent.eventEpochMs,
          hiddenEventEpochMs: hiddenEvent.eventEpochMs,
        },
        stableTwoRaf: {
          complete: true,
          exactRetainedContentAtBothFrames: true,
          firstFrame: { visible: true, exactContentMatch: true },
          secondFrame: { visible: true, exactContentMatch: true },
        },
        timingsMs: {
          trustedVisibleEventToFirstVisibleFrame: value,
          trustedVisibleEventToStableTwoRaf: value + 2,
        },
        ...overrides,
      },
    },
  };
}

test("empty page-clock input stays explicitly incomplete with null distributions", () => {
  const summary = summarizePageSideTimingSamples([], "send");
  assert.equal(summary.clockDomain.status, "INSUFFICIENT_VALID_PAGE_CLOCKS");
  assert.deepEqual(summary.clockDomain, {
    validSamples: 0,
    missingSamples: 0,
    invalidSamples: 0,
    status: "INSUFFICIENT_VALID_PAGE_CLOCKS",
  });
  assert.equal(summary.firstVisible.p50Ms, null);
  assert.equal(summary.firstVisible.p95Ms, null);
  assert.equal(summary.firstVisible.maxMs, null);
  assert.equal(summary.stableTwoFrames.percentileEligible, false);
});

test("a timestamp outside the page high-resolution clock domain cannot contribute a reported duration", () => {
  const summary = summarizePageSideTimingSamples([
    sendSample(1, { inputEvent: { ...sendSample(1).pageSideTiming.sendFeedback.inputEvent, timeStampDomainValid: false } }),
  ], "send");

  assert.equal(summary.clockDomain.invalidSamples, 1);
  assert.equal(summary.clockDomain.validSamples, 0);
  assert.equal(summary.firstVisible.invalidSamples, 1);
  assert.equal(summary.firstVisible.p50Ms, null);
  assert.equal(summary.stableTwoFrames.maxMs, null);
});

test("29 valid observations do not produce N30 percentiles or a misleading maximum", () => {
  const summary = summarizePageSideTimingSamples(Array.from({ length: 29 }, (_, index) => sendSample(index + 1)), "send");

  assert.equal(summary.sampleCount, 29);
  assert.equal(summary.clockDomain.validSamples, 29);
  assert.equal(summary.firstVisible.validSamples, 29);
  assert.equal(summary.firstVisible.status, "INSUFFICIENT_VALID_PAGE_CLOCKS");
  assert.equal(summary.firstVisible.p50Ms, null);
  assert.equal(summary.firstVisible.p95Ms, null);
  assert.equal(summary.firstVisible.maxMs, null);
  assert.equal(summary.stableTwoFrames.p95Ms, null);
});

test("30 exact trusted feedback samples produce nearest-rank p50, p95, and max", () => {
  const summary = summarizePageSideTimingSamples(Array.from({ length: 30 }, (_, index) => sendSample(index + 1)), "send");

  assert.equal(summary.clockDomain.status, "N30_VALID");
  assert.equal(summary.firstVisible.status, "N30_VALID");
  assert.equal(summary.firstVisible.p50Ms, 15);
  assert.equal(summary.firstVisible.p95Ms, 29);
  assert.equal(summary.firstVisible.maxMs, 30);
  assert.equal(summary.stableTwoFrames.p50Ms, 17);
  assert.equal(summary.stableTwoFrames.p95Ms, 31);
  assert.equal(summary.stableTwoFrames.maxMs, 32);
});

test("background measurements require matched hidden-to-visible helper epochs and exact content in both frames", () => {
  const samples = Array.from({ length: 30 }, (_, index) => backgroundSample(index + 1));
  samples[0].pageSideTiming.backgroundRetention.helperTraceCrossCheck.activeEventEpochMs += 1;
  const summary = summarizePageSideTimingSamples(samples, "background");

  assert.equal(summary.clockDomain.invalidSamples, 1);
  assert.equal(summary.clockDomain.validSamples, 29);
  assert.equal(summary.firstVisible.validSamples, 29);
  assert.equal(summary.firstVisible.p50Ms, null);
  assert.equal(summary.stableTwoFrames.validSamples, 29);
  assert.equal(summary.stableTwoFrames.p95Ms, null);
});

test("legacy target identity flag cannot substitute for the two-frame retained-content proof", () => {
  const samples = Array.from({ length: 30 }, (_, index) => backgroundSample(index + 1));
  for (const sample of samples) {
    const stable = sample.pageSideTiming.backgroundRetention.stableTwoRaf;
    delete stable.exactRetainedContentAtBothFrames;
    stable.exactTargetIdentity = true;
  }
  const summary = summarizePageSideTimingSamples(samples, "background");

  assert.equal(summary.clockDomain.validSamples, 30);
  assert.equal(summary.stableTwoFrames.invalidSamples, 30);
  assert.equal(summary.stableTwoFrames.validSamples, 0);
  assert.equal(summary.stableTwoFrames.p50Ms, null);
});
