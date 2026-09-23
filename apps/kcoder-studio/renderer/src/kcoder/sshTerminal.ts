import type { RemoteTerminalClient } from '@/lib/remote-terminal-socket'
import { gatewayToken } from './gatewayRpc'

export interface SshConnectionProfile {
  id: string
  label: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'key' | 'agent'
  privateKeyPath?: string
  passwordSaved?: boolean
}

export type SshConnectionUpdate = Omit<SshConnectionProfile, 'passwordSaved'> & {
  password?: string | null
}

async function profilesRequest(path = '', method = 'GET', body?: SshConnectionUpdate) {
  const response = await fetch(`/api/ssh-connections${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(method !== 'GET' ? { headers: { 'content-type': 'application/json' } } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new Error(`SSH settings request failed (HTTP ${response.status})`)
  return response.json()
}

export async function listSshConnections(): Promise<SshConnectionProfile[]> {
  return (await profilesRequest()).connections
}

export async function saveSshConnection(
  profile: SshConnectionUpdate
): Promise<SshConnectionProfile> {
  return (await profilesRequest(`/${encodeURIComponent(profile.id)}`, 'PUT', profile)).connection
}

export async function deleteSshConnection(id: string): Promise<void> {
  await profilesRequest(`/${encodeURIComponent(id)}`, 'DELETE')
}

export interface SshConnectResult {
  status: 'connected' | 'host-key-required'
  fingerprint?: string
  host?: string
  port?: number
  title?: string
}

export interface SshCredentials {
  password?: string
  passphrase?: string
  acceptFingerprint?: string
}

// This channel never goes through a task runtime or the terminal-context store.
export class SshTerminalConnection {
  private socket: WebSocket | null = null
  private opening: Promise<void> | null = null
  private sequence = 0
  private disposed = false
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private outputHandlers = new Set<(data: string) => void>()
  private exitHandlers = new Set<() => void>()
  private output = ''
  private exited = false

  private readonly onDisconnected: () => void

  constructor(onDisconnected: () => void = () => {}) {
    this.onDisconnected = onDisconnected
  }

  private async open() {
    if (this.disposed) throw new Error('SSH terminal is closed')
    if (this.opening) return this.opening
    this.opening = new Promise<void>((resolve, reject) => {
      const token = gatewayToken()
      if (!token) {
        reject(new Error('SSH terminal requires a KCoder Gateway'))
        return
      }
      const url = new URL('/rpc', window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('token', token)
      url.searchParams.set('channel', 'ssh-terminal')
      const socket = new WebSocket(url)
      this.socket = socket
      const timer = setTimeout(() => socket.close(), 10_000)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('SSH Gateway connection failed'))
      }
      socket.onclose = () => {
        clearTimeout(timer)
        reject(new Error('SSH Gateway disconnected'))
        this.disposed = true
        for (const request of this.pending.values()) {
          clearTimeout(request.timer)
          request.reject(new Error('SSH Gateway disconnected'))
        }
        this.pending.clear()
        this.markExited()
      }
      socket.onmessage = event => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          socket.close()
          return
        }
        if (typeof message.id === 'number') {
          const request = this.pending.get(message.id)
          if (!request) return
          clearTimeout(request.timer)
          this.pending.delete(message.id)
          if (message.error)
            request.reject(new Error(message.error.message || 'SSH request failed'))
          else request.resolve(message.result)
        } else if (message.method === 'ssh/output' && typeof message.params?.data === 'string') {
          const data = message.params.data
          if (this.outputHandlers.size) for (const handler of this.outputHandlers) handler(data)
          else this.output = (this.output + data).slice(-256 * 1024)
        } else if (message.method === 'ssh/exit') this.markExited()
      }
    })
    return this.opening
  }

  private markExited() {
    if (this.exited) return
    this.exited = true
    for (const handler of this.exitHandlers) handler()
    this.onDisconnected()
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.open()
    if (this.disposed || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('SSH Gateway disconnected')
    if (this.pending.size >= 128 || this.socket.bufferedAmount > 256 * 1024) {
      throw new Error('SSH terminal input buffer is full')
    }
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('SSH request timed out'))
        this.dispose()
      }, 30_000)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      this.socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  async connect(profileId: string, credentials: SshCredentials = {}) {
    this.exited = false
    const result = await this.request<SshConnectResult>('ssh/connect', {
      profileId,
      ...credentials,
    })
    if (result.status === 'connected' && (this.exited || this.disposed)) {
      throw new Error('SSH connection closed before the terminal was ready')
    }
    return result
  }

  createTerminalClient(sessionId: string): RemoteTerminalClient {
    return {
      attach: async () => {
        if (this.output) {
          const data = this.output
          this.output = ''
          for (const handler of this.outputHandlers) handler(data)
        }
        if (this.exited) for (const handler of this.exitHandlers) handler()
      },
      write: async data => {
        if (this.disposed || this.exited) return
        await this.request('ssh/write', { data })
      },
      resize: async (rows, cols) => {
        if (this.disposed || this.exited) return
        await this.request('ssh/resize', { rows, cols })
      },
      close: async () => {
        this.dispose()
      },
      onOutput: handler => {
        const callback = (data: string) => handler({ session_id: sessionId, data })
        this.outputHandlers.add(callback)
        return () => {
          this.outputHandlers.delete(callback)
        }
      },
      onExit: handler => {
        const callback = () => handler({ session_id: sessionId })
        this.exitHandlers.add(callback)
        return () => {
          this.exitHandlers.delete(callback)
        }
      },
      dispose: () => {},
    }
  }

  dispose() {
    this.disposed = true
    this.socket?.close()
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('SSH terminal is closed'))
    }
    this.pending.clear()
  }
}
