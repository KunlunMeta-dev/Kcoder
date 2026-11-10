const integer = (value, fallback, min, max, label) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw Error(`UNMET_PREREQUISITE: invalid office ${label} budget`);
  return parsed;
};
const price = (value, label) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1000) throw Error(`UNMET_PREREQUISITE: supply explicit office ${label} USD-per-million estimate`);
  return parsed;
};

/** Pricing is caller-provided protected metadata, never an inferred current model price. */
export function officeBudget(env = process.env) {
  const outputTokens = integer(env.KCODER_E2E_MODEL_MAX_TOKENS, 4096, 512, 8192, 'output tokens');
  const caseWallMs = integer(env.KCODER_E2E_MODEL_TIMEOUT_SECS, 180, 30, 300, 'case seconds') * 1000;
  const maxUsd = Number(env.KCODER_E2E_OFFICE_MAX_USD ?? 2);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 20) throw Error('UNMET_PREREQUISITE: office estimated cost cap must be in (0,20] USD');
  return Object.freeze({ caseCount: 4, requestsPerCase: 8, maxRequests: 32, outputTokens,
    maxInputBytes: 96 * 1024, caseWallMs, suiteWallMs: caseWallMs * 4 + 60_000,
    providerRetries: 0, requestTimeoutMs: Math.min(90_000, caseWallMs), maxUsd,
    inputUsdPerMillion: price(env.KCODER_E2E_OFFICE_INPUT_USD_PER_MILLION, 'input'),
    outputUsdPerMillion: price(env.KCODER_E2E_OFFICE_OUTPUT_USD_PER_MILLION, 'output'),
  });
}

export function officeBudgetMeter(budget, expectedModel, clock = Date.now) {
  const started = clock();
  let activeCase = null, caseStarted = null, caseRequests = 0, requests = 0, reservedUsd = 0;
  return {
    beginCase(id) { activeCase = id; caseStarted = clock(); caseRequests = 0; },
    admit(metadata) {
      if (!activeCase || clock() - started > budget.suiteWallMs || clock() - caseStarted > budget.caseWallMs)
        throw Error('Office live request exceeds its owned case/wall budget');
      if (requests >= budget.maxRequests || caseRequests >= budget.requestsPerCase)
        throw Error('Office live request count budget exceeded');
      if (metadata.model !== expectedModel || metadata.bodyBytes > budget.maxInputBytes ||
        !Number.isSafeInteger(metadata.outputTokenLimit) || metadata.outputTokenLimit <= 0 || metadata.outputTokenLimit > budget.outputTokens)
        throw Error('Office live request model/input/output budget mismatch');
      // UTF-8 bytes plus framing reserve is deliberately conservative; actual usage is reported separately.
      const cost = ((metadata.bodyBytes + 4096) * budget.inputUsdPerMillion + metadata.outputTokenLimit * budget.outputUsdPerMillion) / 1_000_000;
      if (reservedUsd + cost > budget.maxUsd) throw Error('Office live estimated-cost budget exceeded before dispatch');
      requests++; caseRequests++; reservedUsd += cost;
      return { caseId: activeCase, requestNumber: requests, reservedEstimatedUsd: reservedUsd };
    },
    snapshot() { return { requests, caseRequests, reservedEstimatedUsd: reservedUsd, elapsedMs: clock() - started }; },
  };
}
