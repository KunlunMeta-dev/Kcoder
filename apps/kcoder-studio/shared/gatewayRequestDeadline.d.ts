export type GatewayRequestOutcome = 'readOnly' | 'unknown'
export interface GatewayRequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface GatewayExpiredRequestData { kind: 'gatewayRequestExpired'; outcome: 'unknown' }
export const GATEWAY_EXPIRED_REQUEST_DATA: Readonly<GatewayExpiredRequestData>
export function isGatewayUnknownOutcome(value: unknown): value is GatewayExpiredRequestData
export function gatewayRequestOutcome(method: string): GatewayRequestOutcome
export function gatewayRequestTimeoutMs(method: string, override?: number): number
