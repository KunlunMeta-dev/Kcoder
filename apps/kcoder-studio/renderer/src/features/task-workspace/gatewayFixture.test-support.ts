import { vi } from 'vitest'
import { KCoderGatewayRuntime } from '@/kcoder/gatewayRuntime'
import { FakeGatewayClient } from '@/kcoder/gateway/runtime/contractFixture.test-support'
import { createGatewayIpcHandler } from '@/kcoder/gatewayRuntimeInstall'
import { registerGatewayCommandTransport } from '@/kcoder/gatewayServiceBridge'
import type {
  IntegrationReply,
  IntegrationScope,
  TaskWorkspaceSnapshot,
} from '../../../../shared/generated/contracts'

export const nativeScope: IntegrationScope = {
  accountId: 'owned-account',
  targetId: 'native-target',
  workspaceId: 'native-workspace',
  identityGeneration: 'generation-1',
  targetRevision: 'target-1',
}
export const localServer = {
  id: 'local',
  label: 'Owned local',
  description: '',
  transport: 'local' as const,
  runtime: 'kcoder' as const,
  workspacePath: '/owned-workspace',
}
export const taskMethod = 'integrations/tasks/readWorkspace'
export function snapshot(
  threadId = 'original-thread',
  partial: Partial<TaskWorkspaceSnapshot> = {}
): TaskWorkspaceSnapshot {
  return {
    schemaVersion: 1,
    scope: structuredClone(nativeScope),
    snapshotId: 'original-observation',
    observedAtMs: 1792843200000,
    thread: {
      reference: { kind: 'thread', threadId },
      title: 'Original task',
      nativeStatus: 'notLoaded',
      sourceMethod: 'thread/read',
      nativeRevision: null,
    },
    entries: [
      {
        reference: { kind: 'goal', threadId, goalId: 'original-goal', revision: 3 },
        title: 'Original goal',
        nativeStatus: 'running',
        sourceMethod: 'goal/get',
        nativeRevision: '3',
      },
      {
        reference: { kind: 'agent', threadId, agentId: 'original-agent', backgroundRun: null },
        title: 'Observed agent',
        nativeStatus: 'future_agent_state',
        sourceMethod: 'agent/list',
        nativeRevision: null,
      },
      {
        reference: {
          kind: 'workflow_run',
          threadId,
          runId: 'original-run',
          revision: 2,
          definitionRef: null,
        },
        title: 'Original workflow',
        nativeStatus: 'succeeded',
        sourceMethod: 'workflow/runs/read',
        nativeRevision: '2',
      },
    ],
    facets: [
      { kind: 'thread', availability: 'available', observedCount: 1, reasonCode: null },
      {
        kind: 'agents',
        availability: 'unknown',
        observedCount: null,
        reasonCode: 'HISTORICAL_AGENTS_UNKNOWN',
      },
    ],
    artifactRefs: [],
    runtime: null,
    sourceSelection: null,
    nextCursor: null,
    ...partial,
  }
}
export function reply(
  request: Record<string, unknown>,
  result: unknown = snapshot(
    String((request.payload as { threadId?: string } | undefined)?.threadId ?? 'original-thread')
  )
): IntegrationReply {
  return {
    contractVersion: 'parallel-v1',
    requestId: String(request.requestId),
    operationId: null,
    entityRevision: null,
    status: 'completed',
    observedAt: '2026-10-24T12:00:00Z',
    result: result as Record<string, unknown>,
    error: null,
  }
}
type NativeHandler = (
  method: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) => Promise<unknown>

/** Real LocalExecutor IPC, Gateway service and finite control handler; native frames are protocol fixtures. */
export function installTaskWorkspaceGateway(
  handler?: NativeHandler,
  additionalReadMethods: string[] = []
) {
  const client = new FakeGatewayClient(null)
  const original = client.request.bind(client)
  const calls: { method: string; params: Record<string, unknown>; signal?: AbortSignal }[] = []
  const supported = vi.spyOn(client, 'supportsExperimental').mockReturnValue(true)
  client.request = async <T>(
    method: string,
    params: Record<string, unknown> = {},
    options?: { signal?: AbortSignal }
  ): Promise<T> => {
    if (
      method === 'integrations/scope/read' ||
      method === taskMethod ||
      additionalReadMethods.includes(method)
    ) {
      calls.push({ method, params: structuredClone(params), signal: options?.signal })
      if (handler) return (await handler(method, params, options)) as T
      return (
        method === 'integrations/scope/read' ? structuredClone(nativeScope) : reply(params)
      ) as T
    }
    if (['thread/start', 'thread/resume', 'turn/start'].includes(method))
      throw new Error('Read-only task workspace cannot execute a model or activate a task')
    return original<T>(method, params)
  }
  const runtime = new KCoderGatewayRuntime('owned-protocol-fixture', {
    loadServers: async () => [localServer],
    createClient: () => client,
  })
  const stop = registerGatewayCommandTransport(createGatewayIpcHandler(runtime))
  return {
    client,
    calls,
    supported,
    runtime,
    async dispose() {
      stop()
      await runtime.disposeAsync()
    },
  }
}
