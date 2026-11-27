import { describe, expect, test } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'

describe.each([Runtime, InstalledRuntime])('attachment-only messages', RuntimeClass => {
  test('accepts a picture as the first and subsequent input without invented user text', async () => {
    const client = new FakeGatewayClient('picture-thread')
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/workspace' },
      ],
      createClient: () => client,
    })
    try {
      const path = await runtime.saveAttachment({
        filename: 'picture.png',
        mimeType: 'image/png',
        bytes: [137, 80, 78, 71],
      })
      const executionRequest = {
        prompt: '',
        attachments: [{ local_path: path, filename: 'picture.png', mime_type: 'image/png' }],
      }
      const created = (await runtime.request('runtime.tasks.create', {
        taskId: 'picture-draft',
        executionRequest,
      })) as { taskId: string }
      await runtime.request('runtime.tasks.send', { taskId: created.taskId, executionRequest })
      const turns = client.requests.filter(request => request.method === 'turn/start')
      expect(turns).toHaveLength(2)
      for (const turn of turns) {
        const input = turn.params.input as Array<{ text: string }>
        expect(input[0].text).toContain('picture.png')
        expect(input[0].text).toContain('image/png')
      }
      await expect(
        runtime.request('runtime.tasks.create', {
          executionRequest: { prompt: '   ', attachments: [] },
        })
      ).rejects.toThrow('消息不能为空')
    } finally {
      await runtime.dispose()
    }
  })

  test('closes the transient connection if attachment validation fails before thread creation', async () => {
    const clients: FakeGatewayClient[] = []
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/workspace' },
      ],
      createClient: () => {
        const client = new FakeGatewayClient('thread')
        clients.push(client)
        return client
      },
    })
    try {
      await expect(
        runtime.request('runtime.tasks.create', {
          executionRequest: { prompt: 'image', attachments: [{ local_path: '/not-owned.png' }] },
        })
      ).rejects.toThrow('附件不属于')
      expect(clients.every(client => client.closed)).toBe(true)
      expect(
        clients
          .flatMap(client => client.requests)
          .some(request => request.method === 'thread/start')
      ).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })
})
