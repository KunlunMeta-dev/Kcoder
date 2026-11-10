import { afterEach, expect, it, vi } from 'vitest';
import { gatewayRequest } from './http';
import type { GatewayProfile } from './types';
const profile = { id: 'owned', label: 'owned', baseUrl: 'https://owned.invalid', accessToken: 'synthetic-test-token', expiresAt: Date.now() + 60000, rpcToken: 'synthetic-rpc' } as GatewayProfile;
afterEach(() => vi.unstubAllGlobals());
it('checks the source owner after asynchronous authorization and before a POST can be dispatched', async () => {
  let current = true; const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const result = gatewayRequest(profile, '/api/migration/source-session/open', { method: 'POST', body: '{}' }, { responseBytes: 1024, beforeDispatch() { if (!current) throw new Error('source_transfer_authority_changed'); } });
  current = false;
  await expect(result).rejects.toThrow('source_transfer_authority_changed'); expect(fetcher).not.toHaveBeenCalled();
});
it('bounds and cancels success and error response streams before JSON decoding', async () => {
  for (const status of [200, 500]) {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(100)); }, cancel() { cancelled++; } });
    const fetcher = vi.fn(async () => new Response(body, { status })); vi.stubGlobal('fetch', fetcher);
    await expect(gatewayRequest(profile, '/api/migration/source-transfer/read', { method: 'POST', body: '{}' }, { responseBytes: 32 })).rejects.toBeDefined();
    expect(cancelled).toBe(1); expect(fetcher).toHaveBeenCalledOnce();
  }
});
it('keeps POST failures single-attempt and rejects invalid local budgets before authorization or network', async () => {
  const fetcher = vi.fn(async () => { throw new Error('accepted response lost'); }); vi.stubGlobal('fetch', fetcher);
  await expect(gatewayRequest(profile, '/api/migration/source-transfer/adoption-prepare', { method: 'POST', body: '{}' }, { responseBytes: 1024 })).rejects.toBeDefined(); expect(fetcher).toHaveBeenCalledOnce();
  await expect(gatewayRequest(profile, '/api/migration/source-session/open', { method: 'POST' }, { responseBytes: 3 * 1024 * 1024 })).rejects.toThrow('Invalid bounded Gateway response budget'); expect(fetcher).toHaveBeenCalledOnce();
});
