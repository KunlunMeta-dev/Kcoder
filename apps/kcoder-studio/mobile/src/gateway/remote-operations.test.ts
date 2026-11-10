import { describe, expect, it, vi } from 'vitest';
import { MobileRemoteOperations } from './remote-operations';
import type { GatewayRpcClient } from './rpc';
import type { GatewayProfile, KCoderServer } from './types';
const scope = { accountId: 'a', targetId: 't', workspaceId: 'w', identityGeneration: 'g', targetRevision: 'r' };
describe('mobile original remote control', () => {
  it('legacy capability absence sends zero requests', async () => {
    const request = vi.fn();
    const client = { matchesRuntimeOwner: () => true, supportsExperimental: () => false, request } as unknown as GatewayRpcClient;
    const controls = new MobileRemoteOperations(client, {} as GatewayProfile, {} as KCoderServer, '/owned');
    await expect(controls.read('read', 'original')).rejects.toMatchObject({ code: 'REMOTE_CONTROL_UPGRADE_REQUIRED' });
    expect(request).not.toHaveBeenCalled();
  });
  it('lost cancellation remains unknown and the original is read without replay', async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'integrations/scope/read') return scope;
      if (method.endsWith('cancelOperation')) throw new Error('lost receipt');
      return { requestId: params.requestId, scope, operationId: 'original', outcome: 'observed', snapshot: null };
    });
    const client = { matchesRuntimeOwner: () => true, supportsExperimental: () => true, request } as unknown as GatewayRpcClient;
    const controls = new MobileRemoteOperations(client, {} as GatewayProfile, {} as KCoderServer, '/owned');
    await expect(controls.cancel('same-cancel-request', 'original', 2)).rejects.toMatchObject({ uncertain: true });
    await expect(controls.read('read-original', 'original')).resolves.toMatchObject({ operationId: 'original' });
    expect(request.mock.calls.filter(([method]) => method.endsWith('cancelOperation'))).toHaveLength(1);
  });
});
