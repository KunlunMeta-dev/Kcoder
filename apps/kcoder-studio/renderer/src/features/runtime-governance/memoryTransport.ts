import { requestLocalExecutor } from '@/host/localExecutor'
import type { KnowledgeIntegrationTransport } from '@/features/knowledge-integration/client'
import { NativeIntegrationClientError } from '@/kcoder/gatewayIntegrations'

export function nativeMemoryTransport(target: { serverId: string; workspacePath?: string }): KnowledgeIntegrationTransport {
  const routes: Record<string, string> = {
    listMemories: 'integrations/memory/list', readMemory: 'integrations/memory/read',
    readMemoryTaskSnapshot: 'integrations/memory/readTaskSnapshot',
    proposeMemory: 'integrations/memory/propose', reviewMemory: 'integrations/memory/review',
    setMemoryEnabled: 'integrations/memory/setEnabled', editMemory: 'integrations/memory/edit',
    removeMemory: 'integrations/memory/forget',
  }
  const send: KnowledgeIntegrationTransport['call'] = async (port, method, request, signal) => {
    if (port === 'P-RUNTIME' && method === 'readOperation') {
      return requestLocalExecutor('runtime.integrations.request', { ...target, method: 'integrations/operation/read', params: request }, { signal })
    }
    if (port !== 'P-MEMORY' || !Object.hasOwn(routes, method)) throw new NativeIntegrationClientError('INTEGRATION_METHOD_UNAVAILABLE')
    return requestLocalExecutor('runtime.integrations.request', { ...target, method: routes[method], params: request }, { signal })
  }
  return {
    call: send,
    management: (domain, method, request, signal) => {
      if (domain !== 'memory') return Promise.reject(new NativeIntegrationClientError('INTEGRATION_METHOD_UNAVAILABLE'))
      return send('P-MEMORY', method, request, signal)
    },
  }
}
