import { isContract } from '../../../../shared/generated/validator.mjs'
import { requestLocalExecutor } from '@/host/localExecutor'
import { NativeIntegrationClientError } from '@/kcoder/gatewayIntegrations'
import type { KnowledgeIntegrationTransport } from '@/features/knowledge-integration/client'
import { nativeMemoryTransport } from './memoryTransport'

/** The public target controls expose a fixed subset, never an arbitrary Port. */
export function nativeKnowledgeTransport(target: { serverId: string; workspacePath?: string }): KnowledgeIntegrationTransport {
  const memory = nativeMemoryTransport(target)
  const send: KnowledgeIntegrationTransport['call'] = (port, method, request, signal) => {
    if (port === 'P-MEMORY' || port === 'P-RUNTIME') return memory.call(port, method, request, signal)
    if (port === 'P-CONNECTION' && ['listConnections', 'readResourceGrant'].includes(method))
      return requestLocalExecutor('runtime.integrations.request', { ...target, method: `integrations/connectivity/${method}`, params: request }, { signal })
    const domain = port === 'P-KNOWLEDGE' ? 'knowledge' : port === 'P-AUTOMATION' ? 'automation' : null
    if (!domain) return Promise.reject(new NativeIntegrationClientError('INTEGRATION_METHOD_UNAVAILABLE'))
    const wire = `integrations/${domain}/${method}`
    if (!isContract(domain === 'knowledge' ? 'IntegrationKnowledgeMethod' : 'IntegrationAutomationMethod', wire))
      return Promise.reject(new NativeIntegrationClientError('INTEGRATION_METHOD_UNAVAILABLE'))
    return requestLocalExecutor('runtime.integrations.request', { ...target, method: wire, params: request }, { signal })
  }
  return {
    call: send,
    management: (domain, method, request, signal) =>
      send(domain === 'memory' ? 'P-MEMORY' : domain === 'knowledge' ? 'P-KNOWLEDGE' : 'P-AUTOMATION', method, request, signal),
  }
}
