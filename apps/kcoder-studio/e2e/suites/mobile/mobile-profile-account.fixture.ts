import { ProfileCoordinator } from '../../../mobile/src/state/profile-coordinator';
import { DeviceAuthorizationManager } from '../../../mobile/src/state/device-authorization';
import { loadProfiles, persistProfiles } from '../../../mobile/src/storage/profile-store';
import { withLocalMetadata, canCoordinateLegacyCreation } from '../../../mobile/src/storage/context-lock';
import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc } from '../../../mobile/src/storage/workspace-profile-fence';
import { migrationIntentStore } from '../../../mobile/src/storage/migration-intents';
import type { GatewayProfile } from '../../../mobile/src/gateway/types';

// Only this owned fixture supplies credentials; no endpoint accepts a real account.
const synthetic = (id: string, generation = 'generation-one'): GatewayProfile => ({ id, label: id, baseUrl: `http://owned.invalid/${id}`, authMode: 'device', deviceId: `device-${id}`, authorizationGeneration: generation, accessToken: 'synthetic-access', rpcToken: 'cookie-auth', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 10, refreshExpiresAt: Date.now() + 1_000_000 });
const coordinator = new ProfileCoordinator({ reload: loadProfiles, serialize: operation => withLocalMetadata('gateway-profile-index', operation) });
let profile: GatewayProfile, refresh: Promise<void> | undefined, finishResponse: (() => void) | undefined;
let requests: string[] = [], sends = 0, refreshOutcome = 'not-started';
const manager = new DeviceAuthorizationManager(id => coordinator.getSnapshot().profiles.find(row => row.id === id), (before, next, intent) => coordinator.updateCredentials(before, next, persistProfiles, intent), () => {}, async (before, id) => {
  requests.push(id); await new Promise<void>(resolve => { finishResponse = resolve; });
  return { ...before, pendingRotationId: undefined, accessToken: 'synthetic-next', refreshToken: 'synthetic-next-refresh', expiresAt: Date.now() + 100_000 };
}, () => `rotation-${Math.random().toString(36).slice(2)}`, () => coordinator.synchronize().then(() => {}));
export const fixture = {
  legacyCreationCoordinated() { return canCoordinateLegacyCreation(); },
  async seed() { await withLocalMetadata('gateway-profile-index', authority => persistProfiles([synthetic('primary'), synthetic('unrelated')], 'primary', authority)); },
  async restore() { coordinator.hydrate(await loadProfiles()); profile = coordinator.getSnapshot().profiles.find(row => row.id === 'primary')!; },
  async synchronize() { await coordinator.synchronize(); },
  beginRefresh() { refreshOutcome = 'pending'; refresh = manager.authorize({ ...profile }, true).then(() => { refreshOutcome = 'accepted'; }, () => { refreshOutcome = 'rejected'; }); },
  finishRefresh() { finishResponse?.(); return refresh; },
  state() { return { requests: [...requests], sends, refreshOutcome, profiles: coordinator.getSnapshot().profiles.map(row => ({ id: row.id, generation: row.authorizationGeneration, pending: row.pendingRotationId !== undefined })) }; },
  async remove() { await coordinator.synchronize(); return (await coordinator.remove(coordinator.beginRemoval('primary'), persistProfiles)).removed; },
  async replace() { const next = synthetic('primary', 'generation-two'); await coordinator.commitConnection(coordinator.beginConnection(), next, persistProfiles); },
  async sendOld() { try { const response = await startWorkspaceProfileRpc(captureWorkspaceProfileIdentity(profile), () => { sends++; return Promise.resolve('sent'); }); await response.response; return true; } catch { return false; } },
  async oldIntent() { try { await migrationIntentStore(profile, 'owned-profile-scope', () => true).put({ id: 'owned-intent', method: 'migration/batch/run', createdAt: 1, phase: 'intent', requestId: 'owned-intent', jobId: 'owned-job', planId: 'owned-plan' }); return true; } catch { return false; } },
  async durable() { return (await loadProfiles()).profiles.map(row => ({ id: row.id, generation: row.authorizationGeneration, pending: row.pendingRotationId !== undefined })); },
  async add(id: string) { await coordinator.commitConnection(coordinator.beginConnection(), synthetic(id), persistProfiles); },
};
(globalThis as unknown as { fixture: typeof fixture }).fixture = fixture;
