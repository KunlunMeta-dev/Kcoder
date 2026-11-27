import type { GatewayRpcId, GatewayServer } from './gatewayRpc'

export interface OwnedGatewayConnection {
  client: GatewayClient
  readonly serverId: string
  server: GatewayServer
  workspacePath?: string
  channel: 'runtime' | 'browser'
  nativeManagementOnly: boolean
  scanBound?: boolean
  ready: Promise<void>
  onClose?: () => void
}

export interface GatewayClient extends EventTarget {
  useNativeManagementTransport?: () => void
  setChannelInventoryObservation?: (enabled: boolean) => void
  readNegotiatedRemoteFacts?: () => import('./remotes/negotiatedFacts').NegotiatedRemoteFacts | null
  readonly diagnosticConnection?: import('./backgroundRunDiagnostic').DiagnosticConnection
  connect(): Promise<void>
  expectSessionAddress?: (address: import('../../../shared/peerAgentMessage').SessionAddress) => void
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<T>
  requestOnConnection?<T = unknown>(connectionId: string, method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<T>
  respond?: (id: GatewayRpcId, result: unknown) => void
  respondError?: (id: GatewayRpcId, code: number, message: string, data?: unknown) => void
  close(): void
  supportsExperimental?: (capability: string) => boolean
  supportsThreadResume?: () => boolean
  runtimeHandoff?: () => import('../../../shared/threadRuntimeHandoff.mjs').ThreadRuntimeHandoffClient
}
