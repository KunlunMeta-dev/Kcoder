import { expect, it, vi } from 'vitest';
import { MobileMigrationClient } from '../migration-client';
import { validDefinitionCall } from '../../../../shared/migrationDefinitions';
const item = { jobId: 'mig-owned', itemId: 'agent-owned' };
const body = { ...item, offset: 0, encoding: 'utf8', text: '<script>CANARY</script>', bytesBase64: btoa('<script>CANARY</script>'), totalBytes: 23, nextOffset: null, sha256: 'a'.repeat(64) };
const store = { read: async () => [], put: async () => {} };
it('uses the independent capability and never dispatches paths or source bodies on opening an old target', async () => {
  const request = vi.fn(); const client = new MobileMigrationClient(request, { migrationAssetsV1: true }, store, () => true);
  expect(client.supports('definitionsDiscover')).toBe(false);
  await expect(client.call('definitionsDiscover', { sources: ['codex'], pageIndex: 0 })).rejects.toMatchObject({ code: 'migration_update_required' }); expect(request).not.toHaveBeenCalled();
});
it('binds a read to the original job/item and keeps literal markup outside durable intent metadata', async () => {
  const request = vi.fn(async () => body), put = vi.fn(); const client = new MobileMigrationClient(request, { migrationDefinitionsV1: true }, { read: async () => [], put }, () => true);
  const value = await client.call('definitionBody', item); expect(value.text).toBe('<script>CANARY</script>'); expect(put).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({ ...body, itemId: 'peer' }); await expect(client.call('definitionBody', item)).rejects.toMatchObject({ code: 'migration_invalid_response' });
  await expect(client.call('definitionBody', { ...item, path: '/private' } as never)).rejects.toMatchObject({ code: 'migration_invalid_parameters' }); expect(request).toHaveBeenCalledTimes(2);
});
it('never declares an executable report compatible and bounds fields and decoded bytes', () => {
  const report = { ...item, pageIndex: 0, report: { kind: 'hook', format: 'codex_hooks_json', parseStatus: 'opaque', fields: [], elements: null, unknownFields: null, executionAllowed: false, requiresReview: true }, totalFields: 0, nextPage: null, totalBytes: 3 };
  expect(validDefinitionCall('migration/definitions/report', item, report)).toBe(true);
  expect(validDefinitionCall('migration/definitions/report', item, { ...report, report: { ...report.report, executionAllowed: true } })).toBe(false);
  expect(validDefinitionCall('migration/definitions/body', item, { ...body, bytesBase64: btoa('x'.repeat(17000)), text: 'x'.repeat(17000), totalBytes: 17000 })).toBe(false);
});
