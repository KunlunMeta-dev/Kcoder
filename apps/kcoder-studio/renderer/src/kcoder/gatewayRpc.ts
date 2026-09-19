import { navigateGatewayLogin } from './gatewayLoginNavigation'

export interface GatewayServerConfig {
  id: string
  label: string
  description: string
  runtime: 'kcoder'
  transport: 'local' | 'ssh'
  host?: string
  user?: string
  port?: number
  command?: string
  workspacePath?: string
  profile?: string
  settingsFile?: string
  chromiumBin?: string
  chromiumNoSandbox?: boolean
  acceptNewHostKey?: boolean
  // The stored username is a "last used" hint only; the authenticated
  // identity is decided per login context on the Gateway.
  security?: { identity: { mode: 'kcoder-account'; username?: string } }
}

export interface GatewayServerHealth {
  id: string
  status: 'online' | 'offline'
  latencyMs: number
  checkedAt?: number
  error?: string
}

export interface GatewayServer extends GatewayServerConfig {
  accountIdentity?: { principalId: string; username: string; role: 'admin' | 'user' }
  authorityId?: string
  capabilities?: {
    browserSessions?: boolean
    fileChangesRevert?: boolean
    terminalSessions?: boolean
    workspaceFiles?: boolean
  }
  status?: 'online' | 'offline' | 'unknown' | 'unavailable'
  latencyMs?: number
  checkedAt?: number
  error?: string
  healthError?: string
}

export interface GatewayAccountStatus {
  authenticated: boolean
  generation?: number
  authorityId?: string
  username?: string
  role?: 'admin' | 'user'
  principalId?: string
}

export interface GatewayConnectionTestResult {
  ok: boolean
  error?: string
  protocolVersion?: string
  serverInfo?: { name?: string; version?: string }
}

interface RpcErrorPayload {
  code?: number
  message?: string
  data?: unknown
}

interface RpcMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: RpcErrorPayload
}

interface InitializeResult {
  protocolVersion?: string
  capabilities?: {
    threadResume?: boolean
    experimental?: Record<string, boolean>
  }
}

const KCODER_APP_SERVER_PROTOCOL_VERSION = '2026-07-27'
let gatewayLoginRedirectStarted = false

export function resetGatewayLoginRedirectForTests(): void {
  gatewayLoginRedirectStarted = false
}

function requireGatewayResponse(
  response: Response,
  operationLabel: string,
  operation: GatewayRpcOperation = 'unknown'
): void {
  if (response.status !== 401) return
  if (!gatewayLoginRedirectStarted) {
    gatewayLoginRedirectStarted = true
    navigateGatewayLogin()
  }
  throw new GatewayRpcError(
    `${operationLabel}失败：登录已失效，正在返回登录页`,
    401,
    undefined,
    operation,
    'unauthorized'
  )
}

export type GatewayRpcOperation =
  | 'manage-accounts'
  | 'login-account'
  | 'logout-account'
  | 'account-status'
  | 'list-targets'
  | 'target-health'
  | 'save-target'
  | 'test-target'
  | 'delete-target'
  | 'runtime-session'
  | 'unknown'

export type GatewayRpcErrorReason =
  'unauthorized' | 'http' | 'invalid-response' | 'remote' | 'connection' | 'unknown'

export class GatewayRpcError extends Error {
  readonly code: number
  readonly data: unknown
  readonly operation: GatewayRpcOperation
  readonly reason: GatewayRpcErrorReason

  constructor(
    message: string,
    code = -1,
    data?: unknown,
    operation: GatewayRpcOperation = 'unknown',
    reason: GatewayRpcErrorReason = 'unknown'
  ) {
    super(message)
    this.name = 'GatewayRpcError'
    this.code = code
    this.data = data
    this.operation = operation
    this.reason = reason
  }
}

export function gatewayToken(documentLike: Document = document): string | null {
  return (
    documentLike.querySelector<HTMLMetaElement>('meta[name="kcoder-rpc-token"]')?.content ?? null
  )
}

export function isKCoderGatewayPage(documentLike: Document = document): boolean {
  return Boolean(gatewayToken(documentLike))
}

export function isKCoderDesktopHostPage(documentLike: Document = document): boolean {
  return (
    documentLike.querySelector<HTMLMetaElement>('meta[name="kcoder-desktop-host"]')?.content === '1'
  )
}

export function submitKCoderGatewayLogout(documentLike: Document = document): void {
  const form = documentLike.createElement('form')
  form.method = 'post'
  form.action = '/logout'
  form.hidden = true
  documentLike.body.appendChild(form)
  form.submit()
}

export async function fetchGatewayServers(
  fetchImpl: typeof fetch = fetch
): Promise<GatewayServer[]> {
  const response = await fetchImpl('/api/servers', { cache: 'no-store' })
  requireGatewayResponse(response, '读取运行目标列表', 'list-targets')
  if (!response.ok)
    throw new GatewayRpcError(
      `读取服务器列表失败（HTTP ${response.status}）`,
      response.status,
      undefined,
      'list-targets',
      'http'
    )
  const payload = (await response.json()) as { servers?: GatewayServer[] }
  if (!Array.isArray(payload.servers)) {
    throw new GatewayRpcError(
      '网关返回的运行目标列表无效',
      -1,
      undefined,
      'list-targets',
      'invalid-response'
    )
  }
  return payload.servers
}

export async function fetchGatewayServerStatuses(
  fetchImpl: typeof fetch = fetch
): Promise<GatewayServerHealth[]> {
  const response = await fetchImpl('/api/servers/status', { cache: 'no-store' })
  requireGatewayResponse(response, '读取运行目标状态', 'target-health')
  if (!response.ok)
    throw new GatewayRpcError(
      `读取服务器状态失败（HTTP ${response.status}）`,
      response.status,
      undefined,
      'target-health',
      'http'
    )
  const payload = (await response.json()) as { statuses?: GatewayServerHealth[] }
  if (!Array.isArray(payload.statuses)) {
    throw new GatewayRpcError(
      '网关返回的服务器状态无效',
      -1,
      undefined,
      'target-health',
      'invalid-response'
    )
  }
  return payload.statuses
}

export async function fetchGatewayServersWithHealth(
  fetchImpl: typeof fetch = fetch
): Promise<GatewayServer[]> {
  const servers = await fetchGatewayServers(fetchImpl)
  if (servers.length === 0) return []
  try {
    const statuses = await fetchGatewayServerStatuses(fetchImpl)
    const statusById = new Map(statuses.map(status => [status.id, status]))
    return servers.map(server => ({
      ...server,
      ...(statusById.get(server.id) ?? { status: 'unknown' as const }),
    }))
  } catch (error) {
    if (error instanceof GatewayRpcError && error.reason === 'unauthorized') throw error
    const healthError = error instanceof Error ? error.message : String(error)
    return servers.map(server => ({ ...server, status: 'unavailable', healthError }))
  }
}

function gatewayServerPayload(server: GatewayServerConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: server.id,
    label: server.label,
    description: server.description,
    runtime: 'kcoder',
    transport: server.transport,
  }
  if (server.command) payload.command = server.command
  if (server.security) payload.security = server.security
  if (server.workspacePath) payload.workspace = server.workspacePath
  if (server.profile) payload.profile = server.profile
  if (server.settingsFile) payload.settingsFile = server.settingsFile
  if (server.chromiumBin) payload.chromiumBin = server.chromiumBin
  if (server.chromiumNoSandbox) payload.chromiumNoSandbox = true
  if (server.transport === 'ssh') {
    if (server.host) payload.host = server.host
    if (server.user) payload.user = server.user
    if (server.port !== undefined) payload.port = server.port
    if (server.acceptNewHostKey) payload.acceptNewHostKey = true
  }
  return payload
}

async function gatewayJson<T>(
  response: Response,
  operationLabel: string,
  operation: GatewayRpcOperation
): Promise<T> {
  requireGatewayResponse(response, operationLabel, operation)
  const payload = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) {
    throw new GatewayRpcError(
      payload.error || `${operationLabel}失败（HTTP ${response.status}）`,
      response.status,
      payload,
      operation,
      payload.error ? 'remote' : 'http'
    )
  }
  return payload as T
}

export async function saveGatewayServer(
  server: GatewayServerConfig,
  fetchImpl: typeof fetch = fetch
): Promise<GatewayServer> {
  const response = await fetchImpl(`/api/servers/${encodeURIComponent(server.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(gatewayServerPayload(server)),
  })
  const payload = await gatewayJson<{ server?: GatewayServer }>(
    response,
    '保存运行目标',
    'save-target'
  )
  if (!payload.server || typeof payload.server.id !== 'string') {
    throw new GatewayRpcError(
      '保存运行目标失败：网关返回了无效响应',
      -1,
      payload,
      'save-target',
      'invalid-response'
    )
  }
  return payload.server
}

// Stable per-browser-profile identifier used only to scope remembered
// credentials on the Gateway; it never grants identity by itself.
const ACCOUNT_DEVICE_ID_KEY = 'kcoder.account.deviceId'

export function getAccountDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(ACCOUNT_DEVICE_ID_KEY)
    if (existing) return existing
    const created = crypto.randomUUID()
    window.localStorage.setItem(ACCOUNT_DEVICE_ID_KEY, created)
    return created
  } catch {
    return 'ephemeral-session'
  }
}

// Account endpoints use 401 as a business signal (wrong account password),
// so they must never trigger the gateway-session logout redirect.
async function accountJson<T>(response: Response, operationLabel: string, operation: GatewayRpcOperation): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) {
    throw new GatewayRpcError(
      payload.error || `${operationLabel}失败（HTTP ${response.status}）`,
      response.status,
      payload,
      operation,
      'remote'
    )
  }
  return payload as T
}

export async function fetchGatewayAccountStatus(id: string): Promise<GatewayAccountStatus> {
  const response = await fetch(`/api/servers/${encodeURIComponent(id)}/account`, {
    cache: 'no-store',
  })
  return accountJson<GatewayAccountStatus>(response, '读取 KCoder 账号状态', 'account-status')
}

export interface GatewayAccountLoginInput {
  username: string
  password: string
  remember?: boolean
  deviceId?: string
}

export async function loginGatewayAccount(id: string, input: GatewayAccountLoginInput): Promise<GatewayAccountStatus> {
  const response = await fetch(`/api/servers/${encodeURIComponent(id)}/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: input.username,
      password: input.password,
      ...(input.remember ? { remember: true } : {}),
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    }),
  })
  const result = await accountJson<GatewayAccountStatus>(
    response,
    '登录 KCoder 账号',
    'login-account'
  )
  if (!result.authenticated) throw new Error('KCoder 账号身份未通过验证')
  return result
}

export async function autoLoginGatewayAccount(id: string, deviceId: string): Promise<GatewayAccountStatus> {
  const response = await fetch(`/api/servers/${encodeURIComponent(id)}/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auto: true, deviceId }),
  })
  return accountJson<GatewayAccountStatus>(response, '恢复 KCoder 账号登录', 'login-account')
}

export async function logoutGatewayAccount(id: string, deviceId?: string): Promise<void> {
  const response = await fetch(`/api/servers/${encodeURIComponent(id)}/account`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(deviceId ? { deviceId } : {}),
  })
  await accountJson(response, '退出 KCoder 账号', 'logout-account')
}

export async function manageGatewayAccounts<T>(
  id: string,
  operation: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`/api/servers/${encodeURIComponent(id)}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(operation),
  })
  const payload = await gatewayJson<{ result: T }>(response, '管理 KCoder 账号', 'manage-accounts')
  return payload.result
}

export async function testGatewayServer(
  server: GatewayServerConfig,
  fetchImpl: typeof fetch = fetch
): Promise<GatewayConnectionTestResult> {
  const response = await fetchImpl('/api/servers/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(gatewayServerPayload(server)),
  })
  const result = await gatewayJson<GatewayConnectionTestResult>(response, '测试连接', 'test-target')
  if (!result.ok)
    throw new GatewayRpcError(result.error || '连接测试失败', -1, result, 'test-target', 'remote')
  return result
}

export async function removeGatewayServer(
  id: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(`/api/servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  await gatewayJson(response, '删除运行目标', 'delete-target')
}

export class GatewayRpcClient extends EventTarget {
  readonly serverId: string
  private socket: WebSocket | null = null
  private connectPromise: Promise<void> | null = null
  private reconnectPromise: Promise<void> | null = null
  private ready = false
  private experimentalCapabilities: Record<string, boolean> = {}
  private threadResumeCapability = false
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()

  private readonly token: string
  private readonly WebSocketImpl: typeof WebSocket
  private readonly channel: 'runtime' | 'browser'
  private readonly workspacePath?: string
  private readonly fetchImpl: typeof fetch

  constructor(
    serverId: string,
    token: string,
    WebSocketImpl: typeof WebSocket = WebSocket,
    channel: 'runtime' | 'browser' = 'runtime',
    workspacePath?: string,
    fetchImpl: typeof fetch = fetch
  ) {
    super()
    this.serverId = serverId
    this.token = token
    this.WebSocketImpl = WebSocketImpl
    this.channel = channel
    this.workspacePath = workspacePath
    this.fetchImpl = fetchImpl
  }

  async connect(): Promise<void> {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return
    if (this.connectPromise) return this.connectPromise
    const attempt = this.connectAndInitialize()
    this.connectPromise = attempt
    try {
      await attempt
    } finally {
      if (this.connectPromise === attempt) this.connectPromise = null
    }
  }

  /** Connect on demand so a closed socket heals on the next request. */
  private async ensureConnected(): Promise<void> {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return
    if (this.reconnectPromise) return this.reconnectPromise
    const attempt = (async () => {
      const delays = [0, 250, 750, 1_500]
      let lastError: unknown
      for (const delay of delays) {
        if (delay > 0) await new Promise(resolve => window.setTimeout(resolve, delay))
        try {
          await this.connect()
          return
        } catch (error) {
          lastError = error
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new GatewayRpcError(
            '无法连接 KCoder app-server',
            -1,
            undefined,
            'runtime-session',
            'connection'
          )
    })()
    this.reconnectPromise = attempt
    try {
      await attempt
    } finally {
      if (this.reconnectPromise === attempt) this.reconnectPromise = null
    }
  }

  private async connectAndInitialize(): Promise<void> {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = new URL(`${protocol}//${location.host}/rpc`)
      url.searchParams.set('token', this.token)
      url.searchParams.set('server', this.serverId)
      if (this.channel === 'browser') url.searchParams.set('channel', 'browser')
      if (this.workspacePath) url.searchParams.set('workspace', this.workspacePath)
      const socket = new this.WebSocketImpl(url)
      this.socket = socket
      const fail = (error: unknown) => {
        reject(error)
      }
      socket.addEventListener(
        'open',
        () => {
          resolve(socket)
        },
        { once: true }
      )
      socket.addEventListener(
        'error',
        () => {
          void this.checkGatewaySessionAfterSocketFailure()
          fail(
            new GatewayRpcError(
              '无法连接 KCoder app-server',
              -1,
              undefined,
              'runtime-session',
              'connection'
            )
          )
        },
        {
          once: true,
        }
      )
      socket.addEventListener('message', event => this.receive(String(event.data)))
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = null
        this.ready = false
        const error = new GatewayRpcError(
          'KCoder app-server 连接已断开',
          -1,
          undefined,
          'runtime-session',
          'connection'
        )
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
        this.dispatchEvent(new Event('close'))
      })
    })
    try {
      const initialized = await this.request<InitializeResult>('initialize', {
        protocolVersion: KCODER_APP_SERVER_PROTOCOL_VERSION,
        clientInfo: { name: 'kcoder-studio-wework', version: __KCODER_STUDIO_APP_VERSION__ },
        capabilities: {
          experimental: {
            browserAttachments: true,
            terminalSessions: true,
            workspaceFiles: true,
            toolPathPreviewV1: true,
          },
        },
      })
      if (initialized.protocolVersion !== KCODER_APP_SERVER_PROTOCOL_VERSION) {
        throw new GatewayRpcError(
          `KCoder app-server 协议不兼容：${initialized.protocolVersion ?? 'unknown'}`
        )
      }
      this.experimentalCapabilities = initialized.capabilities?.experimental ?? {}
      this.threadResumeCapability = initialized.capabilities?.threadResume === true
      this.notify('initialized')
      this.ready = true
    } catch (error) {
      if (this.socket === socket) socket.close()
      throw error
    }
  }

  private async checkGatewaySessionAfterSocketFailure(): Promise<void> {
    try {
      await fetchGatewayServers(this.fetchImpl)
    } catch {
      // fetchGatewayServers handles 401 by redirecting to login; other network failures retain the original connection error.
    }
  }

  supportsExperimental(capability: string): boolean {
    return this.experimentalCapabilities[capability] === true
  }

  supportsThreadResume(): boolean {
    return this.threadResumeCapability
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // An open socket sends synchronously so an in-flight close still rejects
    // this request with its connection error instead of silently reconnecting.
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return this.sendRequest<T>(method, params)
    }
    await this.ensureConnected()
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new GatewayRpcError('KCoder app-server 尚未连接'))
    }
    return this.sendRequest<T>(method, params)
  }

  private sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new GatewayRpcError('KCoder app-server 尚未连接'))
    }
    const id = this.nextId++
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
    })
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  respond(id: number, result: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new GatewayRpcError('KCoder app-server 尚未连接')
    }
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
  }

  respondError(id: number, code: number, message: string, data?: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new GatewayRpcError('KCoder app-server 尚未连接')
    }
    this.socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      })
    )
  }

  close(): void {
    this.ready = false
    this.experimentalCapabilities = {}
    this.threadResumeCapability = false
    this.socket?.close(1000, 'KCoder Studio runtime disposed')
  }

  private receive(raw: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(raw) as RpcMessage
    } catch {
      this.dispatchEvent(new CustomEvent('protocol-error', { detail: raw }))
      return
    }
    if (typeof message.id === 'number' && message.method) {
      this.dispatchEvent(new CustomEvent<RpcMessage>('request', { detail: message }))
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(
          new GatewayRpcError(
            message.error.message ?? 'KCoder app-server 请求失败',
            message.error.code,
            message.error.data
          )
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method) {
      this.dispatchEvent(new CustomEvent<RpcMessage>('notification', { detail: message }))
    }
  }
}
