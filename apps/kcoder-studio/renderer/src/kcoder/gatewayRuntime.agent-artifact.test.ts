import { describe, expect, test } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

const OUTPUT_PATH = '/workspace/.kcoder/projects/p/sessions/s/subagents/agent-1/output.md'
const TRANSCRIPT_PATH = '/workspace/.kcoder/projects/p/sessions/s/subagents/agent-1/transcript.json'

function agentSummary(outputPath: string, transcriptPath: string) {
  return {
    agentId: 'agent-1',
    agentName: 'reviewer',
    status: 'completed',
    acceptingMessages: false,
    queueDepth: 0,
    outputPath,
    transcriptPath,
  }
}

/**
 * `agent/artifact/read` is not modelled by the shared fake client, so record the
 * whitelisted request and answer it locally instead of editing shared test support.
 */
function recordArtifactReads(client: FakeGatewayClient, response: Record<string, unknown>) {
  const reads: Array<Record<string, unknown>> = []
  const originalRequest = client.request.bind(client)
  client.request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'agent/artifact/read') {
      reads.push(params)
      return response as T
    }
    return originalRequest<T>(method, params)
  }
  return reads
}

async function createArtifactTask(runtime: ReturnType<typeof createTestGatewayRuntime>) {
  return (await runtime.request('runtime.tasks.create', {
    taskId: 'agent-artifact-draft',
    executionRequest: { prompt: 'delegate work' },
  })) as { taskId: string }
}

describe('KCoder gateway runtime subagent artifacts', () => {
  test('reads a report through the whitelisted RPC after matching agent/list paths', async () => {
    const client = new FakeGatewayClient('thread-agent-artifact')
    client.agentSummaries = [agentSummary(OUTPUT_PATH, TRANSCRIPT_PATH)]
    const reads = recordArtifactReads(client, {
      threadId: 'thread-agent-artifact',
      agentId: 'agent-1',
      kind: 'output',
      path: OUTPUT_PATH,
      name: 'output.md',
      content: '# report',
      size: 8,
      truncated: false,
      revision: 'deadbeef',
    })
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    const created = await createArtifactTask(runtime)

    const result = (await runtime.request('runtime.tasks.agent_artifact_read', {
      taskId: created.taskId,
      path: OUTPUT_PATH,
      kind: 'output',
    })) as Record<string, unknown>

    expect(result).toMatchObject({ content: '# report', name: 'output.md', truncated: false })
    expect(client.requests).toContainEqual({
      method: 'agent/list',
      params: { threadId: 'thread-agent-artifact' },
    })
    expect(reads).toEqual([
      { threadId: 'thread-agent-artifact', agentId: 'agent-1', kind: 'output' },
    ])
    expect(client.requests.filter(request => request.method === 'agent/artifact/read')).toEqual([])
  })

  test('matches the transcript artifact through transcriptPath', async () => {
    const windowsTranscriptPath =
      'C:\\Users\\x\\.kcoder\\projects\\p\\s\\subagents\\agent-1\\transcript.json'
    const client = new FakeGatewayClient('thread-agent-transcript')
    client.agentSummaries = [agentSummary(OUTPUT_PATH, windowsTranscriptPath)]
    const reads = recordArtifactReads(client, {
      threadId: 'thread-agent-transcript',
      agentId: 'agent-1',
      kind: 'transcript',
      path: windowsTranscriptPath,
      name: 'transcript.json',
      content: '[]',
      size: 2,
      truncated: false,
      revision: 'cafebabe',
    })
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    const created = await createArtifactTask(runtime)

    await expect(
      runtime.request('runtime.tasks.agent_artifact_read', {
        taskId: created.taskId,
        path: windowsTranscriptPath.replace(/\\/g, '/'),
        kind: 'transcript',
      })
    ).resolves.toMatchObject({ content: '[]', name: 'transcript.json' })
    expect(reads).toEqual([
      { threadId: 'thread-agent-transcript', agentId: 'agent-1', kind: 'transcript' },
    ])
  })

  test('fails closed when the app-server omits agentArtifactsV1', async () => {
    const client = new FakeGatewayClient('thread-no-artifacts')
    client.supportsExperimental = capability => capability !== 'agentArtifactsV1'
    client.agentSummaries = [agentSummary(OUTPUT_PATH, TRANSCRIPT_PATH)]
    const reads = recordArtifactReads(client, { content: 'must not be read' })
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    const created = await createArtifactTask(runtime)

    await expect(
      runtime.request('runtime.tasks.agent_artifact_read', {
        taskId: created.taskId,
        path: OUTPUT_PATH,
        kind: 'output',
      })
    ).rejects.toThrow('不支持 subagent 报告读取')
    expect(reads).toEqual([])
    expect(client.requests.filter(request => request.method === 'agent/artifact/read')).toEqual([])
  })

  test('falls back when the path is not published by agent/list', async () => {
    const client = new FakeGatewayClient('thread-unknown-artifact')
    client.agentSummaries = [
      agentSummary('/workspace/other/subagents/agent-9/output.md', '/workspace/other/x.json'),
    ]
    const reads = recordArtifactReads(client, { content: 'must not be read' })
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    const created = await createArtifactTask(runtime)

    await expect(
      runtime.request('runtime.tasks.agent_artifact_read', {
        taskId: created.taskId,
        path: OUTPUT_PATH,
        kind: 'output',
      })
    ).rejects.toThrow('未找到对应的 subagent 报告')
    expect(reads).toEqual([])
    expect(client.requests.filter(request => request.method === 'agent/artifact/read')).toEqual([])
  })
})
