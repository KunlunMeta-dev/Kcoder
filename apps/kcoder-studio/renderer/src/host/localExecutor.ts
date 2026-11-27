import { getRuntimeConfig } from '@/config/runtime'
import { runtimeTransport } from '@/lib/runtime-transport'
import {
  invokeRuntimeCommand as invoke,
  subscribeRuntimeEvent as listen,
} from '@/kcoder/gatewayServiceBridge'
import type { UnlistenFn } from '@/lib/runtime-events'

export const LOCAL_EXECUTOR_COMMANDS = {
  copyDebugInfo: 'local_executor_copy_debug_info',
  ensure: 'local_executor_ensure_started',
  status: 'local_executor_status',
  readLog: 'local_executor_read_log',
  request: 'local_executor_request',
  connectBackend: 'local_executor_connect_backend',
  disconnectBackend: 'local_executor_disconnect_backend',
} as const

export const LOCAL_EXECUTOR_EVENT = 'local-executor:event'

export interface LocalExecutorStatus {
  running: boolean
  ready?: boolean
  accountLoginServerId?: string
  deviceId?: string
  runtimeInstanceId?: string
  version?: string
  error?: string
}

export interface LocalExecutorLog {
  path: string
  content: string
  truncated: boolean
  lineCount: number
  transport: 'stdio'
  transportConnected: boolean
  processPids: number[]
  processPaths: string[]
  sidecarSource: string
  sidecarPath: string
  currentDir: string
  executorHome: string
  backendUrl: string | null
  hasBackendAuthToken: boolean
  pendingRequestCount: number
  status: LocalExecutorStatus
}

export interface LocalExecutorEvent {
  event: string
  payload: Record<string, unknown>
}

export interface LocalExecutorBackendConnection {
  backendUrl: string
  authToken: string
}

export function captureLocalExecutorReadSource(targetId?: string): () => boolean {
  const source = runtimeTransport()
  const mount = getRuntimeConfig().appBasePath
  const isCurrent = source.handler.captureReadSource?.(targetId)
  return () => source.active && runtimeTransport() === source &&
    getRuntimeConfig().appBasePath === mount && isCurrent?.() !== false
}

export async function ensureLocalExecutorStarted(): Promise<LocalExecutorStatus> {
  const isCurrent = captureLocalExecutorReadSource()
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.ensure).finally(() => {
    if (!isCurrent())
      throw new DOMException('Executor preflight source changed', 'AbortError')
  })
}

export function getLocalExecutorStatus(): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.status)
}

export function readLocalExecutorLog(): Promise<LocalExecutorLog> {
  return invoke<LocalExecutorLog>(LOCAL_EXECUTOR_COMMANDS.readLog)
}

export function copyLocalExecutorDebugInfo(text: string): Promise<void> {
  return invoke<void>(LOCAL_EXECUTOR_COMMANDS.copyDebugInfo, { text })
}

export function connectLocalExecutorToBackend(
  connection: LocalExecutorBackendConnection
): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.connectBackend, {
    backendUrl: connection.backendUrl,
    authToken: connection.authToken,
  })
}

export function disconnectLocalExecutorFromBackend(): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.disconnectBackend)
}

export function requestLocalExecutor<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  options?: { signal?: AbortSignal }
): Promise<T> {
  return options
    ? invoke<T>(LOCAL_EXECUTOR_COMMANDS.request, { method, params }, options)
    : invoke<T>(LOCAL_EXECUTOR_COMMANDS.request, { method, params })
}

export function subscribeLocalExecutorEvents(
  handler: (event: LocalExecutorEvent) => void
): Promise<UnlistenFn> {
  return listen<LocalExecutorEvent>(LOCAL_EXECUTOR_EVENT, event => {
    handler(event.payload)
  })
}
