import { agentMessageReceiptQuery, validAgentMessageReceiptQuery, validAgentMessageReceiptList } from '../shared/agentMessageMethods.mjs';
import { requireRouter, requireRouterReceipt } from './agent-message-router-private.js';

const MAX_BYTES = 112 * 1024;
const MAX_CHECKS = 256;
const MAX_PAGES = 32;
const ownKeys = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const cursor = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\p{Cc}]/u.test(value);
const milliseconds = value => Number.isSafeInteger(value) && value >= 0;
const pageBytes = value => Buffer.byteLength(JSON.stringify(value));

/** Each page reads the original Source facts, then refreshes exact destinations.
 * Cursors retain only a position/filter binding, never a receipt or allow verdict.
 */
export async function listAgentMessageReceipts({ query: input, fetchPage, refresh, verify, validateOperation, now = Date.now, timeBudgetMs = 15_000 }) {
  requireRouter(validAgentMessageReceiptQuery(input), 'AGENT_MESSAGES_INVALID_REQUEST');
  const query = Object.freeze(agentMessageReceiptQuery(input));
  const limit = query.limit ?? 10;
  const filtered = ['status', 'createdAfterMs', 'createdBeforeMs'].some(key => query[key] != null);
  const items = [];
  const until = now() + timeBudgetMs;
  const observed = new Set();
  const visited = new Set([query.cursor ?? '']);
  let nextCursor = query.cursor, unconfirmedCount = 0, checked = 0;
  const countUnknown = amount => {
    requireRouter(Number.isSafeInteger(amount) && amount >= 0 && unconfirmedCount + amount <= 0xffffffff);
    unconfirmedCount += amount;
  };
  const result = more => ({ items, ...(more ? { nextCursor: more } : {}), unconfirmedCount });
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    await verify();
    const page = await fetchPage({ ...query, limit, ...(nextCursor ? { cursor: nextCursor } : {}) });
    await verify();
    requireRouter(ownKeys(page, ['items', 'unconfirmedCount'], ['nextCursor']) && Array.isArray(page.items) &&
      page.items.length <= 256 && (page.nextCursor == null || cursor(page.nextCursor)) && pageBytes(page) <= MAX_BYTES);
    countUnknown(page.unconfirmedCount);
    const positions = new Set();
    for (const candidate of page.items) {
      requireRouter(ownKeys(candidate, ['operation', 'cursor']) && cursor(candidate.cursor) &&
        candidate.cursor !== nextCursor && !positions.has(candidate.cursor));
      positions.add(candidate.cursor);
      validateOperation(candidate.operation);
      requireRouter(!observed.has(candidate.operation.operationId), 'AGENT_MESSAGES_RECEIPTS_DUPLICATE_OPERATION');
      observed.add(candidate.operation.operationId);
    }
    for (let index = 0; index < page.items.length; index++) {
      const candidate = page.items[index], operation = candidate.operation, claims = operation.attestation.claims;
      requireRouter(query.targetThreadId == null || operation.destination.threadId === query.targetThreadId,
        'AGENT_MESSAGES_RECEIPTS_SCOPE_MISMATCH');
      let row = { clientMessageId: claims.clientMessageId, targetAddress: { ...operation.destination }, mode: claims.mode,
        confirmation: 'unconfirmed', reasonCode: 'original_not_dispatched' };
      if (operation.stage !== 'prepared') {
        let details;
        try { details = await refresh(operation); }
        catch (error) {
          await verify();
          row.reasonCode = error?.message === 'AGENT_MESSAGES_RECEIPTS_UNSUPPORTED' ? 'receipts_unsupported' : 'receipt_query_unconfirmed';
        }
        await verify();
        if (details !== undefined) {
          requireRouter(ownKeys(details, ['receipt'], ['createdAtMs', 'expiresAtMs']) &&
            ['createdAtMs', 'expiresAtMs'].every(key => details[key] == null || milliseconds(details[key])) &&
            (details.createdAtMs == null || details.expiresAtMs == null || details.expiresAtMs >= details.createdAtMs) &&
            (details.receipt !== null || ['createdAtMs', 'expiresAtMs'].every(key => !Object.hasOwn(details, key))));
          const times = Object.fromEntries(['createdAtMs', 'expiresAtMs'].filter(key => details[key] != null).map(key => [key, details[key]]));
          if (details.receipt === null) row = { ...row, ...times, confirmation: 'missing', reasonCode: 'original_receipt_missing' };
          else {
            requireRouterReceipt(details.receipt, operation);
            row = { clientMessageId: claims.clientMessageId, targetAddress: { ...operation.destination }, mode: claims.mode,
              confirmation: 'confirmed', receipt: details.receipt, ...times,
              ...(details.receipt.reasonCode == null ? {} : { reasonCode: details.receipt.reasonCode }) };
          }
        }
      }
      const timeUnknown = row.confirmation === 'confirmed' &&
        (query.createdAfterMs != null || query.createdBeforeMs != null) && row.createdAtMs == null;
      const include = (!filtered || row.confirmation === 'confirmed' && !timeUnknown) &&
        (query.status == null || row.receipt?.status === query.status) &&
        (query.createdAfterMs == null || row.createdAtMs >= query.createdAfterMs) &&
        (query.createdBeforeMs == null || row.createdAtMs < query.createdBeforeMs);
      const unknown = row.confirmation === 'unconfirmed' || timeUnknown;
      if (include) {
        const proposed = { items: [...items, row], nextCursor: candidate.cursor,
          unconfirmedCount: unconfirmedCount + (unknown ? 1 : 0) };
        if (pageBytes(proposed) > MAX_BYTES) {
          requireRouter(items.length > 0, 'AGENT_MESSAGES_RECEIPTS_PAGE_TOO_LARGE');
          const final = result(nextCursor); requireRouter(validAgentMessageReceiptList(final)); return final;
        }
        items.push(row);
      }
      if (unknown) countUnknown(1);
      nextCursor = candidate.cursor; checked++;
      const more = index + 1 < page.items.length ? candidate.cursor : page.nextCursor;
      if (items.length >= limit || checked >= MAX_CHECKS || now() >= until) {
        const final = result(more); requireRouter(validAgentMessageReceiptList(final)); return final;
      }
    }
    nextCursor = page.nextCursor;
    if (!nextCursor) {
      const final = result(); requireRouter(validAgentMessageReceiptList(final)); return final;
    }
    requireRouter(!visited.has(nextCursor), 'AGENT_MESSAGES_CURSOR_INVALID');
    visited.add(nextCursor);
    if (now() >= until) {
      const final = result(nextCursor); requireRouter(validAgentMessageReceiptList(final)); return final;
    }
  }
  const final = result(nextCursor); requireRouter(validAgentMessageReceiptList(final)); return final;
}
