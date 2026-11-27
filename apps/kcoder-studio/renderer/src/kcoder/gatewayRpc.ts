import { getRuntimeConfig, joinAppPath } from '@/config/runtime'
import { configurationPublicationCode } from './configurationPublication'
import {
  ThreadRuntimeHandoffClient,
  THREAD_RUNTIME_HANDOFF_CAPABILITY,
} from '../../../shared/threadRuntimeHandoff.mjs'
import {
  GATEWAY_STARTUP_TIMEOUT_MS,
  isGatewayUnknownOutcome,
} from '../../../shared/gatewayRequestDeadline.js'
import { INTEGRATION_CONTROL_CAPABILITIES } from '../../../shared/integrationControlMethods.mjs'
import { isContract } from '../../../shared/generated/validator.mjs'
import { hasInvalidTaskNotificationEnvelope } from '../../../shared/turnNotificationIdentity'
import type { IntegrationScope } from '../../../shared/generated/contracts'
import { publicImplementation, type NegotiatedRemoteFacts } from './remotes/negotiatedFacts'
import { captureAccountContextRevision, listenAccountContextChanges, notifyAccountContextChange, updateVerifiedAccountContextScope } from './accountContextEvents'
import { invalidateChannelBindings } from './channelBindingEvents'
import { CHANNEL_INVENTORY_CHANGED } from '../../../shared/channelInventoryEvents.js'
import { RUNTIME_ACTIVITY_CHANGED } from '../../../shared/runtimeActivityEvents.js'
import { notifyRuntimeWorkChanged } from './runtimeWorkEvents'
import { navigateGatewayLogin } from './gatewayLoginNavigation'
import { gatewayConnectionBudget, gatewayReconnectDelay } from './gatewayConnectionBudget'
import type { DiagnosticConnection } from './backgroundRunDiagnostic'
import { createRandomUuid } from '@/lib/random-id'
import { sharePendingRead, type PendingRead } from '@/lib/pendingRead'
import { nativeStartupDiagnostic, nativeStartupDiagnosticFromError, nativeStartupErrorMessage } from '../../../shared/nativeStartupDiagnostic.mjs'
// Use the application's translation singleton without initializing language
// detection or Storage merely by importing the transport boundary.
import i18n from 'i18next'
import {
  nativeIsolatedWidgetsAvailable,
  nativeMcpAppBridgeAvailable,
} from './nativeWidgetCapabilities'
import { sessionHistoryErrorMessage } from './sessionHistoryError'
import { SESSION_ADDRESS_EXPECTATION_CAPABILITY, SESSION_ADDRESS_EXPECTATION_FIELD,
  sessionAddressExpectation } from '../../../shared/sessionAddressExpectation.mjs'
import type { SessionAddress } from '../../../shared/peerAgentMessage'
import {
  gatewayRequestOutcome,
  gatewayRequestTimeoutMs,
  type GatewayRequestOptions,
  type GatewayRequestOutcome,
} from './gatewayRequestDeadline'

// One observer identity per page runtime, created on first use so importing the
// module never consumes randomness (or touches crypto) as a side effect.
let channelInventoryObserverIdForPage: string | undefined
function channelInventoryObserverId(): string {
  return (channelInventoryObserverIdForPage ??= createRandomUuid())
}

export interface GatewayServerConfig {
  id: string
  label: string
  labelKey?: 'currentComputer'
  description: string
  runtime: 'kcoder'
  transport: 'local' | 'ssh'
  remotePlatform?: 'linux' | 'windows'
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
  /** Fresh Gateway-owned Native initialization facts; each task still needs its real index binding. */
  workspaceHints?: { version: 1; paths: string[]; truncated?: boolean }
  /** Gateway-owned launcher facts for one-click MCP presets; only local same-account targets carry them. */
  localMcpPresets?: {
    version: 1
    playwright?: { command: string; defaultBrowser: string; outputDirectory: string }
  }
  observationTargetIdentity?: string
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

export type GatewayRpcId = number | string

export function isGatewayRpcId(value: unknown): value is GatewayRpcId {
  return (typeof value === 'string' && Boolean(value.trim())) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

interface RpcMessage {
  jsonrpc?: string
  id?: GatewayRpcId
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: RpcErrorPayload
}

interface InitializeResult {
  serverInfo?: { name?: unknown; version?: unknown }
  protocolVersion?: string
  capabilities?: {
    threadResume?: boolean
    experimental?: Record<string, boolean>
  }
}

function gatewayPath(path: string): string {
  return joinAppPath(getRuntimeConfig().appBasePath, path)
}

const KCODER_APP_SERVER_PROTOCOL_VERSION = '2026-07-27'
let gatewayLoginRedirectStarted = false

export function resetGatewayLoginRedirectForTests(): void {
  gatewayLoginRedirectStarted = false
}

function requireGatewayResponse(
  response: Response,
  operationLabel: string,
  operation: GatewayRpcOperation = 'unknown',
  isCurrent?: () => boolean
): void {
  if (response.status !== 401) return
  // An obsolete directory response cannot initiate recovery for the current context.
  if (isCurrent && !isCurrent()) throw new DOMException('Gateway target context changed', 'AbortError')
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
  | 'plugin-install'
  | 'plugin-manage'
  | 'marketplace-manage'
  | 'storage-scan'
  | 'storage-clean'
  | 'schedule-preview'
  | 'schedule-manage'
  | 'model-catalog'
  | 'provider-probe'
  | 'provider-save'
  | 'unknown'

export type GatewayRpcErrorReason =
  'unauthorized' | 'http' | 'invalid-response' | 'remote' | 'connection' | 'timeout' | 'unknown'

export interface GatewayDiagnosticContext {
  connectionId: string
  requestId: number
  threadId: string | null
  turnId: string | null
}

// Runtime-owned UUIDs, grouped (xxxx-xxxx-xxxx) or legacy five-character short session IDs,
// process-scoped session IDs and turn sequence IDs only; never copy arbitrary caller text.
function diagnosticRuntimeId(value: unknown): string | null {
  return typeof value === 'string' &&
    (/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(value) ||
      /^(?:[A-Za-z0-9]{5}|[0-9a-f]{32}-[0-9a-f]{8}-[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|turn-\d+(?:-retry-[0-9a-f-]{36})?)$/i.test(
        value
      ))
    ? value
    : null
}
let diagnosticClientSequence = 0

export class GatewayRpcError extends Error {
  readonly uncertain: boolean
  readonly code: number
  readonly data: unknown
  readonly operation: GatewayRpcOperation
  readonly reason: GatewayRpcErrorReason
  readonly targetId: string | null
  readonly diagnosticContext: GatewayDiagnosticContext | undefined

  constructor(
    message: string,
    code = -1,
    data?: unknown,
    operation: GatewayRpcOperation = 'unknown',
    reason: GatewayRpcErrorReason = 'unknown',
    targetId: string | null = null,
    diagnosticContext?: GatewayDiagnosticContext
  ) {
    const userMessage = sessionHistoryErrorMessage(message)
    super(userMessage, userMessage === message ? undefined : { cause: new Error(message) })
    this.name = 'GatewayRpcError'
    this.uncertain =
      (operation === 'save-target' || operation === 'delete-target') &&
      configurationPublicationCode(data) !== null
    this.code = Number.isSafeInteger(code) ? code : -1
    this.data = data
    this.operation = operation
    this.reason = reason
    this.targetId = targetId
    this.diagnosticContext = diagnosticContext
      ? Object.freeze({
          connectionId: /^rpc-\d+-\d+$/.test(diagnosticContext.connectionId)
            ? diagnosticContext.connectionId
            : 'unknown',
          requestId: Number.isSafeInteger(diagnosticContext.requestId)
            ? diagnosticContext.requestId
            : -1,
          threadId: diagnosticRuntimeId(diagnosticContext.threadId),
          turnId: diagnosticRuntimeId(diagnosticContext.turnId),
        })
      : undefined
  }

  /** Safe diagnostic metadata: never include remote text, payloads, URLs or credentials. */
  get diagnostic() {
    return {
      code: this.code,
      phase: this.operation,
      reason: this.reason,
      targetId: this.targetId,
      ...(this.diagnosticContext ?? {}),
      // An interrupted transport does not prove that a mutation was rejected.
      // Only a known pre-execution busy response advertises safe retry here.
      retryable: this.reason === 'remote' && this.code === -32034,
    }
  }
}

export function safeGatewayFailureDiagnostic(error: unknown) {
  if (error instanceof GatewayRpcError) return error.diagnostic
  return { code: -1, phase: 'runtime-session', reason: 'unknown', retryable: false }
}

export class GatewayRpcTimeoutError extends GatewayRpcError {
  declare readonly data: Readonly<{ outcome: GatewayRequestOutcome; timeoutMs: number }>
  declare readonly reason: 'timeout'

  constructor(
    method: string,
    timeoutMs: number,
    targetId: string,
    context?: GatewayDiagnosticContext
  ) {
    const outcome = gatewayRequestOutcome(method)
    super(
      i18n.t(outcome === 'readOnly' ? 'common:rpcReadTimeout' : 'common:rpcUnknownOutcomeTimeout'),
      -1,
      Object.freeze({ outcome, timeoutMs }),
      operationForRpcMethod(method),
      'timeout',
      targetId,
      context
    )
    this.name = 'GatewayRpcTimeoutError'
  }
}

function reportRpcFailure(error: GatewayRpcError): GatewayRpcError {
  // Product diagnostics deliberately exclude Error.message, stack and remote data.
  console.warn('[kcoder-rpc-failure]', error.diagnostic)
  return error
}

function operationForRpcMethod(method: string): GatewayRpcOperation {
  if (method === 'plugin/install') return 'plugin-install'
  if (method.startsWith('plugin/')) return 'plugin-manage'
  if (method.startsWith('marketplace/')) return 'marketplace-manage'
  if (method === 'diagnostics/storage/clean') return 'storage-clean'
  if (method.startsWith('diagnostics/storage/')) return 'storage-scan'
  if (method === 'cron/preview') return 'schedule-preview'
  if (method.startsWith('cron/')) return 'schedule-manage'
  if (method === 'runtime.models.list') return 'model-catalog'
  if (method === 'runtime.providers.validate') return 'provider-probe'
  if (method === 'runtime.providers.upsert') return 'provider-save'
  return 'runtime-session'
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
  form.action = gatewayPath('/logout')
  form.hidden = true
  documentLike.body.appendChild(form)
  form.submit()
}

const pendingServerDirectories = new WeakMap<typeof fetch, Map<string, PendingRead<GatewayServer[]>>>()
const pendingServerStatuses = new WeakMap<typeof fetch, Map<string, PendingRead<GatewayServerHealth[]>>>()

/** Share transport work, never a completed authorization or directory snapshot. */
function shareGatewayRead<T>(
  readsByTransport: WeakMap<typeof fetch, Map<string, PendingRead<T>>>,
  fetchImpl: typeof fetch,
  route: string,
  read: (path: string, isCurrent: () => boolean, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  const path = gatewayPath(route)
  let reads = readsByTransport.get(fetchImpl)
  if (!reads) {
    reads = new Map()
    readsByTransport.set(fetchImpl, reads)
  }
  let pending = reads.get(path)
  const start = (signal: AbortSignal) => read(path,
    () => reads.get(path) === pending && gatewayPath(route) === path, signal)
  if (!pending) {
    const directory = reads
    const controller = new AbortController()
    // Capture directory/account ownership and dispatch before returning to the caller.
    const request = { controller, promise: start(controller.signal), subscribers: 0 }
    pending = request
    directory.set(path, request)
    const retire = () => {
      if (directory.get(path) === request) directory.delete(path)
    }
    const stopAccount = listenAccountContextChanges(retire)
    window.addEventListener('kcoder:servers-changed', retire)
    const finish = () => {
      retire()
      stopAccount()
      window.removeEventListener('kcoder:servers-changed', retire)
    }
    void request.promise.then(finish, finish)
  }
  // Callers previously owned separately decoded DTOs; preserve that isolation.
  return sharePendingRead(reads, path, signal, start).then(value => structuredClone(value))
}

export function fetchGatewayServers(
  fetchImpl: typeof fetch = fetch,
  options?: { signal?: AbortSignal }
): Promise<GatewayServer[]> {
  return shareGatewayRead(pendingServerDirectories, fetchImpl, '/api/servers',
    (path, isCurrent, signal) => readGatewayServers(fetchImpl, path, isCurrent, signal), options?.signal)
}

async function readGatewayServers(
  fetchImpl: typeof fetch,
  path: string,
  isCurrent: () => boolean,
  signal: AbortSignal
): Promise<GatewayServer[]> {
  const account = captureAccountContextRevision()
  const response = await fetchImpl(path, { cache: 'no-store', signal })
  signal.throwIfAborted()
  requireGatewayResponse(response, '读取运行目标列表', 'list-targets', isCurrent)
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
  for (const server of payload.servers) {
    if (!isCurrent() || !account(server.id)) continue
    const scope = server.security?.identity.mode === 'kcoder-account' && !server.accountIdentity
      ? null : JSON.stringify([server.authorityId, server.accountIdentity?.principalId ?? 'local', server.command, server.profile])
    updateVerifiedAccountContextScope(server.id, scope)
  }
  return payload.servers
}

export function fetchGatewayServerStatuses(
  fetchImpl: typeof fetch = fetch,
  options?: { signal?: AbortSignal }
): Promise<GatewayServerHealth[]> {
  return shareGatewayRead(pendingServerStatuses, fetchImpl, '/api/servers/status',
    (path, isCurrent, signal) => readGatewayServerStatuses(fetchImpl, path, isCurrent, signal), options?.signal)
}

async function readGatewayServerStatuses(
  fetchImpl: typeof fetch,
  path: string,
  isCurrent: () => boolean,
  signal: AbortSignal
): Promise<GatewayServerHealth[]> {
  const response = await fetchImpl(path, { cache: 'no-store', signal })
  requireGatewayResponse(response, '读取运行目标状态', 'target-health', isCurrent)
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
  fetchImpl: typeof fetch = fetch,
  options?: { signal?: AbortSignal }
): Promise<GatewayServer[]> {
  const path = gatewayPath('/api/servers')
  options?.signal?.throwIfAborted()
  let retired = false
  const retire = () => { retired = true }
  const assertCurrent = () => {
    options?.signal?.throwIfAborted()
    if (retired || gatewayPath('/api/servers') !== path)
      throw new DOMException('Gateway target context changed', 'AbortError')
  }
  const stopAccount = listenAccountContextChanges(retire)
  window.addEventListener('kcoder:servers-changed', retire)
  try {
    const servers = await fetchGatewayServers(fetchImpl, options)
    assertCurrent()
    if (servers.length === 0) return []
    try {
      const statuses = await fetchGatewayServerStatuses(fetchImpl, options)
      assertCurrent()
      const statusById = new Map(statuses.map(status => [status.id, status]))
      return servers.map(server => ({
        ...server,
        ...(statusById.get(server.id) ?? { status: 'unknown' as const }),
      }))
    } catch (error) {
      if (error instanceof GatewayRpcError && error.reason === 'unauthorized') throw error
      assertCurrent()
      const healthError = error instanceof Error ? error.message : String(error)
      return servers.map(server => ({ ...server, status: 'unavailable', healthError }))
    }
  } finally {
    stopAccount()
    window.removeEventListener('kcoder:servers-changed', retire)
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
  if (server.labelKey) payload.labelKey = server.labelKey
  if (server.command) payload.command = server.command
  if (server.security) payload.security = server.security
  if (server.workspacePath) payload.workspace = server.workspacePath
  if (server.profile) payload.profile = server.profile
  if (server.settingsFile) payload.settingsFile = server.settingsFile
  if (server.chromiumBin) payload.chromiumBin = server.chromiumBin
  if (server.chromiumNoSandbox) payload.chromiumNoSandbox = true
  if (server.transport === 'ssh') {
    if (server.remotePlatform) payload.remotePlatform = server.remotePlatform
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
    const publication = configurationPublicationCode(payload)
    throw new GatewayRpcError(
      publication ?? payload.error ?? `${operationLabel}失败（HTTP ${response.status}）`,
      response.status,
      publication ? { code: publication, externalOutcome: 'unknown' } : payload,
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
  const response = await fetchImpl(gatewayPath(`/api/servers/${encodeURIComponent(server.id)}`), {
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
let accountDeviceIdForPage: string | undefined

export function getAccountDeviceId(): string {
  if (accountDeviceIdForPage) return accountDeviceIdForPage
  try {
    const existing = window.localStorage.getItem(ACCOUNT_DEVICE_ID_KEY)
    if (existing) return (accountDeviceIdForPage = existing)
    const created = createRandomUuid()
    accountDeviceIdForPage = created
    window.localStorage.setItem(ACCOUNT_DEVICE_ID_KEY, created)
    return created
  } catch {
    // Restricted storage still needs a distinct credential scope. Keep one
    // identifier for this page, rather than sharing a constant across clients.
    return (accountDeviceIdForPage ??= createRandomUuid())
  }
}

// Account endpoints use 401 as a business signal (wrong account password),
// so they must never trigger the gateway-session logout redirect.
async function accountJson<T>(
  response: Response,
  operationLabel: string,
  operation: GatewayRpcOperation
): Promise<T> {
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
  const response = await fetch(gatewayPath(`/api/servers/${encodeURIComponent(id)}/account`), {
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

export async function loginGatewayAccount(
  id: string,
  input: GatewayAccountLoginInput
): Promise<GatewayAccountStatus> {
  const response = await fetch(gatewayPath(`/api/servers/${encodeURIComponent(id)}/account`), {
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
  notifyAccountContextChange(id)
  return result
}

export async function autoLoginGatewayAccount(
  id: string,
  deviceId: string
): Promise<GatewayAccountStatus> {
  const response = await fetch(gatewayPath(`/api/servers/${encodeURIComponent(id)}/account`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auto: true, deviceId }),
  })
  const result = await accountJson<GatewayAccountStatus>(
    response,
    '恢复 KCoder 账号登录',
    'login-account'
  )
  if (result.authenticated) notifyAccountContextChange(id)
  return result
}

export async function logoutGatewayAccount(id: string, deviceId?: string): Promise<void> {
  const response = await fetch(gatewayPath(`/api/servers/${encodeURIComponent(id)}/account`), {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(deviceId ? { deviceId } : {}),
  })
  await accountJson(response, '退出 KCoder 账号', 'logout-account')
  notifyAccountContextChange(id)
}

export async function manageGatewayAccounts<T>(
  id: string,
  operation: Record<string, unknown>
): Promise<T> {
  const response = await fetch(gatewayPath(`/api/servers/${encodeURIComponent(id)}/accounts`), {
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
  const response = await fetchImpl(gatewayPath('/api/servers/test'), {
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
  const response = await fetchImpl(gatewayPath(`/api/servers/${encodeURIComponent(id)}`), {
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
  private connectionEpoch = 0
  private connectionAbort = new AbortController()
  private authenticationFailure: GatewayRpcError | null = null
  private startupFailure: GatewayRpcError | null = null
  private authenticationCheck: Promise<void> | null = null
  private experimentalCapabilities: Record<string, boolean> = {}
  private negotiatedRemoteFacts: NegotiatedRemoteFacts | null = null
  private threadResumeCapability = false
  private nextId = 1
  private readonly expectedSessionAddresses = new Map<string, Readonly<SessionAddress>>()
  private diagnosticSnapshot: DiagnosticConnection | null = null
  get diagnosticConnection() {
    return this.diagnosticSnapshot ??= Object.freeze({
      targetId: this.serverId,
      connectionId: `rpc-${this.diagnosticClientId}-${this.diagnosticConnectionSequence}`,
    })
  }
  private readonly diagnosticClientId = ++diagnosticClientSequence
  private diagnosticConnectionSequence = 0
  private readonly pending = new Map<
    number,
    {
      operation: GatewayRpcOperation
      method: string
      diagnosticContext: GatewayDiagnosticContext
      resolve: (value: unknown) => void
      reject: (error: unknown) => void
    }
  >()

  private readonly token: string
  private readonly WebSocketImpl: typeof WebSocket
  private readonly channel: 'runtime' | 'browser'
  private readonly workspacePath?: string
  private readonly fetchImpl: typeof fetch
  private nativeManagementOnly = false
  private observeChannelInventory = true

  setChannelInventoryObservation(enabled: boolean): void {
    if (this.socket || this.ready) throw new GatewayRpcError('Channel observation is already initialized')
    this.observeChannelInventory = enabled
  }

  useNativeManagementTransport(): void {
    if (this.socket || this.ready)
      throw new GatewayRpcError('Native management transport is already initialized')
    this.nativeManagementOnly = true
  }

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
    if (this.connectionAbort.signal.aborted) this.connectionAbort = new AbortController()
    const signal = this.connectionAbort.signal
    const attempt = gatewayConnectionBudget.run(async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.connectAndInitialize(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              this.socket?.close()
              reject(
                new GatewayRpcError(
                  'Gateway connection timed out',
                  -1,
                  undefined,
                  'runtime-session',
                  'connection'
                )
              )
            }, GATEWAY_STARTUP_TIMEOUT_MS)
          }),
        ])
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    }, signal)
    this.connectPromise = attempt
    try {
      await attempt
    } catch (error) {
      const diagnostic = nativeStartupDiagnosticFromError(error)
      if (!signal.aborted && (!diagnostic || diagnostic.code === 'native_startup_failed'))
        await this.checkGatewaySessionAfterSocketFailure(signal)
      throw error
    } finally {
      if (this.connectPromise === attempt) this.connectPromise = null
    }
  }

  /** Connect on demand so a closed socket heals on the next request. */
  private async ensureConnected(): Promise<void> {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return
    if (this.reconnectPromise) return this.reconnectPromise
    const epoch = this.connectionEpoch
    const attempt = (async () => {
      const delays = [0, 250, 750, 1_500]
      let lastError: unknown
      for (const delay of delays) {
        if (delay > 0)
          await new Promise(resolve => window.setTimeout(resolve, gatewayReconnectDelay(delay)))
        if (epoch !== this.connectionEpoch)
          throw new GatewayRpcError('Gateway connection cancelled')
        if (this.authenticationFailure) throw this.authenticationFailure
        try {
          await this.connect()
          return
        } catch (error) {
          lastError = error
          const startupDiagnostic = nativeStartupDiagnosticFromError(error)
          if (startupDiagnostic && startupDiagnostic.code !== 'native_startup_failed') throw error
          if (this.authenticationFailure) throw this.authenticationFailure
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
    this.startupFailure = null
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = new URL(`${protocol}//${location.host}${gatewayPath('/rpc')}`)
      url.searchParams.set('token', this.token)
      url.searchParams.set('server', this.serverId)
      if (this.channel === 'runtime' && this.observeChannelInventory)
        url.searchParams.set('channelObserver', channelInventoryObserverId())
      else if (this.channel === 'runtime') url.searchParams.set('channelObserver', 'none')
      if (this.channel === 'browser') url.searchParams.set('channel', 'browser')
      if (this.nativeManagementOnly) url.searchParams.set('nativeManagement', '1')
      if (this.workspacePath) url.searchParams.set('workspace', this.workspacePath)
      const socket = new this.WebSocketImpl(url)
      this.socket = socket
      this.diagnosticConnectionSequence++
      this.diagnosticSnapshot = null
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
      socket.addEventListener('message', event => {
        if (this.socket === socket) this.receive(String(event.data))
      })
      socket.addEventListener('close', () => {
        const error = this.socket === socket && this.startupFailure ? this.startupFailure : new GatewayRpcError(
          'KCoder app-server 连接已断开',
          -1,
          undefined,
          'runtime-session',
          'connection'
        )
        // Some WebSocket implementations emit close without an error before open.
        // Reject the connection owner even if this socket has since been replaced.
        fail(error)
        if (this.socket !== socket) return
        this.socket = null
        this.ready = false
        this.negotiatedRemoteFacts = null
        for (const pending of this.pending.values()) {
          pending.reject(
            reportRpcFailure(
              new GatewayRpcError(
                error.message,
                error.code,
                error.data,
                pending.operation,
                'connection',
                this.serverId,
                pending.diagnosticContext
              )
            )
          )
        }
        this.pending.clear()
        this.dispatchEvent(new Event('close'))
      })
    })
    try {
      const isolatedWidgets = await nativeIsolatedWidgetsAvailable()
      // A socket can close while the asynchronous capability check is pending.
      // Do not enter request()'s reconnect path from its own initialization.
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN)
        throw new GatewayRpcError('KCoder app-server 连接已断开', -1, undefined, 'runtime-session', 'connection', this.serverId)
      const initialized = await this.request<InitializeResult>('initialize', {
        protocolVersion: KCODER_APP_SERVER_PROTOCOL_VERSION,
        clientInfo: { name: 'kcoder-studio-wework', version: __KCODER_STUDIO_APP_VERSION__ },
        capabilities: {
          experimental: {
            ...Object.fromEntries(
              INTEGRATION_CONTROL_CAPABILITIES.map(capability => [capability, true])
            ),
            acpInboundV1: true,
            studioWorkModesV1: true,
            threadForkReceiptsV1: true,
            agentDefinitionsV1: true,
            agentTurnConfigurationV1: true,
            threadExpertReadWithoutTurnsV1: true,
            gatewaySharedThreadsV1: this.channel === 'runtime',
            asyncUserQuestionsV1: true,
            webSearchStatusV1: true,
            webSearchProbeV1: true,
            workflowCollaborationV1: true,
            agentExactRunV1: true,
            agentExactControlV1: true,
            agentExactContinuationV1: true,
            migrationHistoryWorkerStateClientV1: true,
            inlineWidgetsV1: true,
            isolatedWidgetsV1: isolatedWidgets,
            mcpAppsV1: isolatedWidgets && nativeMcpAppBridgeAvailable(),
            browserAttachments: true,
            terminalSessions: true,
            terminalKcoderTuiV1: true,
            workspaceFiles: true,
            turnFileCaptureV1: true,
            turnReviewEvidenceV1: true,
            taskComparisonV1: true,
            taskDeliveryV1: true,
            workspaceBinaryRevisionV1: true,
            toolPathPreviewV1: true,
            threadStreamContextV1: true,
            sessionLifetimeV1: true,
            computerUseRecoveryV1: true,
            computerUseTurnStatusV1: true,
            computerUseSessionAuthorizationV1: true,
            // Opt into the authoritative thread run projection so a pending
            // approval, background work or pending delivery is not collapsed
            // into the coarse running/idle status.
            threadRunSummaryV1: true,
            // Typed eviction and per-thread compaction/rollback facts: an
            // evicted thread is resumed on demand, a busy one is not retried blindly.
            threadResidencyV1: true,
            threadMaintenanceV1: true,
            threadMaintenanceCancelV1: true,
            crossSessionDiscoveryV1: true,
            crossSessionDiscoverySearchV1: true,
            crossSessionMessagesV1: true,
            crossSessionMessageReceiptsV1: true,
            crossSessionMessageRepliesV1: true,
            peerAgentMessagesV1: true,
            [THREAD_RUNTIME_HANDOFF_CAPABILITY]: true,
            threadGoalStatusBatchV1: true,
            threadWorkspaceLookupV1: true,
            continuousWorkReadV1: true,
            continuousWorkPartialListV1: true,
            // Opt into requiring every interaction reply to name the
            // interaction it answers, so a transport id from an earlier
            // connection generation can never be applied to a new turn.
            interactionBindingV1: true,
            interactionStatusReadV1: true,
            // Receive the additive `extensionConflicts` on plugin install/read.
            extensionsInventoryV1: true,
            // Opt into refusing a repeated submission identity, so a retry after
            // an unknown outcome cannot run the turn twice.
            turnSubmissionV1: true,
            turnRetryOperationV1: true,
            retryModelConfigurationV1: true,
            ...(this.nativeManagementOnly
              ? {
                  gatewaySharedThreadsV1: false,
                  taskSourcesV1: false,
                  [THREAD_RUNTIME_HANDOFF_CAPABILITY]: false,
                }
              : {}),
          },
        },
      })
      if (initialized.protocolVersion !== KCODER_APP_SERVER_PROTOCOL_VERSION) {
        throw new GatewayRpcError(
          `KCoder app-server 协议不兼容：${initialized.protocolVersion ?? 'unknown'}`
        )
      }
      if (this.socket !== socket) throw new GatewayRpcError('Gateway connection was replaced')
      this.experimentalCapabilities = initialized.capabilities?.experimental ?? {}
      this.threadResumeCapability = initialized.capabilities?.threadResume === true
      const publicCapabilities = Object.entries(this.experimentalCapabilities).filter(
        ([name, value]) =>
          /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(name) && typeof value === 'boolean'
      )
      this.negotiatedRemoteFacts = {
        connectionId: this.diagnosticConnection.connectionId,
        protocolVersion: initialized.protocolVersion,
        implementationName: publicImplementation(initialized.serverInfo?.name),
        implementationVersion: publicImplementation(initialized.serverInfo?.version),
        observedAt: new Date().toISOString(),
        capabilities: Object.fromEntries(publicCapabilities.slice(0, 512)),
        capabilityListComplete:
          publicCapabilities.length <= 512 &&
          publicCapabilities.length === Object.keys(this.experimentalCapabilities).length,
        nativeScope: null,
      }
      this.notify('initialized')
      this.ready = true
    } catch (error) {
      if (this.socket === socket) socket.close()
      throw error
    }
  }

  private async checkGatewaySessionAfterSocketFailure(connectionSignal: AbortSignal): Promise<void> {
    if (this.authenticationCheck) return this.authenticationCheck
    const check = (async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5_000)
      const signal = AbortSignal.any([connectionSignal, controller.signal])
      try {
        const servers = await fetchGatewayServers(this.fetchImpl, { signal })
        signal.throwIfAborted()
        const target = servers.find(server => server.id === this.serverId)
        if (target?.security?.identity.mode === 'kcoder-account' && !target.accountIdentity) {
          this.authenticationFailure = new GatewayRpcError(
            'KCoder account login required',
            401,
            undefined,
            'login-account',
            'remote'
          )
          notifyAccountContextChange(this.serverId)
        }
      } catch (error) {
        if (!signal.aborted && error instanceof GatewayRpcError && error.reason === 'unauthorized')
          this.authenticationFailure = error
        // Network failures keep bounded transport retries; authentication failures do not.
      } finally {
        clearTimeout(timeout)
      }
    })()
    this.authenticationCheck = check
    try {
      await check
    } finally {
      if (this.authenticationCheck === check) this.authenticationCheck = null
    }
  }

  /** Observe only: this never connects/reconnects, probes a runner or sends a request. */
  readNegotiatedRemoteFacts(): NegotiatedRemoteFacts | null {
    if (
      !this.ready ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.connectionAbort.signal.aborted
    )
      return null
    return this.negotiatedRemoteFacts ? structuredClone(this.negotiatedRemoteFacts) : null
  }

  supportsExperimental(capability: string): boolean {
    return this.experimentalCapabilities[capability] === true
  }

  runtimeHandoff(): ThreadRuntimeHandoffClient {
    return new ThreadRuntimeHandoffClient({
      request: (method, params) => this.request(method, params),
      supported: () =>
        this.ready &&
        this.socket?.readyState === WebSocket.OPEN &&
        this.supportsExperimental(THREAD_RUNTIME_HANDOFF_CAPABILITY),
      ownerStamp: () => this.connectionEpoch,
    })
  }

  supportsThreadResume(): boolean {
    return this.threadResumeCapability
  }

  /** Keep peer navigation attached to its original Native target across reconnects. */
  expectSessionAddress(address: SessionAddress): void {
    const expected = sessionAddressExpectation(address, address.threadId)
    if (!this.supportsExperimental(SESSION_ADDRESS_EXPECTATION_CAPABILITY))
      throw new GatewayRpcError('SESSION_ADDRESS_EXPECTATION_UNSUPPORTED', -32601)
    const previous = this.expectedSessionAddresses.get(expected.threadId)
    if (previous && (previous.targetId !== expected.targetId || previous.workspaceId !== expected.workspaceId))
      throw new GatewayRpcError('SESSION_ADDRESS_EXPECTATION_CONFLICT', -32034)
    this.expectedSessionAddresses.set(expected.threadId, expected)
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options?: GatewayRequestOptions
  ): Promise<T> {
    options?.signal?.throwIfAborted()
    if (
      this.nativeManagementOnly &&
      method !== 'initialize' &&
      method !== 'gateway/client/detach' &&
      method !== 'plugin/proxy/status' &&
      method !== 'plugin/proxy/configure' &&
      !/^integrations\/(scope\/read|operation\/read|connectivity\/|services\/channel\/)/.test(
        method
      )
    ) {
      throw new GatewayRpcError('Native management transport cannot execute task commands')
    }
    const timeoutMs = gatewayRequestTimeoutMs(method, options?.timeoutMs)
    const startedAt = Date.now()
    // An open socket sends synchronously so an in-flight close still rejects
    // this request with its connection error instead of silently reconnecting.
    if (
      this.socket &&
      this.socket.readyState === WebSocket.OPEN &&
      (this.ready || method === 'initialize')
    ) {
      return this.sendRequest<T>(method, params, timeoutMs, options?.signal)
    }
    // A queued connection also belongs to this request's deadline. Aborting one
    // waiter must not close a connection shared by other requests.
    await new Promise<void>((resolve, reject) => {
      const signal = options?.signal
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      const abort = () => {
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(reportRpcFailure(new GatewayRpcTimeoutError(method, timeoutMs, this.serverId)))
      }, timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      this.ensureConnected().then(
        () => {
          cleanup()
          resolve()
        },
        error => {
          cleanup()
          reject(error)
        }
      )
    })
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new GatewayRpcError('KCoder app-server 尚未连接'))
    }
    return this.sendRequest<T>(
      method,
      params,
      Math.max(1, timeoutMs - (Date.now() - startedAt)),
      options?.signal
    )
  }

  /** Resource cleanup/renewal must use its original logical channel, without reconnecting. */
  requestOnConnection<T = unknown>(
    connectionId: string,
    method: string,
    params: Record<string, unknown> = {},
    options?: { signal?: AbortSignal }
  ): Promise<T> {
    options?.signal?.throwIfAborted()
    if (
      !this.ready ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.connectionAbort.signal.aborted ||
      this.diagnosticConnection.connectionId !== connectionId
    )
      return Promise.reject(
        new GatewayRpcError('migration_history_view_connection_changed', -32049)
      )
    return this.sendRequest<T>(method, params, gatewayRequestTimeoutMs(method), options?.signal)
  }

  private sendRequest<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted()
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new GatewayRpcError('KCoder app-server 尚未连接'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const diagnosticContext = {
        connectionId: this.diagnosticConnection.connectionId,
        requestId: id,
        threadId: diagnosticRuntimeId(params.threadId),
        turnId: diagnosticRuntimeId(params.turnId ?? params.retryFromTurnId),
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(id)
      }
      const abort = () => {
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      const timer = setTimeout(() => {
        cleanup()
        // Losing a receipt does not prove the server cancelled or rejected a
        // mutation. Keep this socket and all other thread owners alive.
        reject(
          reportRpcFailure(
            new GatewayRpcTimeoutError(method, timeoutMs, this.serverId, diagnosticContext)
          )
        )
      }, timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        method,
        operation: operationForRpcMethod(method),
        diagnosticContext,
        resolve: value => {
          cleanup()
          if (
            method === 'integrations/scope/read' &&
            this.socket === socket &&
            this.ready &&
            this.negotiatedRemoteFacts &&
            isContract('IntegrationScope', value)
          ) {
            this.negotiatedRemoteFacts.nativeScope = structuredClone(value) as IntegrationScope
          }
          resolve(value as T)
        },
        reject: error => {
          cleanup()
          reject(error)
        },
      })
      try {
        const expected = this.expectedSessionAddresses.get(String(params.threadId ?? params.sourceThreadId ?? ''))
        if (expected && !this.supportsExperimental(SESSION_ADDRESS_EXPECTATION_CAPABILITY))
          throw new GatewayRpcError('SESSION_ADDRESS_EXPECTATION_UNSUPPORTED', -32601)
        const wireParams = expected ? { ...params, [SESSION_ADDRESS_EXPECTATION_FIELD]: expected } : params
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: wireParams }))
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  respond(id: GatewayRpcId, result: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new GatewayRpcError('KCoder app-server 尚未连接')
    }
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
  }

  respondError(id: GatewayRpcId, code: number, message: string, data?: unknown): void {
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
    this.connectionEpoch++
    this.connectionAbort.abort()
    this.ready = false
    this.experimentalCapabilities = {}
    this.negotiatedRemoteFacts = null
    this.threadResumeCapability = false
    this.socket?.close(1000, 'KCoder Studio runtime disposed')
  }

  private receive(raw: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(raw) as RpcMessage
    } catch {
      this.dispatchEvent(new CustomEvent('protocol-error', { detail: 'Invalid JSON-RPC frame' }))
      return
    }
    // Valid JSON can still be a non-object frame; it owns no RPC identity.
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.dispatchEvent(new CustomEvent('protocol-error', { detail: 'Invalid JSON-RPC frame' }))
      return
    }
    const hasResult = Object.hasOwn(message, 'result')
    const hasError = Object.hasOwn(message, 'error')
    if (hasInvalidTaskNotificationEnvelope(message)) return
    // Server requests can reuse client IDs. Frames with outcome fields must
    // go through response validation before they can reach an input card.
    if (isGatewayRpcId(message.id) && message.method && !hasResult && !hasError) {
      // Reject before a card or waiter can reserve this request ID. Legacy
      // transports that omit the version retain their existing request path.
      if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') return
      this.dispatchEvent(new CustomEvent<RpcMessage>('request', { detail: message }))
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      // A correlation ID cannot certify an invalid protocol envelope. Reject
      // before exposing results or treating an error as an authoritative refusal.
      if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') {
        pending.reject(reportRpcFailure(new GatewayRpcError(
          'Invalid JSON-RPC response version', -1, undefined, pending.operation,
          'invalid-response', this.serverId, pending.diagnosticContext
        )))
      } else if (message.method !== undefined ||
          // Match Gateway receipt validation on direct and legacy transports.
          (pending.method.startsWith('asyncQuestion/') && Object.hasOwn(message, 'params')) ||
          hasResult === hasError ||
          (hasError && (!message.error || typeof message.error !== 'object' ||
            Array.isArray(message.error) || !Number.isSafeInteger(message.error.code) ||
            typeof message.error.message !== 'string'))) {
        pending.reject(reportRpcFailure(new GatewayRpcError(
          'Invalid JSON-RPC response outcome', -1, undefined, pending.operation,
          'invalid-response', this.serverId, pending.diagnosticContext
        )))
      } else if (message.error) {
        const unknownOutcome = isGatewayUnknownOutcome(message.error, pending.method)
        pending.reject(
          reportRpcFailure(
            new GatewayRpcError(
              message.error.message ?? 'KCoder app-server 请求失败',
              unknownOutcome ? -1 : message.error.code,
              message.error.data,
              pending.operation,
              unknownOutcome ? 'unknown' : 'remote',
              this.serverId,
              pending.diagnosticContext
            )
          )
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (hasResult || hasError) return
    if (message.jsonrpc === '2.0' && message.method === CHANNEL_INVENTORY_CHANGED && message.id === undefined) {
      invalidateChannelBindings('gateway-channels')
      return
    }
    if (message.jsonrpc === '2.0' && message.method === RUNTIME_ACTIVITY_CHANGED && message.id === undefined) {
      notifyRuntimeWorkChanged()
      return
    }
    if (message.id === undefined && message.method) {
      if (!this.ready && ['server/disconnected', 'server/transportError'].includes(message.method)) {
        const startupDiagnostic = nativeStartupDiagnostic(message.params?.startupDiagnostic)
        if (startupDiagnostic) {
          const fallback = nativeStartupErrorMessage(startupDiagnostic.code)
          const message = i18n.isInitialized ? String(i18n.t(`startup_failures.${startupDiagnostic.code}`, { ns: 'localRuntime', defaultValue: fallback })) : fallback
          this.startupFailure = new GatewayRpcError(message, -32071, { startupDiagnostic }, 'runtime-session', 'connection', this.serverId)
        }
      }
      this.dispatchEvent(new CustomEvent<RpcMessage>('notification', { detail: message }))
    }
  }
}
