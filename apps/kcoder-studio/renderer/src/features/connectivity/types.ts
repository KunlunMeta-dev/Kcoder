import type {
  ConnectivityPort as NativeConnectivityPort,
  ConnectivityMethod as NativeConnectivityMethod,
  ConnectivityConnection,
  IntegrationScope,
  IntegrationRequest,
  IntegrationReply,
  ReadinessObservation,
  IntegrationTaskCapabilitySourceDescriptor,
  IntegrationTaskCapabilitySourceChoice,
  ConnectivityCapabilityReadiness,
  ConnectivityChatTaskBinding,
} from '../../../../shared/generated/contracts'

export type ConnectivityPort = NativeConnectivityPort
export type ConnectivityMethod = NativeConnectivityMethod
export type ConnectivityScope = IntegrationScope
export type ConnectivityRequest = IntegrationRequest
export type ConnectivityReply<T> = Omit<IntegrationReply, 'result'> & { result: T | null }
export type ConnectionView = ConnectivityConnection
export interface CatalogEntry {
  kind: string
  nameKey: string
  transport: string
  category?: string
  docs: string | null
  credentialFields?: string[]
  capabilities?: Record<string, unknown> | string[]
}
export interface ConnectionList {
  taskBindingSummary?: ConnectivityChatTaskBinding[]
  taskBindingManagementSupported?: boolean
  taskBindingPlatforms?: string[]
  taskInputSupported?: boolean
  taskFirstRoutingSupported?: boolean
  connectionObservationState?: 'unknown' | 'observed'
  reasonCode?: string
  items: ConnectionView[]
  nextCursor: string | null
  catalog: { applications: CatalogEntry[]; channels: CatalogEntry[] }
  sources?: Array<{
    name: string
    pluginId: string | null
    enabled: boolean
    authorization: string
    taskSourceChoice?: IntegrationTaskCapabilitySourceChoice | null
  }>
  sourcesState?: 'unknown' | 'observed' | 'truncated'
  taskSources?: IntegrationTaskCapabilitySourceDescriptor[]
  taskSourcesState?: 'unknown' | 'observed' | 'truncated'
  taskSourcesReasonCode?: string | null
}
export interface ResourceItem {
  id: string
  revision: string
  kind: string
  label: string
}
export interface ReadinessView {
  observations: ReadinessObservation[]
  observedAt?: string
  connectionRevision?: string | null
  state?: string
  capabilities?: ConnectivityCapabilityReadiness[]
}
