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
    if (method === 'terminal/close') return { closed: true } as T
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
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      'attachment/upload/chunk',
      {
        upload_id: 'upload-large',
        index: 0,
        content_base64: 'AQID',
      },
      { signal: expect.any(AbortSignal) }
    )
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

  test('retains a rejected close until explicit retry, then ignores stale output and permits authoritative wire reuse', async () => {
    const { client, sessions, session } = await terminalFixture()
    const remote = sessions.createTerminalClient(session.session_id)
    const output = vi.fn()
    remote.onOutput(output)
    client.closeFailure = new Error('terminal close failed')

    await expect(remote.close()).rejects.toThrow('terminal close failed')
    expect(() => sessions.createTerminalClient(session.session_id)).not.toThrow()
    await remote.write('must not run after an unconfirmed close')
    expect(client.request.mock.calls.some(([method]) => method === 'terminal/write')).toBe(false)
    client.closeFailure = null
    await remote.close()
    expect(client.request.mock.calls.filter(([method]) => method === 'terminal/close')).toHaveLength(2)
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

  test('an unknown terminal exit stops input but preserves ownership for cleanup retry', async () => {
    const { client, sessions, session } = await terminalFixture()
    const remote = sessions.createTerminalClient(session.session_id), exited = vi.fn()
    remote.onExit(exited)
    sessions.handleNotification('terminal/exit', { session_id: 'wire-terminal', exit_code: null }, 'local')
    expect(exited).toHaveBeenCalledExactlyOnceWith({ session_id: session.session_id, exit_code: null })
    await remote.write('ignored')
    await remote.resize(30, 100)
    expect(client.request.mock.calls.some(([method]) => method === 'terminal/write' || method === 'terminal/resize')).toBe(false)
    await remote.close()
    expect(client.request).toHaveBeenLastCalledWith('terminal/close', { session_id: 'wire-terminal' })
    expect(() => sessions.createTerminalClient(session.session_id)).toThrow('不存在')
  })

  test('a confirmed terminal exit is not downgraded by a duplicated unknown event', async () => {
    const { sessions, session } = await terminalFixture()
    const remote = sessions.createTerminalClient(session.session_id), exited = vi.fn()
    remote.onExit(exited)
    sessions.handleNotification('terminal/exit', { session_id: 'wire-terminal', exit_code: 0 }, 'local')
    sessions.handleNotification('terminal/exit', { session_id: 'wire-terminal', exit_code: null }, 'local')
    expect(exited).toHaveBeenCalledExactlyOnceWith({ session_id: session.session_id, exit_code: 0 })
  })

  test('a missing or negative close receipt cannot discard an unknown terminal owner', async () => {
    const { client, sessions, session } = await terminalFixture()
    const remote = sessions.createTerminalClient(session.session_id)
    sessions.handleNotification('terminal/exit', { session_id: 'wire-terminal', exit_code: null }, 'local')
    for (const value of [{ closed: false }, {}]) {
      client.request.mockResolvedValueOnce(value)
      await expect(remote.close()).rejects.toThrow()
      expect(() => sessions.createTerminalClient(session.session_id)).not.toThrow()
    }
    await remote.close()
    expect(() => sessions.createTerminalClient(session.session_id)).toThrow('不存在')
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
