import { vi } from 'vitest'
import { KCoderGatewayRuntime } from '@/kcoder/gatewayRuntime'
import { FakeGatewayClient } from '@/kcoder/gateway/runtime/contractFixture.test-support'
import { createGatewayIpcHandler } from '@/kcoder/gatewayRuntimeInstall'
import { registerGatewayCommandTransport } from '@/kcoder/gatewayServiceBridge'
import type { WorkflowDefinition } from '@/features/workflows/workflowApi'
import type { WorkflowCollaborationCatalogResult } from '../../../../../shared/generated/contracts'
import { localServer } from '../gatewayFixture.test-support'

export function catalog(threadId?: string): WorkflowCollaborationCatalogResult {
  return {
    schemaVersion: 1,
    roles: (['researcher', 'planner', 'writer', 'reviewer', 'verifier'] as const).map(role => ({
      role,
      agentType: role === 'writer' ? 'general' : role === 'verifier' ? 'verifier' : 'explore',
      instructions: `Original native ${role} preset`,
      outputSchema: { type: 'object' },
      resultCheck: { source: 'return result.accepted === true;', timeoutMs: 1000 },
    })),
    tools: [
      { name: 'read', registered: true, readOnly: true },
      { name: 'write', registered: true, readOnly: false },
    ],
    modelOrigin: threadId ? 'thread_unobserved' : 'execution_parent',
    threadId: threadId ?? null,
    modelSnapshot: null,
  }
}
export function definition(partial: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'original-created-draft',
    title: 'Owned collaboration',
    description: '',
    revision: 1,
    status: 'draft',
    nodes: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    savedVersion: null,
    ...partial,
  }
}
export function prepared(): WorkflowDefinition {
  return definition({
    revision: 2,
    updatedAtMs: 2,
    nodes: [
      {
        kind: 'agent',
        id: 'native-research',
        title: 'Native research',
        prompt: 'Original preset',
        agentType: 'explore',
        maxTurns: 20,
        dependsOn: [],
        position: { x: 0, y: 0 },
        allowedWritePaths: [],
        acceptanceCriteria: ['Evidence'],
        expectedArtifacts: [],
      },
    ],
  })
}
type Handler = (
  method: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) => Promise<unknown>

/** Exercises the real LocalExecutor/Gateway boundary with native protocol frames. */
export function installCollaborationGateway(handler?: Handler) {
  const client = new FakeGatewayClient(null)
  const original = client.request.bind(client)
  const calls: { method: string; params: Record<string, unknown>; signal?: AbortSignal }[] = []
  const supports = vi.spyOn(client, 'supportsExperimental').mockReturnValue(true)
  let stored = definition()
  client.request = async <T>(
    method: string,
    params: Record<string, unknown> = {},
    options?: { signal?: AbortSignal }
  ): Promise<T> => {
    if (method.startsWith('workflow/')) {
      calls.push({ method, params: structuredClone(params), signal: options?.signal })
      if (handler) return (await handler(method, params, options)) as T
      if (method === 'workflow/collaboration/catalog')
        return catalog(params.threadId as string | undefined) as T
      if (method === 'workflow/create') return stored as T
      if (method === 'workflow/collaboration/apply') {
        stored = prepared()
        return stored as T
      }
      if (method === 'workflow/save') {
        stored = { ...stored, status: 'saved', savedVersion: 1, revision: 3, updatedAtMs: 3 }
        return stored as T
      }
      if (method === 'workflow/read') return stored as T
      throw new Error('Unexpected authoring operation')
    }
    if (['thread/start', 'thread/resume', 'turn/start'].includes(method))
      throw new Error('Authoring cannot execute a task or select a model')
    return original<T>(method, params)
  }
  const runtime = new KCoderGatewayRuntime('owned-authoring-fixture', {
    loadServers: async () => [localServer],
    createClient: () => client,
  })
  const stop = registerGatewayCommandTransport(createGatewayIpcHandler(runtime))
  return {
    calls,
    client,
    supports,
    async dispose() {
      stop()
      await runtime.disposeAsync()
    },
  }
}
