/* Typed bridge from the upstream local service factory to the KCoder gateway runtime. */
import type { RemoteTerminalClient } from '@/lib/remote-terminal-socket'
import type { DeviceSessionResponse } from '@/types/devices'
import { gatewayVerificationConfig } from '@/e2e/gateway-verification'
import { invoke as nativeInvoke } from '@tauri-apps/api/core'
import {
  emit as nativeEmit,
  listen as nativeListen,
  type EventCallback,
  type UnlistenFn,
} from '@tauri-apps/api/event'

type GatewayCommandHandler = (command: string, args?: unknown) => unknown | Promise<unknown>

interface GatewayCommandTransport {
  active: boolean
  handler: GatewayCommandHandler
  listeners: Map<string, Set<(payload: unknown) => void>>
  previous: GatewayCommandTransport | null
}

let commandTransport: GatewayCommandTransport | null = null

export function registerGatewayCommandTransport(handler: GatewayCommandHandler): () => void {
  const transport: GatewayCommandTransport = {
    active: true,
    handler,
    listeners: new Map(),
    previous: commandTransport,
  }
  commandTransport = transport
  return () => {
    if (!transport.active) return
    transport.active = false
    transport.listeners.clear()
    if (commandTransport !== transport) return
    let previous = transport.previous
    while (previous && !previous.active) previous = previous.previous
    commandTransport = previous
  }
}

function gatewayTransportWasRemoved(): boolean {
  if (gatewayVerificationConfig()) return true
  const internals =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__
  return Boolean(
    typeof document !== 'undefined' &&
    document.querySelector('meta[name="kcoder-rpc-token"]') &&
    typeof internals?.invoke !== 'function'
  )
}

export async function invokeRuntimeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<T> {
  options?.signal?.throwIfAborted()
  if (commandTransport) return (await commandTransport.handler(command, options?.signal ? { ...args, signal: options.signal } : args)) as T
  if (gatewayTransportWasRemoved())
    throw new DOMException('Gateway service transport is unavailable', 'AbortError')
  return args === undefined ? nativeInvoke<T>(command) : nativeInvoke<T>(command, args)
}

export async function subscribeRuntimeEvent<T>(
  event: string,
  handler: EventCallback<T>
): Promise<UnlistenFn> {
  const transport = commandTransport
  if (!transport && gatewayTransportWasRemoved())
    throw new DOMException('Gateway service transport is unavailable', 'AbortError')
  if (!transport) return nativeListen<T>(event, handler)
  const listeners = transport.listeners.get(event) ?? new Set<(payload: unknown) => void>()
  transport.listeners.set(event, listeners)
  const listener = (payload: unknown) => handler({ event, id: 0, payload: payload as T })
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function emitRuntimeEvent<T>(event: string, payload: T): Promise<void> {
  const transport = commandTransport
  if (!transport && gatewayTransportWasRemoved())
    throw new DOMException('Gateway service transport is unavailable', 'AbortError')
  if (!transport) return nativeEmit(event, payload)
  for (const listener of [...(transport.listeners.get(event) ?? [])]) listener(payload)
}

export interface GatewayWorkspaceSessionRuntime {
  startTerminal(deviceId: string, cwd?: string): Promise<DeviceSessionResponse>
  restoreTerminal(
    deviceId: string,
    cwd: string | undefined,
    sessionId: string
  ): Promise<DeviceSessionResponse>
  createTerminalClient(sessionId: string): RemoteTerminalClient
}

let activeRuntime: GatewayWorkspaceSessionRuntime | null = null

export function registerGatewayWorkspaceSessionRuntime(
  runtime: GatewayWorkspaceSessionRuntime
): () => void {
  activeRuntime = runtime
  return () => {
    if (activeRuntime === runtime) activeRuntime = null
  }
}

export function startGatewayTerminal(
  deviceId: string,
  cwd?: string
): Promise<DeviceSessionResponse> {
  if (!activeRuntime) return Promise.reject(new Error('KCoder 网关终端运行时尚未初始化'))
  return activeRuntime.startTerminal(deviceId, cwd)
}

export function restoreGatewayTerminal(
  deviceId: string,
  cwd: string | undefined,
  sessionId: string
): Promise<DeviceSessionResponse> {
  if (!activeRuntime) return Promise.reject(new Error('KCoder 网关终端运行时尚未初始化'))
  return activeRuntime.restoreTerminal(deviceId, cwd, sessionId)
}

export function createGatewayTerminalClient(sessionId: string): RemoteTerminalClient {
  if (!activeRuntime) throw new Error('KCoder 网关终端运行时尚未初始化')
  return activeRuntime.createTerminalClient(sessionId)
}
