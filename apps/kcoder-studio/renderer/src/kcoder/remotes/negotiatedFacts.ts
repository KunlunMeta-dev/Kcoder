import type { IntegrationScope } from '../../../../shared/generated/contracts'
/** A snapshot captured inside an actual authenticated RPC connection, never an authority token. */
export interface NegotiatedRemoteFacts {
  connectionId: string
  protocolVersion: string
  implementationName: string | null
  implementationVersion: string | null
  observedAt: string
  capabilities: Record<string, boolean>
  capabilityListComplete: boolean
  nativeScope: IntegrationScope | null
}
export function publicImplementation(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !Array.from(value).some(
      character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
    ? value
    : null
}
