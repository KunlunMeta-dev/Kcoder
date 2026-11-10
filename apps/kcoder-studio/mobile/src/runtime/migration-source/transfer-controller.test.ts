import { beforeEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ allowed: true, requests: [] as Array<{ path: string; body: any }>, handler: null as any }));
vi.mock('@/storage/workspace-profile-fence', () => ({ captureWorkspaceProfileIdentity: (value: any) => value.id, startWorkspaceProfileRpc: async (_identity: string, send: () => Promise<unknown>) => { if (!fake.allowed) throw new Error('revoked'); return { response: send() }; } }));
vi.mock('@/gateway/http', () => ({ gatewayRequest: async (_profile: unknown, path: string, init: RequestInit, limits: { beforeDispatch(): void }) => { await Promise.resolve(); limits.beforeDispatch(); const body = JSON.parse(String(init.body)); fake.requests.push({ path, body }); return fake.handler(path, body); } }));
import { MobileSourceTransfer } from './transfer-controller';
import { createMigrationTargetRecovery } from './target-recovery';
import { TestStorage } from './test-storage';
import type { GatewayProfile } from '@/gateway/types';
const profile = { id: 'owned', baseUrl: 'https://owned.invalid' } as GatewayProfile;
const source = { sessionId: '10000000-0000-4000-8000-000000000001', targetId: 'source', purpose: 'source' as const };
const ready = { status: 'ready', launching: false, ownedChildren: 1 };
const unknown = (requestId: string) => ({ requestId, coordinatorState: 'unknown', observation: 'unobserved', result: null, progress: null, errorCode: null });
const control = { sequence: 2, cancelWatermark: 1, cancelled: true, ready: false };
const paused = (requestId: string) => ({ ...unknown(requestId), observation: 'observed', result: { requestId, phase: 'cancelled', sourceState: control, sourceSnapshotControl: control, targetState: control, targetAdmissionControl: control, targetWorkerRunning: false, receipt: null, sourceCapture: { status: 'ready', errorCode: null } } });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { resolve, promise }; };
beforeEach(() => { fake.requests = []; fake.allowed = true; fake.handler = async (path: string, body: any) => path.endsWith('/open') ? ready : path.endsWith('/close') ? { status: 'released' } : unknown(body.requestId); });
function setup(storage = new TestStorage()) {
  const model = new MobileSourceTransfer({ profile, target: { id: 'target' }, storage, scope: 'owned', captureScope: () => 'owned', isCurrent: () => true });
  return { model, storage };
}
it('records the immutable locator before dispatch and cancellation suppresses a late original run reply', async () => {
  const { model, storage } = setup(), pending = deferred();
  fake.handler = async (path: string, body: any) => {
    if (path.endsWith('/open')) return ready;
    if (path.endsWith('/run')) { expect(storage.length).toBe(1); return pending.promise; }
    return unknown(body.requestId);
  };
  const running = model.start(source, [{ kind: 'configuration', sourceId: 'opaque' }]);
  await vi.waitFor(() => expect(fake.requests.some(row => row.path.endsWith('/run'))).toBe(true));
  await model.cancel(); const cancelled = model.snapshot().result;
  expect(fake.requests.filter(row => row.path.endsWith('/cancel'))).toHaveLength(1);
  pending.resolve({ ...unknown(model.snapshot().input!.requestId), coordinatorState: 'running' }); await running;
  expect(model.snapshot().result).toEqual(cancelled); expect(model.snapshot().busy).toBe(false);
  await model.read(); expect(fake.requests.filter(row => row.path.endsWith('/run'))).toHaveLength(1); model.dispose();
});
it('cannot publish after selector persistence fails and never replays an uncertain first request', async () => {
  const storage = new TestStorage(); storage.setItem = () => { throw new Error('quota'); };
  const { model } = setup(storage); await model.start(source, [{ kind: 'assets', sourceId: 'opaque' }]);
  expect(model.snapshot().error).toBe('source_transfer_recovery_unavailable'); expect(fake.requests.some(row => row.path.endsWith('/run'))).toBe(false); model.dispose();
});
it('reuses the original explicit resume attempt after a lost reply and rejects changed Native watermarks', async () => {
  const { model } = setup(); let state: any;
  fake.handler = async (path: string, body: any) => {
    if (path.endsWith('/open')) return ready;
    if (path.endsWith('/close')) return { status: 'released' };
    state ??= paused(body.requestId);
    if (path.endsWith('/run') && body.resume) throw new Error('accepted acknowledgement lost');
    return state;
  };
  await model.start(source, [{ kind: 'configuration', sourceId: 'opaque' }]);
  // Native source capture is observed independently of coordinator idleness.
  expect(model.snapshot().error).toBeNull(); const confirmed = model.snapshot().result!;
  await model.resume(confirmed); await model.resume(confirmed);
  const resumed = fake.requests.filter(row => row.path.endsWith('/run') && row.body.resume);
  expect(resumed).toHaveLength(2); expect(resumed[0].body).toEqual(resumed[1].body); expect(resumed[0].body.selections).toBeUndefined();
  state = structuredClone(state); state.result.targetAdmissionControl.sequence++;
  await model.resume(confirmed); expect(model.snapshot().error).toBe('source_transfer_stale_control'); expect(fake.requests.filter(row => row.path.endsWith('/run') && row.body.resume)).toHaveLength(2); model.dispose();
});
it('opens only target recovery, reads the original receipt, and releases a late open on the original target', async () => {
  const storage = new TestStorage(), id = source.sessionId;
  storage.setItem(`kcoder-studio:mobile-transfer:owned:${id}`, JSON.stringify({ version: 1, attemptId: id, request: { requestId: id, source, target: { sessionId: id, purpose: 'target', targetId: 'target' } } }));
  const pending = deferred();
  fake.handler = async (path: string, body: any) => path.endsWith('/open') ? pending.promise : path.endsWith('/close') ? { status: 'released' } : unknown(body.requestId);
  const manager = createMigrationTargetRecovery({ profile, target: { id: 'target' }, storage, recoveryScope: 'owned', captureScope: () => 'owned', captureCleanupScope: () => 'owned' });
  expect(manager.list().records).toHaveLength(1); expect(fake.requests).toHaveLength(0);
  const reading = manager.read(id); await vi.waitFor(() => expect(fake.requests).toHaveLength(1)); await manager.release(); pending.resolve(ready);
  await expect(reading).rejects.toMatchObject({ code: 'source_transfer_authority_changed' });
  expect(fake.requests.every(row => !row.path.endsWith('/target-read'))).toBe(true);
  const original = fake.requests[0].body; expect(original.purpose).toBe('target_recovery'); expect(original.targetId).toBe('target');
  expect(fake.requests.slice(1).every(row => row.path.endsWith('/close') && JSON.stringify(row.body) === JSON.stringify(original))).toBe(true);
});
