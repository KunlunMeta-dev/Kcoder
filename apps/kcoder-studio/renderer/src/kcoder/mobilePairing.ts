import { getRuntimeConfig, joinAppPath } from '@/config/runtime'
import type { GatewayConnectionRoutes } from '../../../shared/gatewayConnectionRoutes.js'

export interface MobilePairingDevice {
  id: string
  label: string
  createdAt: number
  lastUsedAt: number
  expiresAt: number
}

export interface MobilePairingSettings {
  publicReadiness?: 'preparing' | 'ready' | 'failed'
  token: string
  webToken?: string
  expiresAt: number
  devices: MobilePairingDevice[]
  publicBaseUrl?: string | null
  connectionRoutes?: GatewayConnectionRoutes | null
}

export interface GatewayRelayState {
  configured: boolean
  publicBaseUrl: string | null
  restartRequired: boolean
  restartSupported: boolean
  revokeSupported?: boolean
  disabled?: boolean
  publicAccess?: GatewayPublicAccess
  liveApplySupported?: boolean
  productAccountOrigin?: string | null
  needsLogin?: boolean
  hasPendingIdentity?: boolean
  restoreFailed?: boolean
  externallyManaged?: boolean
  connectionStatus?: 'online' | 'offline' | 'denied'
  accountAccessStatus?: 'authorized' | 'denied' | 'unknown'
  revision?: number
  relayUrl?: string | null
  switchSupported?: boolean
  selectedProfileId?: string | null
  selectedRelay?: { url: string; publicBaseUrl: string }
  previousRelay?: { url: string; publicBaseUrl: string }
  switchAttempt?: { id: string; url: string; needsActivation?: boolean }
}

export interface GatewayPublicAccess {
  revision: number
  surfaces: Record<'desktopWeb' | 'mobileWeb' | 'mobileApp', boolean>
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(joinAppPath(getRuntimeConfig().appBasePath, `/api${path}`), {
    ...init,
    mode: 'same-origin',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { ...(init?.headers ?? {}), 'content-type': 'application/json' },
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: unknown }
    const message =
      typeof payload.error === 'string' ? payload.error : `Gateway 请求失败（${response.status}）`
    const error = new Error(message) as Error & { status: number; code?: string }
    error.status = response.status
    error.code = /^(RELAY_|KCODER_ACCOUNT_)/.test(message) ? message : undefined
    throw error
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function isProtectedRelayLoginLocation(location: Pick<Location, 'protocol' | 'hostname'>): boolean {
  if (location.protocol === 'https:') return true
  if (location.protocol !== 'http:') return false
  const host = location.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host === '::1') return true
  const parts = host.split('.').map(part => Number(part))
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 127
}

function assertProtectedRelayLoginOrigin(): void {
  if (isProtectedRelayLoginLocation(window.location)) return
  const error = new Error('Relay sign-in requires HTTPS or loopback HTTP') as Error & { code: string }
  error.code = 'RELAY_LOGIN_REQUIRES_SECURE_ORIGIN'
  throw error
}

export function fetchMobilePairingSettings(): Promise<MobilePairingSettings> {
  return request('/mobile/pairing')
}

export function fetchGatewayRelayState(): Promise<GatewayRelayState> {
  return request('/relay')
}

export function updateGatewayPublicAccess(expectedRevision: number, surfaces: GatewayPublicAccess['surfaces']): Promise<GatewayPublicAccess> {
  return request('/relay/public-access', { method: 'POST', body: JSON.stringify({ expectedRevision, surfaces }) })
}

export function activateGatewayRelay(input: { activationLink?: string; relayUrl?: string; accountCredentials?: { username: string; password: string }; useKCoderAccount?: true }): Promise<GatewayRelayState> {
  if (input.activationLink || input.accountCredentials || input.useKCoderAccount) assertProtectedRelayLoginOrigin()
  return request('/relay/activation', { method: 'POST', body: JSON.stringify(input) })
}

export function switchGatewayRelay(input: { requestId: string; expectedRevision: number; relayUrl: string; activationLink?: string; accountCredentials?: { username: string; password: string }; useKCoderAccount?: true }): Promise<GatewayRelayState> {
  if (input.activationLink || input.accountCredentials || input.useKCoderAccount) assertProtectedRelayLoginOrigin()
  return request('/relay/switch', { method: 'POST', body: JSON.stringify(input) })
}

export function cancelGatewayRelaySwitch(expectedRevision: number): Promise<GatewayRelayState> {
  return request('/relay/switch/cancel', { method: 'POST', body: JSON.stringify({ expectedRevision }) })
}

export function rollbackGatewayRelay(expectedRevision: number): Promise<GatewayRelayState> {
  return request('/relay/rollback', { method: 'POST', body: JSON.stringify({ expectedRevision }) })
}

export function restartGatewayForRelay(): Promise<void> {
  return request('/relay/restart', { method: 'POST', body: '{}' })
}

export function revokeGatewayRelay(expectedRevision: number): Promise<GatewayRelayState> {
  return request('/relay/revoke', { method: 'POST', body: JSON.stringify({ expectedRevision }) })
}

export function applyGatewayRelay(): Promise<GatewayRelayState> {
  return request('/relay/apply', { method: 'POST', body: '{}' })
}

export function rotateMobilePairingCredential(): Promise<Omit<MobilePairingSettings, 'devices'>> {
  return request('/mobile/pairing', { method: 'POST', body: '{}' })
}

export function revokeMobilePairingDevice(deviceId: string): Promise<void> {
  return request(`/mobile/pairing/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    body: '{}',
  })
}

export interface KCoderAccountStatus {
  available: boolean
  portalUrl?: string
  account: { id: string; username: string } | null
  revocationUnconfirmed?: boolean
  relayRegistrationFailed?: boolean
}

export function fetchKCoderAccount(signal?: AbortSignal): Promise<KCoderAccountStatus> {
  return request('/kcoder-account', { signal })
}

export async function signInKCoderAccount(portalUrl: string, username: string, password: string): Promise<KCoderAccountStatus> {
  if (!isProtectedRelayLoginLocation(window.location)) {
    throw Object.assign(new Error('KCODER_ACCOUNT_SECURE_ORIGIN_REQUIRED'), { code: 'KCODER_ACCOUNT_SECURE_ORIGIN_REQUIRED' })
  }
  const endpoint = new URL('/_relay/account/studio-login', portalUrl)
  if (endpoint.protocol !== 'https:') throw new Error('KCoder account service requires HTTPS')
  const response = await fetch(endpoint, {
    method: 'POST', credentials: 'omit', redirect: 'error',
    body: new URLSearchParams({ username, password }),
  })
  if (!response.ok) {
    if (response.status === 403 && (await response.json().catch(() => null))?.error === 'REGISTRATION_PASSWORD_RESET_REQUIRED') {
      throw Object.assign(new Error('KCODER_ACCOUNT_PASSWORD_RESET_REQUIRED'), { code: 'KCODER_ACCOUNT_PASSWORD_RESET_REQUIRED' })
    }
    const code = response.status === 401 ? 'KCODER_ACCOUNT_CREDENTIALS_REJECTED' :
      response.status === 429 ? 'KCODER_ACCOUNT_RATE_LIMITED' : 'KCODER_ACCOUNT_UNAVAILABLE'
    throw Object.assign(new Error(code), { code })
  }
  const { code } = await response.json()
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Invalid KCoder sign-in response')
  return request('/kcoder-account', { method: 'POST', body: JSON.stringify({ invitation: code }) })
}

export function signOutKCoderAccount(): Promise<KCoderAccountStatus> {
  return request('/kcoder-account', { method: 'DELETE' })
}
