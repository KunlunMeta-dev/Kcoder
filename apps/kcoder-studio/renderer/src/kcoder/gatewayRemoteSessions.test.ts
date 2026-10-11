import { describe, expect, test, vi } from 'vitest'
import type { GatewayServer } from './gatewayRpc'
import { GatewayRemoteSessions } from './gatewayRemoteSessions'
import type { GatewayClient } from './gatewayRuntimeTypes'

const server: GatewayServer = {
  id: 'local',
  label: '本机',
  description: '本机',
  runtime: 'kcoder',
  transport: 'local',
  workspacePath: '/workspace',
}

class TerminalClient extends EventTarget {
  closeFailure: Error | null = null
  readonly request = vi.fn(async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (method === 'terminal/start') {
      return { session_id: 'wire-terminal', cwd: '/workspace' } as T
    }
    if (method === 'terminal/close' && this.closeFailure) throw this.closeFailure
    if (method === 'terminal/attach') {
      return {
        session_id: params.session_id,
        cwd: '/workspace',
        transcript: 'restored prompt$ ',
      } as T
    }
    return {} as T
  })
  close() {}
  supportsExperimental() {
    return true
  }
}

class AttachmentClient extends EventTarget {
  readonly request = vi.fn(async <T>(method: string) => {
    if (method === 'attachment/upload/start') return { upload_id: 'upload-large' } as T
    if (method === 'attachment/upload/finish') return { path: '/tmp/large.bin' } as T
    if (method === 'attachment/upload/chunk') return {} as T
    return {} as T
  })
  close() {}
  supportsExperimental() {
    return true
  }
}

async function terminalFixture() {
  const client = new TerminalClient()
  const sessions = new GatewayRemoteSessions({
    resolveServer: async () => server,
    commandClient: async () => client as unknown as GatewayClient,
  })
  const session = await sessions.startTerminal('local', '/workspace')
  return { client, sessions, session }
}

describe('Gateway remote terminal lifecycle and buffering', () => {
  test('uploads attachments larger than one RPC through ordered chunks', async () => {
    const client = new AttachmentClient()
    const sessions = new GatewayRemoteSessions({
      resolveServer: async () => server,
      commandClient: async () => client as unknown as GatewayClient,
    })
    const bytes = Array.from({ length: 300 * 1024 }, (_, index) => index % 251)

    const path = await sessions.saveAttachment({
      filename: 'large.bin',
      mimeType: 'application/octet-stream',
      bytes,
    })

    expect(path).toBe('/tmp/large.bin')
    expect(client.request).toHaveBeenNthCalledWith(1, 'attachment/upload/start', {
      filename: 'large.bin',
      size: bytes.length,
    })
    const chunks = client.request.mock.calls.filter(
      ([method]) => method === 'attachment/upload/chunk'
    )
    expect(chunks).toHaveLength(2)
    expect(chunks.map(([, params]) => params.index)).toEqual([0, 1])
    expect(client.request.mock.calls.at(-1)).toEqual([
      'attachment/upload/finish',
      { upload_id: 'upload-large' },
    ])
    await expect(sessions.readAttachment({ deviceId: 'local', path })).resolves.toMatchObject({
      size: bytes.length,
    })
  })

  test('streams browser attachment uploads without buffering the whole file', async () => {
    const client = new AttachmentClient()
    const sessions = new GatewayRemoteSessions({
      resolveServer: async () => server,
      commandClient: async () => client as unknown as GatewayClient,
    })

    const started = await sessions.startAttachmentUpload({
      filename: 'photo.png',
      mimeType: 'image/png',
      fileSize: 6,
    })
    await sessions.appendAttachmentUpload({
      uploadId: started.uploadId,
      index: 0,
      contentBase64: 'AQID',
    })
    await sessions.appendAttachmentUpload({
      uploadId: started.uploadId,
      index: 1,
      contentBase64: 'BAUG',
    })
    const finished = await sessions.finishAttachmentUpload({ uploadId: started.uploadId })

    expect(finished).toEqual({ path: '/tmp/large.bin', deviceId: 'local' })
    expect(client.request).toHaveBeenNthCalledWith(1, 'attachment/upload/start', {
      filename: 'photo.png',
      size: 6,
    })
    expect(client.request).toHaveBeenNthCalledWith(2, 'attachment/upload/chunk', {
      upload_id: 'upload-large',
      index: 0,
      content_base64: 'AQID',
    })
    await expect(
      sessions.readAttachment({ deviceId: 'local', path: '/tmp/large.bin' })
    ).resolves.toMatchObject({ contentBase64: 'AQIDBAUG', size: 6 })
  })

  test('restores a persisted terminal descriptor through terminal/attach', async () => {
    const client = new TerminalClient()
    const commandClient = vi.fn(async () => client as unknown as GatewayClient)
    const sessions = new GatewayRemoteSessions({
      resolveServer: async () => server,
      commandClient,
    })
    const publicSessionId = 'gateway-terminal:local:persisted-terminal'

    const restored = await sessions.restoreTerminal('local', '/workspace', publicSessionId)

    expect(restored.session_id).toBe(publicSessionId)
    expect(commandClient).toHaveBeenCalledWith(server, '/workspace')
    expect(client.request).toHaveBeenCalledWith('terminal/attach', {
      session_id: 'persisted-terminal',
      rows: 24,
      cols: 80,
    })
    const output = vi.fn()
    const remote = sessions.createTerminalClient(publicSessionId)
    remote.onOutput(output)
    await remote.attach()
    expect(output).toHaveBeenCalledWith({
      session_id: publicSessionId,
      data: 'restored prompt$ ',
    })
  })

  test('cleans a rejected close, ignores stale output, and permits authoritative wire reuse', async () => {
    const { client, sessions, session } = await terminalFixture()
    const remote = sessions.createTerminalClient(session.session_id)
    const output = vi.fn()
    remote.onOutput(output)
    client.closeFailure = new Error('terminal close failed')

    await expect(remote.close()).rejects.toThrow('terminal close failed')
    expect(() => sessions.createTerminalClient(session.session_id)).toThrow('不存在')
    expect(
      sessions.handleNotification(
        'terminal/output',
        { session_id: 'wire-terminal', data: 'stale' },
        'local'
      )
    ).toBe(true)
    expect(output).not.toHaveBeenCalled()
    const reused = await sessions.startTerminal('local', '/workspace')
    const reusedOutput = vi.fn()
    const reusedClient = sessions.createTerminalClient(reused.session_id)
    reusedClient.onOutput(reusedOutput)
    sessions.handleNotification(
      'terminal/output',
      { session_id: 'wire-terminal', data: 'fresh' },
      'local'
    )
    expect(reusedOutput).toHaveBeenCalledWith({ session_id: reused.session_id, data: 'fresh' })
    expect(output).not.toHaveBeenCalled()
  })

  test('caps one oversized terminal packet to the newest 256 KiB', async () => {
    const { sessions, session } = await terminalFixture()
    sessions.handleNotification(
      'terminal/output',
      { session_id: 'wire-terminal', data: 'A'.repeat(300 * 1024) },
      'local'
    )
    const output: string[] = []
    const remote = sessions.createTerminalClient(session.session_id)
    remote.onOutput(payload => output.push(payload.data))
    await remote.attach()

    expect(output.join('')).toBe('A'.repeat(256 * 1024))
  })

  test('evicts the oldest bytes across multiple terminal packets while preserving order', async () => {
    const { sessions, session } = await terminalFixture()
    sessions.handleNotification(
      'terminal/output',
      { session_id: 'wire-terminal', data: 'A'.repeat(200 * 1024) },
      'local'
    )
    sessions.handleNotification(
      'terminal/output',
      { session_id: 'wire-terminal', data: 'B'.repeat(100 * 1024) },
      'local'
    )
    const output: string[] = []
    const remote = sessions.createTerminalClient(session.session_id)
    remote.onOutput(payload => output.push(payload.data))
    await remote.attach()

    expect(output).toEqual(['A'.repeat(156 * 1024), 'B'.repeat(100 * 1024)])
  })

  test('never cuts a multibyte UTF-8 character at the terminal buffer boundary', async () => {
    const { sessions, session } = await terminalFixture()
    sessions.handleNotification(
      'terminal/output',
      { session_id: 'wire-terminal', data: '你'.repeat(100_000) },
      'local'
    )
    const output: string[] = []
    const remote = sessions.createTerminalClient(session.session_id)
    remote.onOutput(payload => output.push(payload.data))
    await remote.attach()
    const retained = output.join('')

    expect(new TextEncoder().encode(retained)).toHaveLength(262_143)
    expect(retained).toBe('你'.repeat(87_381))
    expect(retained).not.toContain('\ufffd')
  })
})
