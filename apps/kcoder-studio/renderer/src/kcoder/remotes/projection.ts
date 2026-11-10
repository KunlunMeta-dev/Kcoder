import type {
  IntegrationOwner,
  RemoteCapabilityBoundary,
  RemoteCapabilityEntry,
  RemoteCapabilitySchemaRef,
} from '../../../../shared/generated/contracts'
import type { GatewayServer } from '../gatewayRpc'
import type { NegotiatedRemoteFacts } from './negotiatedFacts'

// These are public local contract references, never a remote schema digest or permission grant.
const publicSchemas: Record<string, string[]> = {
  integrationScopeV1: ['IntegrationScopeReadParams', 'IntegrationScope'],
  taskWorkspaceV1: ['IntegrationRequest', 'TaskWorkspaceReadParams', 'TaskWorkspaceSnapshot'],
  officeWorkspaceV1: ['IntegrationRequest', 'IntegrationReply'],
  modelPoliciesV1: [
    'IntegrationRequest',
    'IntegrationModelPolicyCatalog',
    'IntegrationModelResolutionResult',
  ],
  modelHealthV1: ['IntegrationRequest', 'IntegrationModelHealthReport'],
  modelUsageV1: ['IntegrationRequest', 'IntegrationModelUsageReport'],
  channelControlV1: ['IntegrationRequest', 'IntegrationReply'],
  knowledgePublicationsV1: ['IntegrationRequest', 'IntegrationReply'],
}
function owner(facts?: NegotiatedRemoteFacts): IntegrationOwner | null {
  const scope = facts?.nativeScope
  return scope
    ? {
        accountId: scope.accountId,
        targetId: scope.targetId,
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId ?? null,
      }
    : null
}
function boundary(facts?: NegotiatedRemoteFacts): RemoteCapabilityBoundary {
  const scope = facts?.nativeScope
  return {
    resource: scope?.workspaceId ? { kind: 'workspace', id: scope.workspaceId } : null,
    location: 'selected_native_target',
    authorization: 'revalidate_native_policy_per_request',
    allowedModels: 'not_observed',
    budget: 'not_reserved',
    tools: 'not_observed',
    confirmation: 'native_request_policy',
    inputTransfer: 'not_observed',
    resultTransfer: 'not_observed',
  }
}
function base(server: GatewayServer, facts?: NegotiatedRemoteFacts): RemoteCapabilityEntry {
  return {
    id: '',
    capability: '',
    purpose: 'native_protocol',
    targetId: server.id,
    transport: server.transport,
    protocol: 'kcoder_app_server',
    protocolVersion: facts?.protocolVersion ?? null,
    implementationVersion: facts?.implementationVersion ?? null,
    state: 'unknown',
    businessState: 'unknown',
    identityState: facts?.nativeScope ? 'observed' : 'unknown',
    nativeOwner: owner(facts),
    schemas: [],
    boundary: boundary(facts),
    observedAt: facts?.observedAt ?? null,
    reasonCode: 'REMOTE_CONNECTION_NOT_OBSERVED',
  }
}
export function projectRemoteEntries(
  server: GatewayServer,
  observations: NegotiatedRemoteFacts[]
): RemoteCapabilityEntry[] {
  const rows: RemoteCapabilityEntry[] = []
  if (!observations.length)
    rows.push({
      ...base(server),
      id: `${server.id}:native`,
      capability: 'native.protocol',
      state:
        server.status === 'offline' || server.status === 'unavailable' ? 'unavailable' : 'unknown',
      reasonCode:
        server.status === 'offline'
          ? 'REMOTE_TARGET_OFFLINE'
          : server.status === 'unavailable'
            ? 'REMOTE_TARGET_STATUS_UNAVAILABLE'
            : 'REMOTE_CONNECTION_NOT_OBSERVED',
    })
  const prioritized = [...observations].sort(
    (a, b) =>
      Number(Boolean(b.nativeScope)) - Number(Boolean(a.nativeScope)) ||
      a.connectionId.localeCompare(b.connectionId)
  )
  prioritized.forEach((facts, index) => {
    const common = base(server, facts)
    rows.push({
      ...common,
      id: `${server.id}:c${index}:native`,
      capability: 'native.protocol',
      state: 'observed',
      reasonCode: facts.capabilityListComplete
        ? 'REMOTE_PROTOCOL_HANDSHAKE_OBSERVED'
        : 'REMOTE_CAPABILITY_LIST_INCOMPLETE',
    })
    Object.entries(facts.capabilities)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([name, declared]) => {
        const schemaNames = Object.hasOwn(publicSchemas, name) ? publicSchemas[name] : []
        const schemas: RemoteCapabilitySchemaRef[] = schemaNames.map(schema => ({
          name: schema,
          protocolVersion: facts.protocolVersion,
          producerRevision: null,
        }))
        if (name === 'acpInboundV1') {
          rows.push({
            ...common,
            id: `${server.id}:c${index}:acp-inbound`,
            capability: 'acp.inbound',
            purpose: 'inbound_acp_protocol',
            protocol: 'acp',
            protocolVersion: '1',
            state: declared ? 'advertised' : 'unavailable',
            schemas: [
              'ACP.InitializeRequest',
              'ACP.InitializeResponse',
              'ACP.NewSessionRequest',
              'ACP.NewSessionResponse',
            ].map(name => ({ name, protocolVersion: '1', producerRevision: null })),
            reasonCode: declared
              ? 'ACP_INBOUND_PROTOCOL_ADVERTISED'
              : 'REMOTE_CAPABILITY_NOT_ADVERTISED',
          })
          return
        }
        rows.push({
          ...common,
          id: `${server.id}:c${index}:${name}`,
          capability: name,
          purpose: 'negotiated_native_capability',
          state: declared ? 'advertised' : 'unavailable',
          schemas,
          reasonCode: declared
            ? 'REMOTE_CAPABILITY_ADVERTISED_NOT_BUSINESS_VERIFIED'
            : 'REMOTE_CAPABILITY_NOT_ADVERTISED',
        })
      })
  })
  rows.push({
    ...base(server),
    id: `${server.id}:acp-outbound`,
    capability: 'acp.outbound',
    purpose: 'outbound_agent_delegation',
    protocol: 'acp',
    state: 'unavailable',
    reasonCode: 'ACP_OUTBOUND_RUNNER_NOT_REGISTERED',
  })
  if (!observations.some(facts => Object.hasOwn(facts.capabilities, 'acpInboundV1')))
    rows.push({
      ...base(server),
      id: `${server.id}:acp-inbound`,
      capability: 'acp.inbound',
      purpose: 'inbound_acp_protocol',
      protocol: 'acp',
      state: 'unknown',
      reasonCode: 'ACP_INBOUND_IMPLEMENTATION_NOT_OBSERVED',
    })
  return rows
}
