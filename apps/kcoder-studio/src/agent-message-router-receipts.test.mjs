import test from 'node:test';
import assert from 'node:assert/strict';
import { listAgentMessageReceipts } from './agent-message-router-receipts.js';
import { validAgentMessageReceiptList, validAgentMessageReceiptQuery } from '../shared/agentMessageMethods.mjs';
const sourceAddress = { targetId: 'a', workspaceId: 's', threadId: 's' };
const destination = { targetId: 'a', workspaceId: 't', threadId: 't' };
function operation(index, overrides = {}) {
  const clientMessageId = 'c' + index;
  return { operationId: 'o' + index, sourceAddress, destination, stage: 'receipted',
    attestation: { claims: { clientMessageId, mode: 'enqueue_only' } },
    receipt: { messageId: 'm' + index, clientMessageId, targetThreadId: destination.threadId,
      status: 'queued', revision: 1, sourceAddress, targetAddress: destination }, ...overrides };
}
function fixture(operations, details, extra = {}) {
  const calls = []; let allowed = true;
  const verify = () => { if (!allowed) throw Error('OWNED_SOURCE_REVOKED'); };
  const listing = query => listAgentMessageReceipts({ query, verify,
    validateOperation: value => { assert.deepEqual(value.sourceAddress, sourceAddress); },
    fetchPage: async request => {
      calls.push(request);
      const offset = request.cursor ? Number(request.cursor.slice(1)) : 0;
      const rows = operations.slice(offset, offset + 16);
      return { items: rows.map((value, index) => ({ operation: value, cursor: 'p' + (offset + index + 1) })),
        ...(offset + rows.length < operations.length ? { nextCursor: 'p' + (offset + rows.length) } : {}), unconfirmedCount: 0 };
    }, refresh: details, ...extra });
  return { listing, calls, revoke() { allowed = false; } };
}

test('outgoing status/time selection refreshes original destinations and never treats cached queued as current', async () => {
  const ops = Array.from({ length: 4 }, (_, index) => operation(index));
  const times = [100, 199, 200, 150];
  const f = fixture(ops, async op => ({ receipt: { ...op.receipt, status: op.operationId === 'o3' ? 'queued' : 'applied', revision: 2 }, createdAtMs: times[Number(op.operationId.slice(1))], expiresAtMs: 1000 }));
  const result = await f.listing({ status: 'applied', targetThreadId: 't', createdAfterMs: 100, createdBeforeMs: 200, limit: 256 });
  assert.deepEqual(result.items.map(row => row.clientMessageId), ['c0', 'c1']);
  assert.equal(result.unconfirmedCount, 0); assert.equal(ops[0].receipt.status, 'queued');
  assert.equal(result.items[0].receipt.status, 'applied'); assert.equal(validAgentMessageReceiptList(result, 's'), true);
  assert.equal(validAgentMessageReceiptList(result, 'foreign'), false);
});

test('a confirmed missing receipt and an unconfirmed destination never fall back to source cache', async () => {
  const ops = [operation(0), operation(1), operation(2, { stage: 'prepared' })];
  const f = fixture(ops, async op => { if (op.operationId === 'o0') return { receipt: null }; throw Error('OWNED_DESTINATION_OFFLINE'); });
  const result = await f.listing({});
  assert.deepEqual(result.items.map(row => row.confirmation), ['missing', 'unconfirmed', 'unconfirmed']);
  assert.equal(result.unconfirmedCount, 2); assert.ok(result.items.every(row => !Object.hasOwn(row, 'receipt')));
  const filtered = await f.listing({ status: 'queued', createdAfterMs: 0 });
  assert.equal(filtered.items.length, 0); assert.equal(filtered.unconfirmedCount, 2);
  const invalid = fixture([operation(0)], async () => ({ receipt: null, createdAtMs: 10 }));
  await assert.rejects(invalid.listing({}), /INVALID_NATIVE_RESPONSE/);
});

test('256 small outgoing rows fit one requested page without shrinking the caller limit to ten', async () => {
  const ops = Array.from({ length: 256 }, (_, i) => operation(i));
  const f = fixture(ops, async op => ({ receipt: { ...op.receipt, status: 'applied' } }));
  const result = await f.listing({ limit: 256 });
  assert.equal(result.items.length, 256); assert.equal(result.nextCursor, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 112 * 1024);
  assert.ok(f.calls.every(query => query.limit === 256));
});

test('byte-limited pages resume after the last consumed candidate and allow a different next-page limit', async () => {
  const ops = Array.from({ length: 90 }, (_, i) => operation(i, { sourceAddress: { ...sourceAddress, targetId: 's'.repeat(250), workspaceId: 'u'.repeat(250) },
    destination: { ...destination, targetId: 'd'.repeat(250), workspaceId: 'w'.repeat(250) } }));
  for (const op of ops) op.receipt = { ...op.receipt, sourceAddress: op.sourceAddress, targetAddress: op.destination };
  const f = fixture(ops, async op => ({ receipt: op.receipt }), { validateOperation() {} });
  const first = await f.listing({ limit: 256, targetThreadId: 't' });
  assert.ok(first.items.length > 0 && first.items.length < 90); assert.ok(first.nextCursor);
  const second = await f.listing({ cursor: first.nextCursor, limit: 1, targetThreadId: 't' });
  assert.equal(second.items[0].clientMessageId, 'c' + first.items.length);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 112 * 1024);
});

test('soft time bounds stop after the current destination and also bound empty advancing Source pages', async () => {
  let now = 0; const ops = Array.from({ length: 9 }, (_, i) => operation(i));
  const f = fixture(ops, async op => { now += 8000; return { receipt: op.receipt }; }, { now: () => now });
  const first = await f.listing({ limit: 256, status: 'queued' });
  assert.equal(first.items.length, 2); assert.equal(first.nextCursor, 'p2');
  now = 0; let pages = 0;
  const empty = await listAgentMessageReceipts({ query: {}, now: () => now,
    verify() {}, validateOperation() {}, refresh: () => assert.fail('no candidate exists'),
    fetchPage: async () => { pages++; now += 8000; return { items: [], nextCursor: 'p' + pages, unconfirmedCount: 1 }; } });
  assert.equal(pages, 2); assert.equal(empty.nextCursor, 'p2'); assert.equal(empty.unconfirmedCount, 2);
});

test('current Source revocation and foreign source operations reject the page rather than publish earlier observations', async () => {
  let f; f = fixture([operation(0)], async op => { f.revoke(); return { receipt: op.receipt }; });
  await assert.rejects(f.listing({}), /SOURCE_REVOKED/);
  let refresh = 0;
  const foreign = fixture([operation(0, { sourceAddress: { ...sourceAddress, threadId: 'foreign' } })], async () => { refresh++; });
  await assert.rejects(foreign.listing({})); assert.equal(refresh, 0);
});

test('flat outgoing filters reject unsafe times, statuses, unknown fields and invalid row projections', () => {
  assert.equal(validAgentMessageReceiptQuery({ targetThreadId: 't', status: 'unknown', createdAfterMs: 0, createdBeforeMs: 1, limit: 256 }), true);
  for (const query of [{ limit: 0 }, { limit: 257 }, { status: 'sent' }, { createdAfterMs: -1 }, { createdBeforeMs: Number.MAX_SAFE_INTEGER + 1 }, { createdAfterMs: 2, createdBeforeMs: 1 }, { createdAfterMs: 1, createdBeforeMs: 1 }, { sourceThreadId: 'foreign' }])
    assert.equal(validAgentMessageReceiptQuery(query), false);
  const row = { clientMessageId: 'c', targetAddress: destination, mode: 'enqueue_only', confirmation: 'missing' };
  assert.equal(validAgentMessageReceiptList({ items: [row], unconfirmedCount: 0 }), true);
  assert.equal(validAgentMessageReceiptList({ items: [{ ...row, receipt: null }], unconfirmedCount: 0 }), false);
  assert.equal(validAgentMessageReceiptList({ items: [{ ...row, createdAtMs: 1 }], unconfirmedCount: 0 }), false);
});
