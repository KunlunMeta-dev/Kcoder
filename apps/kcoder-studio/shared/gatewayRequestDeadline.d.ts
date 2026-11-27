export type GatewayRequestOutcome = 'readOnly' | 'unknown'
export const GATEWAY_STARTUP_TIMEOUT_MS: number
export interface GatewayRequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface GatewayExpiredRequestData { kind: 'gatewayRequestExpired'; outcome: 'unknown' }
export const GATEWAY_EXPIRED_REQUEST_DATA: Readonly<GatewayExpiredRequestData>
export function hasWellFormedJsonStrings(value: unknown): boolean
export function isGatewayUnknownOutcome(error: { code?: number; data?: unknown; message?: string }, method: string): boolean
export function gatewayRequestOutcome(method: string): GatewayRequestOutcome
export function gatewayRequestTimeoutMs(method: string, override?: number): number
