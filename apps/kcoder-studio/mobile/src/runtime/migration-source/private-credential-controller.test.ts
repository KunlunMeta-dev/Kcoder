import { beforeEach, expect, it, vi } from 'vitest';
import examples from '../../../../shared/generated/examples.migration-source-credentials.json';
import { MobileMigrationClient } from '../migration-client';
import { MobilePrivateCredentialController } from './private-credential-controller';
import { TestStorage } from './test-storage';
import type { GatewayProfile } from '@/gateway/types';
import type { MigrationJobReadResult, MigrationSourceCredentialCandidatesResult, MigrationSourceCredentialSourcesResult, MigrationSourceCredentialRunParams, MigrationSourceCredentialPreparationResult } from '../../../../shared/generated/contracts';

const fake = vi.hoisted(() => ({ allowed: true, fetcher: vi.fn() }));
vi.mock('@/storage/workspace-profile-fence', () => ({ captureWorkspaceProfileIdentity: (value: any) => value.id,
  startWorkspaceProfileRpc: async (_identity: string, send: () => Promise<unknown>) => { if (!fake.allowed) throw new Error('revoked'); return { response: send() }; } }));
vi.mock('@/gateway/http', () => ({ gatewayRequest: async (_profile: unknown, path: string, init: RequestInit, limits: { beforeDispatch(): void }) => {
  await Promise.resolve(); limits.beforeDispatch(); return fake.fetcher(path, JSON.parse(String(init.body)));
} }));

const base = examples.MigrationSourceCredentialSourcesResult[0].value as MigrationSourceCredentialSourcesResult;
const candidate = examples.MigrationSourceCredentialCandidatesResult[1].value as MigrationSourceCredentialCandidatesResult;
const planId = candidate.plan!.planId, jobId = candidate.plan!.jobId;
const job: MigrationJobReadResult = { job: { jobId, sourceId: 'owned', sequence: 7, status: 'ready', totalItems: 2, committedItems: 0, requiresActionItems: 0 },
  source: 'claude-code', plans: [], issues: [], batch: { planId, selectedItems: 2, totalActions: 2, committedActions: 0, unresolvedActions: 2 } };
const page = { ...base, jobId, planId, sequence: 7 };
const profile = { id: 'owned', baseUrl: 'https://owned.invalid' } as GatewayProfile;
const target = { id: 'target', workspacePath: '/owned/target' }, source = { id: 'source', workspacePath: '/owned/source' };
const control = { sequence: 2, cancelWatermark: 0, cancelled: false, ready: true };
function received(input: { requestId: string; offerId: string }, both = false) {
  return { requestId: input.requestId, offerId: input.offerId, phase: 'received', sourceControl: both ? control : null,
    sourceObserved: both, sourceWorkerRunning: both ? false : null, targetControl: control, targetObserved: true, targetWorkerRunning: false, received: true, keyReleased: false };
}
function fixture(caps: Record<string, boolean> = {}) {
  let current = true;
  const storage = new TestStorage(), prepared = vi.fn();
  const rpc = vi.fn(async (method: string, _params: unknown) => method === 'migration/batch/credential-sources' ? page : { state: job, workerRunning: false, workerError: null, progress: null });
  const client = new MobileMigrationClient(rpc, { migrationSourceCredentialSourcesV1: true, migrationBatchV1: true,
    migrationBatchWorkersV1: true, ...caps },
  { read: async () => [], put: async () => {} }, () => current);
  fake.fetcher.mockImplementation(async (path: string, body: any) => {
    if (path.endsWith('/open')) return { status: 'ready', launching: false, ownedChildren: 1 };
    if (path.endsWith('/close')) return { status: 'released' };
    if (path.endsWith('/candidates')) return { ...candidate, entryId: body.entryId };
    if (path.endsWith('/run')) return received(body.locator, true);
    if (path.endsWith('/source-read')) return { ...received(body.locator, true), phase: 'sealed', targetObserved: false,
      targetControl: null, targetWorkerRunning: null, received: false, keyReleased: false };
    if (path.endsWith('/read')) return received(body);
    if (path.endsWith('/prepare')) return { requestId: body.locator.requestId, offerId: body.locator.offerId,
      job: { ...job, batch: { ...job.batch, planId: 'plan-prepared' } }, ...(body.additionalOffers ? { offerIds: [body.locator.offerId, ...body.additionalOffers].sort() } : {}) };
    if (path.endsWith('/cancel') || path.endsWith('/resume')) return { requestId: body.locator.requestId, offerId: body.locator.offerId,
      side: body.side, control: { sequence: 3, cancelWatermark: 1, cancelled: path.endsWith('/cancel') }, workerRunning: false };
    throw new Error('unexpected fixture request');
  });
  const create = (currentJob = job) => new MobilePrivateCredentialController({ client, job: currentJob, profile, target, scope: 'owned', storage,
    isCurrent: () => current, onPrepared: prepared });
  return { model: create(), create, storage, client, rpc, prepared, invalidate: () => { current = false; } };
}
beforeEach(() => { fake.allowed = true; fake.fetcher.mockReset(); });
async function choose(f: ReturnType<typeof fixture>) {
  await f.model.load(); f.model.select(page.items[0]); f.model.device(source); await f.model.candidates();
  f.model.choose('owned-item', { kind: 'mcp', fieldIndices: [0] });
}
const calls = (suffix: string) => fake.fetcher.mock.calls.filter(call => call[0].endsWith(suffix));
const preparation = (phase: 'pending' | 'prepared' | 'not_started' | 'unknown'): MigrationSourceCredentialPreparationResult => {
  const value = structuredClone(examples.MigrationSourceCredentialPreparationResult.find(row => row.value.phase === phase)!.value) as MigrationSourceCredentialPreparationResult;
  return { ...value, jobId, requestId: page.items[0].requestId, sequence: phase === 'prepared' ? 8 : 7,
    expectedSequence: value.expectedSequence === null ? null : 7 };
};

it('recovers a prepared original set with both local caches empty without opening a source or repeating any mutation', async () => {
  const f = fixture(), native = fake.fetcher.getMockImplementation()!;
  fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/prepare-status') ? preparation('prepared') : native(path, body));
  f.storage.clear(); await f.model.load(); f.model.select(page.items[0]); await f.model.preparationRead();
  expect(calls('/open').map(call => call[1].purpose)).toEqual(['target']);
  expect(f.model.snapshot().preparation).toEqual(preparation('prepared'));
  expect(f.model.snapshot().observed).toEqual({}); expect(f.model.snapshot().workers).toEqual({}); expect(f.model.snapshot().result).toBeNull();
  expect(f.storage.length).toBe(0); expect(f.model.snapshot().records).toEqual([]);
  await f.model.restorePreparation(true); expect(calls('/prepare')).toHaveLength(0); expect(calls('/run')).toHaveLength(0);
  expect(f.prepared).not.toHaveBeenCalled(); f.model.dispose();
});

it('confirms and rechecks the exact pending old intent before restoring it, without replacing its CAS from a batch read', async () => {
  const f = fixture(), native = fake.fetcher.getMockImplementation()!;
  fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/prepare-status') ? preparation('pending') : native(path, body));
  await f.model.load(); f.model.select(page.items[0]); await f.model.preparationRead();
  const reads = f.rpc.mock.calls.length;
  await f.model.restorePreparation(false); expect(calls('/prepare')).toHaveLength(0);
  await f.model.restorePreparation(true);
  expect(calls('/prepare-status')).toHaveLength(2); expect(calls('/prepare')).toHaveLength(1); expect(calls('/run')).toHaveLength(0);
  const sent = calls('/prepare')[0][1], original = preparation('pending');
  expect(sent).toMatchObject({ jobId, expectedSequence: original.expectedSequence, consent: original.consent,
    locator: { requestId: original.requestId, offerId: original.offerIds![0] }, additionalOffers: original.offerIds!.slice(1) });
  expect(f.rpc.mock.calls.length).toBe(reads); expect(f.storage.length).toBe(1); expect(f.prepared).toHaveBeenCalledOnce(); f.model.dispose();
});

it('never restores unknown or not-started preparation and refuses a changed original set after confirmation', async () => {
  for (const phase of ['unknown', 'not_started'] as const) {
    const f = fixture(), native = fake.fetcher.getMockImplementation()!;
    fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/prepare-status') ? preparation(phase) : native(path, body));
    await f.model.load(); f.model.select(page.items[0]); await f.model.preparationRead(); await f.model.restorePreparation(true);
    expect(calls('/prepare')).toHaveLength(0); expect(calls('/run')).toHaveLength(0); f.model.dispose(); fake.fetcher.mockReset();
  }
  const f = fixture(), native = fake.fetcher.getMockImplementation()!; let count = 0;
  fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/prepare-status')
    ? { ...preparation('pending'), ...(count++ ? { offerIds: preparation('pending').offerIds!.slice(1) } : {}) } : native(path, body));
  await f.model.load(); f.model.select(page.items[0]); await f.model.preparationRead(); await f.model.restorePreparation(true);
  expect(f.model.snapshot().error).toBe('private_credentials_policy_changed'); expect(calls('/prepare')).toHaveLength(0); f.model.dispose();
});

it('observes a peer-completed intent after confirmation without replaying preparation', async () => {
  const f = fixture(), native = fake.fetcher.getMockImplementation()!; let count = 0;
  fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/prepare-status') ? preparation(count++ ? 'prepared' : 'pending') : native(path, body));
  await f.model.load(); f.model.select(page.items[0]); await f.model.preparationRead(); await f.model.restorePreparation(true);
  expect(f.model.snapshot().preparation?.phase).toBe('prepared'); expect(calls('/prepare')).toHaveLength(0); expect(f.storage.length).toBe(0); f.model.dispose();
});

it('keeps late preparation observations out of a replaced account and closes only the owned target child', async () => {
  const f = fixture(), native = fake.fetcher.getMockImplementation()!; let finish!: (value: unknown) => void;
  fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/prepare-status') ? new Promise(resolve => { finish = resolve; }) : native(path, body));
  await f.model.load(); f.model.select(page.items[0]); const pending = f.model.preparationRead();
  await vi.waitFor(() => expect(calls('/prepare-status')).toHaveLength(1)); f.invalidate(); finish(preparation('prepared')); await pending;
  expect(f.model.snapshot().preparation).toBeNull(); expect(calls('/prepare')).toHaveLength(0); f.model.dispose();
  await vi.waitFor(() => expect(calls('/close')).toHaveLength(1)); expect(calls('/close')[0][1].purpose).toBe('target');
});

it('reads preparation during a held run without claiming side workers or losing the preparation when the old run returns', async () => {
  const f = fixture(); await choose(f); const native = fake.fetcher.getMockImplementation()!;
  let finish!: (value: unknown) => void, input!: MigrationSourceCredentialRunParams;
  fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/run') ? (input = body, new Promise(resolve => { finish = resolve; }))
    : path.endsWith('/prepare-status') ? preparation('prepared') : native(path, body));
  const running = f.model.run({ apiKeys: false, mcpPrivateFields: true });
  await vi.waitFor(() => expect(calls('/run')).toHaveLength(1));
  await f.model.preparationRead(); expect(f.model.snapshot().preparation?.phase).toBe('prepared');
  expect(f.model.snapshot().busy).toBe(true); expect(f.model.snapshot().workers).toEqual({}); expect(f.model.snapshot().result).toBeNull();
  await f.model.restorePreparation(true); expect(calls('/prepare')).toHaveLength(0);
  finish(received(input.locator, true)); await running;
  expect(f.model.snapshot().preparation?.phase).toBe('prepared'); expect(calls('/run')).toHaveLength(1); f.model.dispose();
});

it('retains a lost original restore reply and only reads an already-prepared intent on the next explicit confirmation', async () => {
  const f = fixture(), native = fake.fetcher.getMockImplementation()!; let prepared = false;
  fake.fetcher.mockImplementation(async (path: string, body: any) => {
    if (path.endsWith('/prepare-status')) return preparation(prepared ? 'prepared' : 'pending');
    if (path.endsWith('/prepare')) { prepared = true; throw new Error('lost accepted restore reply'); }
    return native(path, body);
  });
  await f.model.load(); f.model.select(page.items[0]); await f.model.preparationRead(); await f.model.restorePreparation(true);
  expect(f.model.snapshot().prepareUnknown).toBe(true); expect(f.storage.length).toBe(1);
  await f.model.restorePreparation(true); expect(f.model.snapshot().preparation?.phase).toBe('prepared');
  expect(calls('/prepare')).toHaveLength(1); expect(calls('/run')).toHaveLength(0); f.model.dispose();
});

it('opens no children until explicit candidate reading and maps only the exact saved target', async () => {
  const f = fixture(); expect(fake.fetcher).not.toHaveBeenCalled(); await f.model.load();
  expect(fake.fetcher).not.toHaveBeenCalled(); f.model.select(page.items[0]); await f.model.candidates();
  expect(calls('/open').map(call => call[1].purpose)).toEqual(['target']);
  f.model.choose('invented-name', { kind: 'mcp', fieldIndices: [0] }); expect(f.model.snapshot().selections).toEqual({});
  f.model.choose('owned-item', { kind: 'mcp', fieldIndices: [0] });
  expect(f.model.snapshot().selections['owned-item']).toMatchObject({ kind: 'mcp', sourceName: 'notes', targetName: 'renamed-notes', fields: [{ kind: 'environment', name: 'TOKEN' }] });
  await f.model.run({ apiKeys: false, mcpPrivateFields: true });
  expect(f.model.snapshot().error).toBe('private_credentials_source_not_selected'); expect(calls('/run')).toHaveLength(0);
  f.model.dispose();
});

it('leaves private-parent capability negotiation to the protected HTTP lane and rejects a changed original revision', async () => {
  const old = fixture(); await old.model.load(); old.model.select(page.items[0]);
  const gate = fake.fetcher.getMockImplementation()!;
  fake.fetcher.mockImplementation(async (path: string, body: any) => { if (path.endsWith('/candidates')) throw new Error('private_credentials_update_required'); return gate(path, body); });
  await old.model.candidates();
  expect(old.client.supportsCapability('migrationSourceTransferPrivateCredentialsV1')).toBe(false);
  expect(old.model.snapshot().error).toBe('private_credentials_update_required'); expect(calls('/candidates')).toHaveLength(1);
  expect(calls('/run')).toHaveLength(0); expect(calls('/prepare')).toHaveLength(0); old.model.dispose(); fake.fetcher.mockReset();
  const f = fixture(); await f.model.load(); f.model.select(page.items[0]);
  const original = fake.fetcher.getMockImplementation()!;
  fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/candidates') ? { ...candidate, sourceBindingRevision: 'd'.repeat(64) } : original(path, body));
  await f.model.candidates(); expect(f.model.snapshot().error).toBe('private_credentials_binding_changed'); expect(f.model.snapshot().candidates).toBeNull();
  expect(calls('/run')).toHaveLength(0); f.model.dispose();
});

it('persists one original offer before dispatch, rejects double clicks and reopens a lost reply by reading only', async () => {
  const f = fixture(); await choose(f);
  let finish!: () => void;
  const original = fake.fetcher.getMockImplementation()!;
  fake.fetcher.mockImplementation(async (path: string, body: any) => {
    if (path.endsWith('/run')) { expect(f.storage.length).toBe(1); await new Promise<void>(resolve => { finish = resolve; }); throw new Error('lost reply'); }
    return original(path, body);
  });
  const pending = f.model.run({ apiKeys: false, mcpPrivateFields: true });
  await vi.waitFor(() => expect(calls('/run')).toHaveLength(1));
  await f.model.run({ apiKeys: false, mcpPrivateFields: true }); finish(); await pending;
  expect(f.model.snapshot().error).toBe('private_credentials_outcome_unknown'); const input = f.model.snapshot().input!;
  expect(calls('/run')).toHaveLength(1); f.model.dispose();
  const next = f.create(); await next.load(); next.select(page.items[0]); await next.candidates();
  expect(next.snapshot().records.map(row => row.locator.offerId)).toEqual([input.locator.offerId]);
  await next.read(next.snapshot().records[0]); expect(next.snapshot().result?.received).toBe(true);
  expect(next.snapshot().observed.source).toBeUndefined(); expect(next.snapshot().workers.source).toBeUndefined();
  expect(calls('/run')).toHaveLength(1); expect(calls('/read').at(-1)?.[1].offerId).toBe(input.locator.offerId);
  await next.control('source', 'resume', control); expect(calls('/resume')).toHaveLength(0); next.dispose();
});

it('prepares only explicitly included received offers and returns to the ordinary batch without publishing it', async () => {
  const f = fixture(); await choose(f); await f.model.run({ apiKeys: false, mcpPrivateFields: true });
  await f.model.prepare(true); expect(calls('/prepare')).toHaveLength(0);
  f.model.include(true); await f.model.prepare(false); expect(calls('/prepare')).toHaveLength(0);
  await f.model.prepare(true); expect(calls('/prepare')).toHaveLength(1);
  expect(calls('/prepare')[0][1]).toMatchObject({ jobId, expectedSequence: 7, consent: { apiKeys: false, mcpPrivateFields: true } });
  expect(f.prepared).toHaveBeenCalledWith(expect.objectContaining({ batch: expect.objectContaining({ planId: 'plan-prepared' }) }));
  expect(f.rpc.mock.calls.some(call => call[0] === 'migration/batch/run')).toBe(false); f.model.dispose();
});

it('shows the canonical original offer even when observing an already-persisted semantic transfer fails', async () => {
  const f = fixture(); await choose(f); await f.model.run({ apiKeys: false, mcpPrivateFields: true });
  const originalOffer = f.model.snapshot().input!.locator.offerId, native = fake.fetcher.getMockImplementation()!;
  fake.fetcher.mockImplementation(async (path: string, body: any) => {
    if (path.endsWith('/read')) throw new Error('lost original read response');
    return native(path, body);
  });
  await f.model.run({ apiKeys: false, mcpPrivateFields: true });
  expect(calls('/run')).toHaveLength(1); expect(calls('/read')).toHaveLength(1);
  expect(f.model.snapshot().input?.locator.offerId).toBe(originalOffer); f.model.dispose();
});

it('explicitly observes only the original source while retaining the already-confirmed target receipt', async () => {
  const f = fixture(); await choose(f); await f.model.run({ apiKeys: false, mcpPrivateFields: true }); await f.model.read();
  const targetReceipt = f.model.snapshot().result, targetControl = f.model.snapshot().observed.target;
  expect(f.model.snapshot().observed.source).toBeUndefined(); await f.model.sourceRead();
  expect(calls('/source-read')).toHaveLength(1); expect(calls('/source-read')[0][1].source.targetId).toBe(source.id);
  expect(f.model.snapshot().observed.source?.sequence).toBe(2); expect(f.model.snapshot().workers.source).toBe(false);
  expect(f.model.snapshot().observed.target).toEqual(targetControl); expect(f.model.snapshot().result).toEqual(targetReceipt);
  f.model.device({ id: 'wrong-source' }); await f.model.read(f.model.snapshot().records[0]); await f.model.sourceRead();
  expect(calls('/source-read')).toHaveLength(1); expect(f.model.snapshot().error).toBe('private_credentials_binding_changed'); f.model.dispose();
});

it('requires exact observed cancellation watermarks and never marks unobserved workers stopped', async () => {
  const f = fixture(); await choose(f); await f.model.run({ apiKeys: false, mcpPrivateFields: true });
  await f.model.control('target', 'resume', { ...control, cancelWatermark: 9 }); expect(calls('/resume')).toHaveLength(0);
  await f.model.control('source', 'cancel', control); expect(calls('/cancel')).toHaveLength(1);
  expect(f.model.snapshot().result).toBeNull(); expect(f.model.snapshot().observed.source?.cancelWatermark).toBe(1);
  await f.model.read(); expect(f.model.snapshot().workers.source).toBeUndefined();
  await f.model.control('source', 'resume', { ...control, sequence: 3, cancelWatermark: 1 }); expect(calls('/resume')).toHaveLength(0);
  f.model.dispose();
});

it('reads and cancels the persisted original offer while run is pending, then ignores its older combined response', async () => {
  const f = fixture(); await choose(f);
  let finish!: (value: unknown) => void, input!: MigrationSourceCredentialRunParams;
  const native = fake.fetcher.getMockImplementation()!;
  fake.fetcher.mockImplementation(async (path: string, body: any) => {
    if (path.endsWith('/run')) { input = body; return new Promise(resolve => { finish = resolve; }); }
    return native(path, body);
  });
  const pending = f.model.run({ apiKeys: false, mcpPrivateFields: true });
  try {
    await vi.waitFor(() => expect(calls('/run')).toHaveLength(1));
    expect(f.model.snapshot().busy).toBe(true); expect(f.model.snapshot().controlBusy).toBe(false);
    await f.model.read(); expect(calls('/read')).toHaveLength(1); expect(f.model.snapshot().busy).toBe(true);
    await f.model.control('target', 'resume', control); expect(calls('/resume')).toHaveLength(0);
    await f.model.control('target', 'cancel'); expect(calls('/cancel')).toHaveLength(1);
    expect(calls('/cancel')[0][1].locator.offerId).toBe(input.locator.offerId);
    expect(f.model.snapshot().observed.target).toMatchObject({ sequence: 3, cancelWatermark: 1, cancelled: true });
  } finally { finish(received(input.locator, true)); await pending; }
  expect(f.model.snapshot().observed.target).toMatchObject({ sequence: 3, cancelWatermark: 1, cancelled: true });
  expect(f.model.snapshot().observed.source).toBeUndefined(); expect(f.model.snapshot().result).toBeNull();
  expect(calls('/run')).toHaveLength(1); expect(f.model.snapshot().busy).toBe(false); f.model.dispose();
});

it('does not publish a late pending control result into a different account scope', async () => {
  const f = fixture(); await choose(f); await f.model.run({ apiKeys: false, mcpPrivateFields: true });
  let finish!: (value: unknown) => void;
  const native = fake.fetcher.getMockImplementation()!;
  fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/cancel')
    ? new Promise(resolve => { finish = resolve; }) : native(path, body));
  const previous = f.model.snapshot(), pending = f.model.control('target', 'cancel');
  await vi.waitFor(() => expect(calls('/cancel')).toHaveLength(1));
  f.invalidate(); finish({ requestId: previous.input!.locator.requestId, offerId: previous.input!.locator.offerId,
    side: 'target', control: { sequence: 3, cancelWatermark: 1, cancelled: true }, workerRunning: false });
  await pending;
  expect(f.model.snapshot().observed).toEqual(previous.observed); expect(calls('/run')).toHaveLength(1); f.model.dispose();
});

it('does not replace a newer Native observation with a delayed older cancellation receipt', async () => {
  const f = fixture(); await choose(f);
  let finishRun!: (value: unknown) => void, finishCancel!: (value: unknown) => void, input!: MigrationSourceCredentialRunParams;
  const native = fake.fetcher.getMockImplementation()!;
  fake.fetcher.mockImplementation(async (path: string, body: any) => {
    if (path.endsWith('/run')) { input = body; return new Promise(resolve => { finishRun = resolve; }); }
    if (path.endsWith('/cancel')) return new Promise(resolve => { finishCancel = resolve; });
    return native(path, body);
  });
  const running = f.model.run({ apiKeys: false, mcpPrivateFields: true });
  await vi.waitFor(() => expect(calls('/run')).toHaveLength(1));
  const cancelling = f.model.control('target', 'cancel');
  await vi.waitFor(() => expect(calls('/cancel')).toHaveLength(1));
  finishRun({ ...received(input.locator, true), targetControl: { ...control, sequence: 5, cancelWatermark: 1 } }); await running;
  expect(f.model.snapshot().observed.target?.sequence).toBe(5);
  finishCancel({ requestId: input.locator.requestId, offerId: input.locator.offerId, side: 'target',
    control: { sequence: 3, cancelWatermark: 1, cancelled: true }, workerRunning: false }); await cancelling;
  try { expect(f.model.snapshot().observed.target?.sequence).toBe(5); }
  finally { f.model.dispose(); }
});

it('rejects new metadata and candidate revisions without retaining old actionable choices', async () => {
  const f = fixture(); await choose(f); await f.model.run({ apiKeys: false, mcpPrivateFields: true }); f.model.include(true);
  f.rpc.mockResolvedValueOnce({ ...page, sequence: 8 }); await f.model.load();
  expect(f.model.snapshot()).toMatchObject({ error: 'private_credentials_plan_changed', selected: null, candidates: null, selections: {}, included: [] });
  await f.model.prepare(true); expect(calls('/prepare')).toHaveLength(0);
  await choose(f);
  const original = fake.fetcher.getMockImplementation()!;
  fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/candidates')
    ? { ...candidate, items: candidate.items.map(item => ({ ...item, targets: item.targets?.map(target => ({ ...target, targetName: 'peer-renamed' })) })) }
    : original(path, body));
  await f.model.candidates();
  expect(f.model.snapshot()).toMatchObject({ error: 'private_credentials_binding_changed', selected: null, candidates: null, selections: {}, included: [] });
  f.model.dispose();
});

it('keeps authoritative source pages bounded and requires the original metadata sequence on later pages', async () => {
  const f = fixture(), rows = Array.from({ length: 11 }, (_, index) => ({ ...page.items[0], entryId: `e0000-${String(index).padStart(4, '0')}` }));
  f.rpc.mockImplementation(async (_method, input) => {
    const index = (input as { pageIndex: number }).pageIndex;
    return { ...page, items: rows.slice(index * 10, index * 10 + 10), totalItems: 11, nextPage: index === 0 ? 1 : null };
  });
  await f.model.load(); expect(f.model.snapshot().page?.items).toHaveLength(10);
  f.model.select(rows[0]); await f.model.load(1); expect(f.model.snapshot().page?.items).toHaveLength(1);
  expect(f.model.snapshot().selected?.entryId).toBe(rows[0].entryId);
  f.rpc.mockResolvedValueOnce({ ...page, items: [rows[10]], totalItems: 11, sequence: 8, nextPage: null });
  await f.model.load(1); expect(f.model.snapshot().selected).toBeNull(); f.model.dispose();
});

it('never replays prepare after a lost reply without another explicit confirmation of the same durable set', async () => {
  const f = fixture(); await choose(f); await f.model.run({ apiKeys: false, mcpPrivateFields: true }); f.model.include(true);
  const original = fake.fetcher.getMockImplementation()!; let saved: any;
  fake.fetcher.mockImplementation(async (path: string, body: any) => {
    if (path.endsWith('/prepare')) { saved = structuredClone(body); expect(f.storage.length).toBe(2); throw new Error('lost prepare reply'); }
    return original(path, body);
  });
  await f.model.prepare(true); expect(f.model.snapshot().prepareUnknown).toBe(true); expect(calls('/prepare')).toHaveLength(1);
  await f.model.read(); expect(calls('/prepare')).toHaveLength(1); expect(f.prepared).not.toHaveBeenCalled();
  const newer = { ...job, job: { ...job.job, sequence: 9 }, batch: { ...job.batch!, planId: 'plan-peer-new' } };
  f.rpc.mockResolvedValueOnce({ state: newer, workerRunning: false, workerError: null, progress: null });
  fake.fetcher.mockImplementation(original);
  await f.model.prepare(true); expect(calls('/prepare')).toHaveLength(2);
  expect(calls('/prepare').at(-1)?.[1]).toEqual(saved);
  expect(f.prepared).toHaveBeenCalledTimes(1); f.model.dispose();
});

it('recovers the immutable original prepare set after reopening a newer ordinary plan without replaying its transfer', async () => {
  const f = fixture(); await choose(f); await f.model.run({ apiKeys: false, mcpPrivateFields: true }); f.model.include(true);
  const native = fake.fetcher.getMockImplementation()!; let original: any;
  fake.fetcher.mockImplementation(async (path: string, body: any) => {
    if (path.endsWith('/prepare')) { original = structuredClone(body); throw new Error('accepted original reply lost'); }
    return native(path, body);
  });
  await f.model.prepare(true); expect(f.prepared).not.toHaveBeenCalled(); f.model.dispose();
  const newer = { ...job, job: { ...job.job, sequence: 9 }, batch: { ...job.batch!, planId: 'plan-current' } };
  f.rpc.mockImplementation(async method => method === 'migration/batch/credential-sources' ? { ...page, planId: 'plan-current', sequence: 9 }
    : { state: newer, workerRunning: false, workerError: null, progress: null });
  fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/candidates')
    ? { ...candidate, plan: { jobId, planId: 'plan-current', sequence: 9 } } : native(path, body));
  const reopened = f.create(newer); await reopened.load(); reopened.select(page.items[0]); await reopened.candidates();
  const saved = reopened.snapshot().records[0]; expect(saved.locator.offerId).toBe(original.locator.offerId);
  await reopened.read(saved); reopened.include(true); await reopened.prepare(false); expect(calls('/prepare')).toHaveLength(1);
  await reopened.prepare(true);
  expect(calls('/prepare')).toHaveLength(2); const retried = calls('/prepare')[1][1];
  expect(retried).toMatchObject({ expectedSequence: original.expectedSequence, consent: original.consent,
    jobId: original.jobId, locator: { requestId: original.locator.requestId, offerId: original.locator.offerId } });
  expect(retried.locator.target.sessionId).not.toBe(original.locator.target.sessionId);
  expect(calls('/run')).toHaveLength(1); expect(f.storage.length).toBe(2); expect(f.prepared).toHaveBeenCalledTimes(1);
  reopened.dispose();
});

it.each(['close', 'account'])('cleans the original pending child after %s and never reads or writes on a replacement target', async mode => {
  const f = fixture(); await f.model.load(); f.model.select(page.items[0]);
  let finish!: (value: unknown) => void;
  const original = fake.fetcher.getMockImplementation()!;
  fake.fetcher.mockImplementation(async (path: string, body: any) => path.endsWith('/open') ? new Promise(resolve => { finish = resolve; }) : original(path, body));
  const pending = f.model.candidates(); await vi.waitFor(() => expect(calls('/open')).toHaveLength(1));
  if (mode === 'close') f.model.dispose(); else f.invalidate();
  finish({ status: 'ready', launching: false, ownedChildren: 1 }); await pending;
  expect(calls('/candidates')).toHaveLength(0); expect(calls('/run')).toHaveLength(0);
  await vi.waitFor(() => expect(calls('/close').length).toBeGreaterThanOrEqual(1));
  expect(calls('/close').every(call => call[1].targetId === target.id && call[1].sessionId === calls('/open')[0][1].sessionId)).toBe(true); f.model.dispose();
});
