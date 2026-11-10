import { beforeEach, expect, it, vi } from 'vitest';
import examples from '../../../../shared/generated/examples.migration-source-credentials.json';
import type { GatewayProfile } from '@/gateway/types';
import type { MigrationSourceCredentialLocator, MigrationSourceCredentialRunParams, MigrationSourceCredentialPreparationReadParams } from '../../../../shared/generated/contracts';

const fake = vi.hoisted(() => ({ allowed: true, requests: [] as Array<{ path: string; body: unknown }>, signals: [] as Array<AbortSignal | null | undefined>, reply: null as unknown, fail: false, error: 'lost reply' }));
vi.mock('@/storage/workspace-profile-fence', () => ({
  captureWorkspaceProfileIdentity: () => 'original-profile',
  startWorkspaceProfileRpc: async (_owner: unknown, send: () => Promise<unknown>) => {
    if (!fake.allowed) throw new Error('revoked');
    return { response: send() };
  },
}));
vi.mock('@/gateway/http', () => ({ gatewayRequest: async (_profile: unknown, path: string, init: RequestInit, limits: { beforeDispatch(): void }) => {
  limits.beforeDispatch();
  fake.requests.push({ path, body: JSON.parse(String(init.body)) });
  fake.signals.push(init.signal);
  if (fake.fail) throw new Error(fake.error);
  return fake.reply;
} }));
import { createMigrationPrivateCredentialClient } from './private-credentials';

const profile = { id: 'owned', baseUrl: 'https://owned.invalid' } as GatewayProfile;
const locator = examples.MigrationSourceCredentialLocator[0].value as MigrationSourceCredentialLocator;
const offered = examples.MigrationSourceCredentialResult[0].value;
beforeEach(() => { fake.allowed = true; fake.requests = []; fake.signals = []; fake.reply = offered; fake.fail = false; fake.error = 'lost reply'; });

it('reads only the original target receipt through the private metadata route', async () => {
  const client = createMigrationPrivateCredentialClient({ profile, captureScope: () => 'owner' });
  await expect(client.read(locator)).resolves.toEqual(offered);
  expect(fake.requests).toEqual([{ path: '/api/migration/source-transfer/private/read', body: locator }]);
});

it('reads native preparation by the original job/request without a cached offer or a private-capability claim from ordinary RPC', async () => {
  const input = examples.MigrationSourceCredentialPreparationReadParams[0].value as MigrationSourceCredentialPreparationReadParams;
  const client = createMigrationPrivateCredentialClient({ profile, captureScope: () => 'owner' });
  fake.reply = examples.MigrationSourceCredentialPreparationResult.find(row => row.value.phase === 'prepared')!.value;
  await expect(client.preparationRead(input)).resolves.toEqual(fake.reply);
  expect(fake.requests).toEqual([{ path: '/api/migration/source-transfer/private/prepare-status', body: input }]);
  fake.fail = true; fake.error = 'private_credentials_update_required';
  await expect(client.preparationRead(input)).rejects.toMatchObject({ code: 'private_credentials_update_required', outcomeUnknown: false });
  expect(fake.requests).toHaveLength(2);
});

it('routes source-only observation through its exact read-only path and rejects invented target facts', async () => {
  const client = createMigrationPrivateCredentialClient({ profile, captureScope: () => 'owner' });
  const source = (examples.MigrationSourceCredentialRunParams[0].value as MigrationSourceCredentialRunParams).source;
  const value = { ...offered, phase: 'sealed', sourceObserved: true,
    sourceControl: { sequence: 2, cancelWatermark: 0, cancelled: false, ready: true }, sourceWorkerRunning: false,
    targetObserved: false, targetControl: null, targetWorkerRunning: null, received: false, keyReleased: false };
  fake.reply = value;
  await expect(client.sourceRead({ locator, source })).resolves.toEqual(value);
  expect(fake.requests).toEqual([{ path: '/api/migration/source-transfer/private/source-read', body: { locator, source } }]);
  fake.reply = { ...value, received: true };
  await expect(client.sourceRead({ locator, source })).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: false });
  const count = fake.requests.length;
  await expect(client.sourceRead({ locator, source: { ...source, purpose: 'target' } })).rejects.toMatchObject({ outcomeUnknown: false });
  expect(fake.requests).toHaveLength(count);
});

it('preserves an uncertain mutation without resubmitting it', async () => {
  fake.fail = true;
  const input = examples.MigrationSourceCredentialRunParams[0].value as MigrationSourceCredentialRunParams;
  const client = createMigrationPrivateCredentialClient({ profile, captureScope: () => 'owner' });
  await expect(client.run(input)).rejects.toMatchObject({ outcomeUnknown: true });
  expect(fake.requests).toEqual([{ path: '/api/migration/source-transfer/private/run', body: input }]);
});

it('uses the owning generation signal and refuses a new observation after that owner is aborted', async () => {
  const owner = new AbortController(), client = createMigrationPrivateCredentialClient({ profile, captureScope: () => 'owner' }, () => owner.signal);
  await client.read(locator); expect(fake.signals).toEqual([owner.signal]); owner.abort();
  await expect(client.read(locator)).rejects.toMatchObject({ code: 'source_transfer_request_not_sent', outcomeUnknown: false });
  expect(fake.requests).toHaveLength(1);
});

it('rejects another offer and refuses dispatch under revoked profile authority', async () => {
  fake.reply = { ...offered, offerId: '44444444-4444-4444-8444-444444444444' };
  const client = createMigrationPrivateCredentialClient({ profile, captureScope: () => 'owner' });
  await expect(client.read(locator)).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: false });
  fake.allowed = false;
  await expect(client.read(locator)).rejects.toMatchObject({ outcomeUnknown: false });
  expect(fake.requests).toHaveLength(1);
});

it('retains only recognized private diagnostic codes', async () => {
  fake.fail = true;
  const client = createMigrationPrivateCredentialClient({ profile, captureScope: () => 'owner' });
  for (const code of ['private_credentials_keyring_unavailable', 'private_credentials_SYNTHETIC_PRIVATE_VALUE']) {
    fake.error = code;
    await expect(client.read(locator)).rejects.toMatchObject({ code: code.endsWith('unavailable') ? code : 'source_transfer_outcome_unknown', outcomeUnknown: false });
  }
});
