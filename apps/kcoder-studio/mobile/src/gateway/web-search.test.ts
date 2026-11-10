import { expect, test, vi } from 'vitest';
import { MobileWebSearchDiagnostics } from './web-search';
const status = { targetId: 'target', revision: 'r1', mode: 'kcoder', automatic: true, webSearchVisible: true, webFetchVisible: false, candidates: ['exa-public'], observations: [] };
test('old target diagnostics are hidden and cannot block ordinary requests', async () => {
  const request = vi.fn();
  const client = new MobileWebSearchDiagnostics({ request, supportsExperimental: () => false }, () => true);
  await expect(client.status({ mode: 'kcoder' })).rejects.toThrow('UNSUPPORTED');
  expect(request).not.toHaveBeenCalled();
});
test('read uses the original identity and rejects late target completion', async () => {
  let current = true;
  const request = vi.fn().mockResolvedValue(status);
  const client = new MobileWebSearchDiagnostics({ request, supportsExperimental: () => true }, () => current);
  await expect(client.status({ mode: 'kcoder' })).resolves.toEqual(status);
  request.mockImplementation(async () => { current = false; return status; });
  await expect(client.status({ mode: 'kcoder' })).rejects.toThrow('TARGET_CHANGED');
  current = true;
  request.mockResolvedValue({ targetId: 'target', revision: 'r1', requestId: 'probe-1', state: 'unknown' });
  await expect(client.read({ requestId: 'probe-1', expectedRevision: 'r1' })).resolves.toMatchObject({ state: 'unknown' });
  expect(request).toHaveBeenLastCalledWith('webSearch/probe/read', { requestId: 'probe-1', expectedRevision: 'r1' });
  expect(request.mock.calls.every(call => call[0] !== 'webSearch/probe/start')).toBe(true);
});
