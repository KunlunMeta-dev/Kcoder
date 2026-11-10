const DOM_HIGH_RES_TIME_DOMAIN = "DOMHighResTimeStamp relative to performance.timeOrigin";

export function summarizePageSideTimingSamples(samples, kind, requiredSamples = 30) {
  if (!Array.isArray(samples)) throw new TypeError("page timing samples must be an array");
  if (kind !== "send" && kind !== "background") throw new TypeError("page timing kind must be send or background");
  if (!Number.isInteger(requiredSamples) || requiredSamples < 1) throw new TypeError("required sample count must be a positive integer");

  const clockCounts = { validSamples: 0, missingSamples: 0, invalidSamples: 0 };
  const firstVisibleRows = [];
  const stableRows = [];

  for (const sample of samples) {
    const timing = kind === "send"
      ? sample?.pageSideTiming?.sendFeedback
      : sample?.pageSideTiming?.backgroundRetention;
    const clockStatus = classifyPageClock(timing, kind);
    clockCounts[`${clockStatus}Samples`] += 1;

    firstVisibleRows.push(classifyMetric(timing, kind, "first-visible", clockStatus));
    stableRows.push(classifyMetric(timing, kind, "stable-two-frames", clockStatus));
  }

  const clockStatus = clockCounts.validSamples >= requiredSamples ? "N30_VALID" : "INSUFFICIENT_VALID_PAGE_CLOCKS";
  return {
    schemaVersion: 1,
    kind,
    sampleCount: samples.length,
    requiredValidSamples: requiredSamples,
    clockDomain: { ...clockCounts, status: clockStatus },
    firstVisible: summarizeMetricRows(firstVisibleRows, requiredSamples),
    stableTwoFrames: summarizeMetricRows(stableRows, requiredSamples),
    businessStatusIndependent: true,
  };
}

function classifyPageClock(timing, kind) {
  if (!timing) return "missing";
  if (kind === "send") {
    const event = timing.inputEvent;
    if (!event) return "missing";
    return event.isTrusted === true
      && event.eventType === "pointerdown"
      && event.targetMatched === true
      && event.messageMatched === true
      && event.timeStampDomain === DOM_HIGH_RES_TIME_DOMAIN
      && event.timeStampDomainValid === true
      && Number.isFinite(event.timeOriginEpochMs)
      && Number.isFinite(event.eventTimeStampMs)
      && Number.isFinite(event.eventEpochMs)
      ? "valid"
      : "invalid";
  }

  const hidden = timing.hiddenEvent;
  const active = timing.activeEvent;
  if (!hidden || !active) return "missing";
  const helper = timing.helperTraceCrossCheck;
  return hidden.isTrusted === true
    && hidden.visibilityState === "hidden"
    && hidden.timeStampDomain === DOM_HIGH_RES_TIME_DOMAIN
    && hidden.timeStampDomainValid === true
    && Number.isFinite(hidden.timeOriginEpochMs)
    && Number.isFinite(hidden.eventTimeStampMs)
    && Number.isFinite(hidden.eventEpochMs)
    && active.isTrusted === true
    && active.visibilityState === "visible"
    && active.timeStampDomain === DOM_HIGH_RES_TIME_DOMAIN
    && active.timeStampDomainValid === true
    && Number.isFinite(active.timeOriginEpochMs)
    && Number.isFinite(active.eventTimeStampMs)
    && Number.isFinite(active.eventEpochMs)
    && helper?.status === "MATCHED"
    && helper.active === "MATCHED"
    && helper.hidden === "MATCHED"
    && helper.activeEventEpochMs === active.eventEpochMs
    && helper.hiddenEventEpochMs === hidden.eventEpochMs
    ? "valid"
    : "invalid";
}

function classifyMetric(timing, kind, metric, clockStatus) {
  if (clockStatus === "missing") return { status: "missing", value: null };
  if (clockStatus === "invalid") return { status: "invalid", value: null };
  if (!timing) return { status: "missing", value: null };

  const first = metric === "first-visible";
  if (kind === "send") {
    const observation = first ? timing.firstFeedback : timing.stableTwoRaf;
    if (!observation) return { status: "missing", value: null };
    const evidenceValid = first
      ? observation.visible === true
        && observation.exactMessageIdentity === true
        && observation.messageFingerprint === timing.messageFingerprint
      : observation.complete === true
        && observation.exactMessageIdentityAtBothFrames === true
        && observation.messageFingerprint === timing.messageFingerprint
        && observation.kind === timing.firstFeedback?.kind;
    const value = first
      ? timing.timingsMs?.trustedPointerdownToFirstVisibleFeedback
      : timing.timingsMs?.trustedPointerdownToStableTwoRaf;
    return metricResult(value, evidenceValid);
  }

  const observation = timing.stableTwoRaf;
  const frame = first ? observation?.firstFrame : observation?.secondFrame;
  if (!frame) return { status: "missing", value: null };
  const evidenceValid = first
    ? frame.visible === true && frame.exactContentMatch === true
    : observation.complete === true
      && observation.exactRetainedContentAtBothFrames === true
      && frame.visible === true
      && frame.exactContentMatch === true;
  const value = first
    ? timing.timingsMs?.trustedVisibleEventToFirstVisibleFrame
    : timing.timingsMs?.trustedVisibleEventToStableTwoRaf;
  return metricResult(value, evidenceValid);
}

function metricResult(value, evidenceValid) {
  if (value === null || value === undefined) return { status: "missing", value: null };
  if (!evidenceValid || !Number.isFinite(value) || value < 0) return { status: "invalid", value: null };
  return { status: "valid", value };
}

function summarizeMetricRows(rows, requiredSamples) {
  const values = [];
  let missingSamples = 0;
  let invalidSamples = 0;
  for (const row of rows) {
    if (row.status === "valid") values.push(row.value);
    else if (row.status === "missing") missingSamples += 1;
    else invalidSamples += 1;
  }
  values.sort((left, right) => left - right);
  const enoughSamples = values.length >= requiredSamples;
  return {
    sampleCount: rows.length,
    validSamples: values.length,
    missingSamples,
    invalidSamples,
    requiredValidSamples: requiredSamples,
    status: enoughSamples ? "N30_VALID" : "INSUFFICIENT_VALID_PAGE_CLOCKS",
    percentileEligible: enoughSamples,
    p50Ms: enoughSamples ? nearestRank(values, 0.5) : null,
    p95Ms: enoughSamples ? nearestRank(values, 0.95) : null,
    maxMs: enoughSamples ? values.at(-1) : null,
  };
}

function nearestRank(sortedValues, quantile) {
  if (sortedValues.length === 0) return null;
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * quantile) - 1)];
}
