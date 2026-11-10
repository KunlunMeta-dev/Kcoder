import { expect, it, vi } from 'vitest';
import examples from '../../../../shared/generated/examples.migration-source-credentials.json';
import { CREDENTIAL_SOURCES_CAPABILITY, CREDENTIAL_SOURCES_METHOD } from '../../../../shared/migrationCredentialSources';
import { MobileMigrationClient } from '../migration-client';
import { CALLS } from './contracts';

const params = { jobId: 'mig-owned', pageIndex: 0 };
const result = examples.MigrationSourceCredentialSourcesResult[0].value;
const journal = () => ({ read: vi.fn(async () => []), put: vi.fn(async () => {}) });

it('negotiates the independent metadata capability before transport and keeps the read out of mutation recovery', async () => {
  const request = vi.fn().mockResolvedValue(result), store = journal();
  const old = new MobileMigrationClient(request, { migrationBatchV1: true }, store, () => true);
  expect(old.supports('credentialSources')).toBe(false);
  await expect(old.call('credentialSources', params)).rejects.toMatchObject({ code: 'migration_update_required' });
  expect(request).not.toHaveBeenCalled();
  const client = new MobileMigrationClient(request, { [CREDENTIAL_SOURCES_CAPABILITY]: true }, store, () => true);
  await expect(client.call('credentialSources', params)).resolves.toEqual(result);
  expect(request).toHaveBeenCalledWith(CREDENTIAL_SOURCES_METHOD, params);
  expect(CALLS.credentialSources).toMatchObject({ read: true, rows: ['items'] });
  expect(store.put).not.toHaveBeenCalled();
});

it('binds the exact original job, ten-item page and unique immutable source locators', async () => {
  const request = vi.fn(), store = journal();
  const client = new MobileMigrationClient(request, { [CREDENTIAL_SOURCES_CAPABILITY]: true }, store, () => true);
  for (const value of [undefined, { ...result, jobId: 'peer-job' }, { ...result, items: [] }, { ...result, nextPage: 1 },
    { ...result, items: [result.items[0], result.items[0]], totalItems: 2 },
    { ...result, privateKey: 'SYNTHETIC_REJECTED_VALUE' }]) {
    request.mockResolvedValueOnce(value);
    await expect(client.call('credentialSources', params)).rejects.toMatchObject({ code: 'migration_invalid_response' });
  }
  const rows = Array.from({ length: 10 }, (_, index) => ({ ...result.items[0], entryId: `e0000-${String(index).padStart(4, '0')}` }));
  request.mockResolvedValueOnce({ ...result, items: rows, totalItems: 11, nextPage: 1 });
  await expect(client.call('credentialSources', params)).resolves.toHaveProperty('nextPage', 1);
  request.mockResolvedValueOnce({ ...result, totalItems: 11, nextPage: null });
  await expect(client.call('credentialSources', { ...params, pageIndex: 1 })).resolves.toHaveProperty('totalItems', 11);
  request.mockResolvedValueOnce(result);
  await expect(client.call('credentialSources', { ...params, pageIndex: 1 })).rejects.toMatchObject({ code: 'migration_invalid_response' });
  request.mockResolvedValueOnce({ ...result, items: [...rows, { ...rows[0], entryId: 'e0000-0010' }], totalItems: 11 });
  await expect(client.call('credentialSources', params)).rejects.toMatchObject({ code: 'migration_invalid_response' });
  expect(store.put).not.toHaveBeenCalled();
});

it('rejects injected paths and invalid pages before dispatch', async () => {
  const request = vi.fn();
  const client = new MobileMigrationClient(request, { [CREDENTIAL_SOURCES_CAPABILITY]: true }, journal(), () => true);
  for (const value of [{ ...params, path: '/peer' }, { ...params, pageIndex: -1 }, { ...params, pageIndex: 1025 }]) {
    await expect(client.call('credentialSources', value)).rejects.toMatchObject({ code: 'migration_invalid_parameters' });
  }
  expect(request).not.toHaveBeenCalled();
});

it('keeps only generated private diagnostic codes from the metadata RPC', async () => {
  const request = vi.fn(), client = new MobileMigrationClient(request, { [CREDENTIAL_SOURCES_CAPABILITY]: true }, journal(), () => true);
  for (const [message, code] of [['private_credentials_invalid_page', 'private_credentials_invalid_page'],
    ['private_credentials_SYNTHETIC_PRIVATE_VALUE', 'migration_request_failed']]) {
    request.mockRejectedValueOnce(new Error(message));
    await expect(client.call('credentialSources', params)).rejects.toMatchObject({ code });
  }
});

it.each(['scope', 'close'])('does not accept late metadata after %s invalidation', async invalidation => {
  let finish!: (value: unknown) => void, current = true;
  const request = vi.fn(() => new Promise(resolve => { finish = resolve; })), store = journal();
  const client = new MobileMigrationClient(request, { [CREDENTIAL_SOURCES_CAPABILITY]: true }, store, () => current);
  const pending = client.call('credentialSources', params);
  if (invalidation === 'scope') current = false; else client.close();
  finish(result);
  await expect(pending).rejects.toMatchObject({ code: 'migration_scope_changed' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(store.put).not.toHaveBeenCalled();
});
