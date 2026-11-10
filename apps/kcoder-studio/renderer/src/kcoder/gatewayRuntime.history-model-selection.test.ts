import { describe, expect, test } from 'vitest'
import { KCoderGatewayRuntime as CoreRuntime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'

describe.each([CoreRuntime, InstalledRuntime])('history preserves the authoritative task model', Runtime => {
  test('polling cannot replace a persisted explicit selection with bootstrap or display metadata', async () => {
    localStorage.clear()
    const client = new FakeGatewayClient(null)
    client.threadResumeSupported = true
    const thread = {
      id: 'original-task', cwd: '/workspace', status: 'idle',
      model: 'target-default::other-model', modelSelectionMode: 'explicit',
      selectedModel: 'original-provider::original-model',
      metadata: { schema: 'kcoder.thread-metadata', version: 1, revision: 1,
        title: 'Original task', model: null as string | null, archivedAt: null, parent: null },
    }
    client.persistedThreads = [thread]
    const runtime = new Runtime('token', {
      loadServers: async () => [{ id: 'local', label: 'Owned', transport: 'local', workspacePath: '/workspace' }],
      createClient: () => client,
    })
    try {
      for (const metadataModel of [null, 'stale-display::model']) {
        thread.metadata.model = metadataModel
        const listed = await runtime.request('runtime.tasks.list', {}) as {
          workspaces: { tasks: { threadId: string; model?: string }[] }[]
        }
        const task = listed.workspaces.flatMap(workspace => workspace.tasks)
          .find(task => task.threadId === 'original-task')
        expect(task?.model).toBe('original-provider::original-model')
      }
      expect(client.requests.some(request => ['thread/metadata/update', 'turn/start', 'thread/model/select']
        .includes(request.method))).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })
})
