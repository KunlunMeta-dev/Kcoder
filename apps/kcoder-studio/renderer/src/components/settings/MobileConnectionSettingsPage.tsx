import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, ChevronDown, Copy, ExternalLink, Globe, Laptop, Loader2, Network, RefreshCw, ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsIcon, SettingsPage, SettingsPageHeader, SettingsSwitch, StatusChip } from './settings-ui'
import { AccessLinkPanel, AccessLinkRow, accessAddressClass } from './access-link-layout'
import { useTranslation } from '@/hooks/useTranslation'
import { getRuntimeConfig } from '@/config/runtime'
import { openExternalUrl } from '@/lib/external-links'
import { KCoderAccountDialog } from '@/components/layout/KCoderAccountDialog'
import {
  fetchMobilePairingSettings,
  revokeMobilePairingDevice,
  rotateMobilePairingCredential,
  type MobilePairingDevice,
  type MobilePairingSettings,
  fetchGatewayRelayState,
  activateGatewayRelay,
  restartGatewayForRelay,
  type GatewayRelayState,
  switchGatewayRelay,
  cancelGatewayRelaySwitch,
  rollbackGatewayRelay,
  revokeGatewayRelay,
  applyGatewayRelay,
  updateGatewayPublicAccess,
  type GatewayPublicAccess,
  fetchKCoderAccount,
  type KCoderAccountStatus,
} from '@/kcoder/mobilePairing'
import {
  canonicalGatewayConnectionUrl,
  parseGatewayConnectionRoutes,
  type GatewayConnectionRoutes,
} from '../../../../shared/gatewayConnectionRoutes.js'

interface PairingTarget {
  gatewayAddress: string
  gatewayRouteId?: string
  connectionRoutes?: GatewayConnectionRoutes
}

type PairingTargetError = 'address' | 'routes-invalid' | 'candidate-mismatch' | 'loopback'

type PairingTargetResult =
  | { target: PairingTarget; error: null }
  | { target: null; error: PairingTargetError }

const MAX_PAIRING_LINK_LENGTH = 8192

function defaultGatewayAddress(): string {
  const { origin, pathname } = window.location
  const routedGateway = pathname.match(/^(.*\/g\/[A-Za-z0-9_-]+)(?:\/|$)/)?.[1]
  if (routedGateway) return `${origin}${routedGateway}`
  return `${origin}${getRuntimeConfig().appBasePath}`.replace(/\/$/, '')
}

function defaultMobileWebAddress(): string {
  const url = new URL(window.location.origin)
  url.port = '4175'
  return url.origin
}

function pairingTarget(
  gatewayAddress: string,
  rawRoutes: unknown,
  hasConnectionRoutes: boolean
): PairingTargetResult {
  let gateway: URL
  try {
    gateway = new URL(gatewayAddress.trim())
  } catch {
    return { target: null, error: 'address' }
  }
  if (
    !['https:', 'http:'].includes(gateway.protocol) ||
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash
  ) return { target: null, error: 'address' }
  gateway.pathname = gateway.pathname.replace(/\/+$/, '') || '/'
  const canonicalAddress = gateway.toString().replace(/\/$/, '')
  if (localAddress(canonicalAddress)) return { target: null, error: 'loopback' }
  const gatewayRouteId = gateway.pathname.match(/^\/g\/([A-Za-z0-9_-]{1,64})$/)?.[1]

  let connectionRoutes: GatewayConnectionRoutes | undefined
  if (hasConnectionRoutes) {
    const descriptor = parseGatewayConnectionRoutes(rawRoutes)
    if (!descriptor) return { target: null, error: 'routes-invalid' }
    const canonicalCandidate = canonicalGatewayConnectionUrl(canonicalAddress)
    if (!canonicalCandidate || !descriptor.endpoints.some(endpoint => endpoint.url === canonicalCandidate)) {
      return { target: null, error: 'candidate-mismatch' }
    }
    connectionRoutes = descriptor
  }

  return {
    target: {
      gatewayAddress: canonicalAddress,
      ...(gatewayRouteId ? { gatewayRouteId } : {}),
      ...(connectionRoutes ? { connectionRoutes } : {}),
    },
    error: null,
  }
}

function pairingLink(target: PairingTarget, token: string): string {
  const link = new URL('kcoder-studio://connect')
  link.searchParams.set('gateway', target.gatewayAddress)
  link.searchParams.set('token', token)
  if (target.gatewayRouteId) link.searchParams.set('gatewayId', target.gatewayRouteId)
  if (target.connectionRoutes) link.searchParams.set('routes', JSON.stringify(target.connectionRoutes))
  if (link.toString().length > MAX_PAIRING_LINK_LENGTH) throw new Error('Pairing link is too long')
  return link.toString()
}

function mobileWebPairingLink(
  mobileWebAddress: string,
  target: PairingTarget,
  token: string
): string {
  const mobileWeb = new URL(mobileWebAddress.trim())
  if (
    !['https:', 'http:'].includes(mobileWeb.protocol) ||
    mobileWeb.username ||
    mobileWeb.password ||
    mobileWeb.search ||
    mobileWeb.hash
  ) {
    throw new Error('请输入有效的移动 Web 地址')
  }
  const basePath = mobileWeb.pathname.replace(/\/+$/, '')
  mobileWeb.pathname = `${basePath}/connect`
  mobileWeb.searchParams.set('gateway', target.gatewayAddress)
  if (target.gatewayRouteId) mobileWeb.searchParams.set('gatewayId', target.gatewayRouteId)
  if (target.connectionRoutes) mobileWeb.searchParams.set('routes', JSON.stringify(target.connectionRoutes))
  mobileWeb.hash = new URLSearchParams({ token }).toString()
  if (mobileWeb.toString().length > MAX_PAIRING_LINK_LENGTH) throw new Error('Pairing link is too long')
  return mobileWeb.toString()
}

function localAddress(gatewayAddress: string): boolean {
  try {
    const hostname = new URL(gatewayAddress).hostname.toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname === '0.0.0.0' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('127.')
    )
  } catch {
    return false
  }
}

function relayOriginChanged(current: string | null | undefined, candidate: string): boolean {
  try { return new URL(current || '').origin !== new URL(candidate.trim()).origin }
  catch { return false }
}

function deviceExpiry(expiresAt: number, never: string, locale: string): string {
  return expiresAt >= Number.MAX_SAFE_INTEGER
    ? never
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(expiresAt)
}

export function MobileConnectionSettingsPage({ embedded = false, desktopWeb }: {
  embedded?: boolean; desktopWeb?: (publicBaseUrl: string | null) => ReactNode
}) {
  const { t, i18n } = useTranslation('common')
  const [settings, setSettings] = useState<MobilePairingSettings | null>(null)
  const [gatewayAddress, setGatewayAddress] = useState(defaultGatewayAddress)
  const [mobileWebAddress, setMobileWebAddress] = useState(defaultMobileWebAddress)
  const gatewayAddressEdited = useRef(false)
  const [loading, setLoading] = useState(true)
  const [rotating, setRotating] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<'app' | 'web' | null>(null)
  const [activationLink, setActivationLink] = useState('')
  const [relayLoginMethod, setRelayLoginMethod] = useState<'invite' | 'account'>('invite')
  const [relayUsername, setRelayUsername] = useState('')
  const [relayPassword, setRelayPassword] = useState('')
  const [relayAuthRejected, setRelayAuthRejected] = useState(false)
  const [activating, setActivating] = useState(false)
  const [savingAccess, setSavingAccess] = useState(false)
  const [relayState, setRelayState] = useState<GatewayRelayState | null>(null)
  const [account, setAccount] = useState<KCoderAccountStatus | null>(null)
  const [showAccountLogin, setShowAccountLogin] = useState(false)
  const [restartingRelay, setRestartingRelay] = useState<string | false | null>(null)
  const [editingRelay, setEditingRelay] = useState(false)
  const [relayAddress, setRelayAddress] = useState('')
  const relayAddressEdited = useRef(false)
  const mobileWebAddressEdited = useRef(false)
  const switchRequestId = useRef<string | null>(null)
  const targetResult = useMemo<PairingTargetResult | null>(() => {
    if (!settings) return null
    return pairingTarget(
      gatewayAddress,
      settings.connectionRoutes,
      Object.prototype.hasOwnProperty.call(settings, 'connectionRoutes')
    )
  }, [gatewayAddress, settings])
  const target = targetResult?.target ?? null
  const publicPairingPending = target && target.gatewayAddress === settings?.publicBaseUrl &&
    (settings?.publicReadiness === 'preparing' || settings?.publicReadiness === 'failed')
  const qrValue = useMemo(() => {
    if (!settings || !target || publicPairingPending) return ''
    try {
      return pairingLink(target, settings.token)
    } catch {
      return ''
    }
  }, [settings, target, publicPairingPending])
  const mobileWebQrValue = useMemo(() => {
    if (!settings || !target || publicPairingPending || localAddress(mobileWebAddress)) return ''
    try {
      return mobileWebPairingLink(mobileWebAddress, target, settings.webToken ?? settings.token)
    } catch {
      return ''
    }
  }, [mobileWebAddress, settings, target, publicPairingPending])
  const pairingErrorKey = publicPairingPending
    ? (settings?.publicReadiness === 'failed' ? 'workbench.mobile_connection_public_retrying' : 'workbench.mobile_connection_public_preparing')
    : targetResult?.error === 'loopback'
    ? 'workbench.mobile_connection_local_address_warning'
    : targetResult?.error === 'address'
    ? 'workbench.mobile_connection_address_invalid'
    : targetResult?.error === 'routes-invalid'
      ? 'workbench.mobile_connection_routes_invalid'
      : targetResult?.error === 'candidate-mismatch'
        ? 'workbench.mobile_connection_route_mismatch'
        : settings && target && !qrValue
          ? 'workbench.mobile_connection_link_too_long'
          : ''

  const load = useCallback(async () => {
    try {
      const [result, relay] = await Promise.all([fetchMobilePairingSettings(), fetchGatewayRelayState()])
      setSettings(result)
      setRelayState(relay)
      if (!relayAddressEdited.current) setRelayAddress(relay.switchAttempt?.url || relay.relayUrl || '')
      if (!gatewayAddressEdited.current) {
        setGatewayAddress(result.publicBaseUrl || defaultGatewayAddress())
      }
      if (embedded && !mobileWebAddressEdited.current) {
        setMobileWebAddress(result.publicBaseUrl ? result.publicBaseUrl.replace(/\/$/, '') + '/mobile/' : defaultMobileWebAddress())
      }
      setError('')
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('workbench.mobile_connection_load_failed')
      )
    } finally {
      setLoading(false)
    }
  }, [embedded, t])

  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])
  const accountOrigin = relayState?.productAccountOrigin
  useEffect(() => {
    if (!accountOrigin) return
    const controller = new AbortController()
    void fetchKCoderAccount(controller.signal).then(value => {
      if (!controller.signal.aborted) setAccount(value)
    }).catch(() => {})
    return () => controller.abort()
  }, [accountOrigin])
  useEffect(() => {
    if (restartingRelay === null) return
    let stopped = false
    let timer: number | undefined
    const deadline = Date.now() + 120_000
    const check = async () => {
      try {
        const state = await fetchGatewayRelayState()
        if (stopped) return
        if (!state.restartRequired && (restartingRelay === false
          ? !state.configured && !state.externallyManaged
          : state.publicBaseUrl === restartingRelay)) {
          window.location.reload()
          return
        }
      } catch (error) {
        if (!stopped && (error as { status?: number })?.status === 401) {
          window.location.reload()
          return
        }
      }
      if (stopped) return
      if (Date.now() < deadline) timer = window.setTimeout(() => void check(), 1000)
      else {
        setRestartingRelay(null)
        setError(t('workbench.mobile_connection_relay_activation_failed'))
      }
    }
    timer = window.setTimeout(() => void check(), 1000)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [restartingRelay, t])
  useEffect(() => {
    if (settings?.publicReadiness !== 'preparing' && settings?.publicReadiness !== 'failed') return
    let stopped = false
    const timer = window.setTimeout(() => {
      void fetchMobilePairingSettings().then(value => {
        if (!stopped) setSettings(current => current === settings ? value : current)
      }).catch(() => {
        if (!stopped) setSettings(current => current && { ...current })
      })
    }, 2_000)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [settings])
  useEffect(() => {
    if (!settings) return
    const timeout = window.setTimeout(
      () => {
        void load()
      },
      Math.max(250, settings.expiresAt - Date.now() + 250)
    )
    return () => window.clearTimeout(timeout)
  }, [load, settings])

  const rotate = async () => {
    setRotating(true)
    setError('')
    try {
      const credential = await rotateMobilePairingCredential()
      setSettings(current =>
        current ? { ...current, ...credential } : { ...credential, devices: [] }
      )
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('workbench.mobile_connection_rotate_failed')
      )
    } finally {
      setRotating(false)
    }
  }

  const revoke = async (device: MobilePairingDevice) => {
    if (!window.confirm(t('workbench.mobile_connection_revoke_confirm', { label: device.label })))
      return
    setRevoking(device.id)
    setError('')
    try {
      await revokeMobilePairingDevice(device.id)
      await load()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('workbench.mobile_connection_revoke_failed')
      )
    } finally {
      setRevoking(null)
    }
  }

  const copyLink = async (surface: 'app' | 'web', link: string) => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(surface)
      window.setTimeout(() => setCopied(value => value === surface ? null : value), 1600)
    } catch {
      setError(t('workbench.mobile_connection_copy_failed'))
    }
  }

  const clearRelayLogin = () => {
    setActivationLink('')
    setRelayPassword('')
    setRelayUsername('')
    setRelayLoginMethod('invite')
  }

  const finishRelayChange = () => {
    clearRelayLogin()
    setEditingRelay(false)
    switchRequestId.current = null
  }

  const changeRelay = async (operation: () => Promise<GatewayRelayState>, attempt?: 'activation' | 'switch' | 'revoke') => {
    setActivating(true)
    setError('')
    setRelayAuthRejected(false)
    try {
      const state = await operation()
      setRelayState(current => ({ ...state, publicAccess: state.publicAccess ?? current?.publicAccess }))
      finishRelayChange()
      if (state.liveApplySupported) {
        const pairing = await fetchMobilePairingSettings().catch(() => null)
        if (pairing) {
          setSettings(pairing)
          if (!gatewayAddressEdited.current) setGatewayAddress(pairing.publicBaseUrl || defaultGatewayAddress())
          if (embedded && !mobileWebAddressEdited.current) {
            setMobileWebAddress(pairing.publicBaseUrl ? pairing.publicBaseUrl.replace(/\/$/, '') + '/mobile/' : defaultMobileWebAddress())
          }
        }
      }
      return true
    } catch (cause) {
      const relayError = cause instanceof Error ? cause as Error & { status?: number; code?: string } : null
      const signInRequired = relayError?.code === 'KCODER_ACCOUNT_SIGN_IN_REQUIRED'
      const loginRejected = relayError?.code === 'RELAY_ACCOUNT_LOGIN_REJECTED'
      const loginLimited = relayError?.code === 'RELAY_ACCOUNT_LOGIN_RATE_LIMITED'
      const accountCapacity = relayError?.code === 'RELAY_ACCOUNT_CAPACITY'
      const secureOriginRequired = relayError?.code === 'RELAY_LOGIN_REQUIRES_SECURE_ORIGIN'
      setRelayAuthRejected(loginRejected)
      setError(attempt === 'revoke' ? t('workbench.mobile_connection_relay_revoke_failed') : signInRequired
        ? t('workbench.kcoder_account_required')
        : relayError?.code === 'KCODER_ACCOUNT_UNAVAILABLE'
          ? t('workbench.kcoder_account_unavailable')
          : loginRejected
        ? t('workbench.mobile_connection_relay_login_rejected')
        : accountCapacity
          ? t('workbench.mobile_connection_relay_account_capacity')
        : loginLimited
          ? t('workbench.mobile_connection_relay_login_limited')
        : secureOriginRequired
          ? t('workbench.mobile_connection_relay_secure_origin')
          : t('workbench.mobile_connection_relay_change_failed'))
      // Read the durable receipt before offering another attempt with the same identity.
      try {
        const state = await fetchGatewayRelayState()
        setRelayState(state)
        const receipt = attempt === 'switch'
          ? Boolean(switchRequestId.current && state.selectedProfileId === switchRequestId.current)
          : attempt === 'activation' ? state.restartRequired && state.needsLogin === false
            : attempt === 'revoke' && state.disabled === true
        if (receipt && !state.switchAttempt) {
          finishRelayChange()
          setRelayAuthRejected(false)
          setError('')
        } else if (state.switchAttempt && !state.switchAttempt.needsActivation) {
          clearRelayLogin()
        }
      } catch { /* Keep the visible failure. */ }
    } finally { setActivating(false) }
  }

  const pendingOriginCorrection = Boolean(relayState?.needsLogin && relayState.hasPendingIdentity &&
    !relayState.configured && !relayState.externallyManaged && !relayState.switchAttempt &&
    relayOriginChanged(relayState.relayUrl, relayAddress))
  const relayTarget = relayState?.switchAttempt?.url || relayAddress.trim() || relayState?.productAccountOrigin
  const useKCoderAccount = Boolean(relayState?.productAccountOrigin &&
    relayTarget?.replace(/\/$/, '') === relayState.productAccountOrigin)
  const relaySwitchOperation = Boolean(relayState &&
    (relayState.configured || editingRelay || relayState.switchAttempt || pendingOriginCorrection))
  const needsAccountLogin = useKCoderAccount && !account?.account &&
    (!relayState?.switchAttempt || relayState.switchAttempt.needsActivation)

  const access = relayState?.publicAccess
  const surfaceLabels = {
    desktopWeb: t('workbench.access_links_public_desktop'),
    mobileWeb: t('workbench.access_links_public_mobile_web'),
    mobileApp: t('workbench.access_links_public_mobile_app'),
  }
  async function togglePublicAccess(surface: keyof GatewayPublicAccess['surfaces']) {
    if (!access || savingAccess) return
    const enabled = !access.surfaces[surface]
    const usingPublicDesktop = relayState?.publicBaseUrl &&
      window.location.origin === new URL(relayState.publicBaseUrl).origin
    if (!enabled && surface === 'desktopWeb' && usingPublicDesktop &&
        !window.confirm(t('workbench.access_links_disable_current'))) return
    setSavingAccess(true)
    setError('')
    try {
      const next = await updateGatewayPublicAccess(access.revision, { ...access.surfaces, [surface]: enabled })
      setRelayState(state => state && { ...state, publicAccess: next })
    } catch {
      const next = await fetchGatewayRelayState().catch(() => null)
      if (next) setRelayState(next)
      if (next?.publicAccess?.surfaces[surface] !== enabled) setError(t('workbench.access_links_save_unconfirmed'))
    } finally { setSavingAccess(false) }
  }

  const publicToggle = (surface: keyof GatewayPublicAccess['surfaces']) => access && (
    <SettingsSwitch aria-label={surfaceLabels[surface]} checked={access.surfaces[surface]} disabled={savingAccess}
      onCheckedChange={() => void togglePublicAccess(surface)} />
  )
  const relayStatus = relayState?.connectionStatus
  const relayStatusLabel = relayStatus === 'denied' ? 'workbench.access_links_relay_denied'
    : relayState?.restartRequired ? 'workbench.access_links_relay_pending'
    : relayStatus === 'online' ? 'workbench.access_links_relay_online'
    : relayStatus === 'offline' ? 'workbench.access_links_relay_offline'
    : relayState?.externallyManaged ? 'workbench.access_links_relay_managed'
    : relayState?.configured ? 'workbench.access_links_relay_registered' : 'workbench.access_links_relay_unconfigured'
  async function applyRelayChange(revoke: boolean) {
    if (relayState?.liveApplySupported) {
      if (activating || (revoke && !window.confirm(t('workbench.mobile_connection_relay_revoke_live_confirm')))) return
      await changeRelay(revoke ? () => revokeGatewayRelay(relayState.revision ?? 0) : applyGatewayRelay, revoke ? 'revoke' : undefined)
      return
    }
    if (!relayState || activating || restartingRelay !== null ||
        !window.confirm(t(revoke ? 'workbench.mobile_connection_relay_revoke_confirm' : 'workbench.mobile_connection_relay_restart_confirm'))) return
    setActivating(true)
    setError('')
    try {
      if (revoke) await revokeGatewayRelay(relayState.revision ?? 0)
      else await restartGatewayForRelay()
      setRestartingRelay(revoke ? false : relayState.selectedRelay?.publicBaseUrl || relayState.publicBaseUrl)
    } catch {
      setError(t(revoke ? 'workbench.mobile_connection_relay_revoke_failed' : 'workbench.mobile_connection_relay_activation_failed'))
    } finally { setActivating(false) }
  }

  const Container = embedded ? 'div' : SettingsPage
  return (
    <Container data-testid="mobile-connection-settings-page">
      {!embedded ? (
        <SettingsPageHeader
          title={t('workbench.settings_nav_mobile_connection')}
          description={t('workbench.mobile_connection_description')}
        />
      ) : null}

      {settings && relayState ? (
        <form data-testid="gateway-relay-settings" className="mb-6 space-y-3 rounded-2xl border border-border/60 bg-surface/30 p-5 max-sm:p-3" onSubmit={async event => {
          event.preventDefault()
          if (activating) return
          const credentials = !useKCoderAccount && relayLoginMethod === 'account' &&
            (!relayState.switchAttempt || relayState.switchAttempt.needsActivation)
            ? { username: relayUsername.trim(), password: relayPassword }
            : undefined
          if (relaySwitchOperation) {
            const requestId = relayState.switchAttempt?.id || switchRequestId.current || crypto.randomUUID()
            switchRequestId.current = requestId
            await changeRelay(() => switchGatewayRelay({ requestId, expectedRevision: relayState.revision ?? 0,
              relayUrl: useKCoderAccount ? relayState.productAccountOrigin! : relayState.switchAttempt?.url || relayAddress.trim(),
              ...(useKCoderAccount
                ? relayState.switchAttempt && !relayState.switchAttempt.needsActivation ? {} : { useKCoderAccount: true }
                : credentials ? { accountCredentials: credentials }
                : activationLink.trim() ? { activationLink: activationLink.trim() } : {}) }), 'switch')
          } else if (useKCoderAccount || credentials || activationLink.trim()) {
            await changeRelay(() => activateGatewayRelay(useKCoderAccount ? { useKCoderAccount: true } : {
              relayUrl: relayAddress.trim() || undefined,
              ...(credentials ? { accountCredentials: credentials } : { activationLink: activationLink.trim() }),
            }), 'activation')
          }
        }}>
          <div className="flex flex-wrap items-center gap-3">
            <SettingsIcon><Network /></SettingsIcon>
            <div className="min-w-0 flex-1">
              <h2 className="heading-sm">{t('workbench.mobile_connection_relay_title')}</h2>
              <p className="mt-0.5 text-sm text-text-secondary">{t('workbench.access_links_relay_summary')}</p>
            </div>
            <StatusChip variant={relayStatus === 'denied' ? 'destructive' : relayStatus === 'online' && !relayState.restartRequired ? 'success' : 'neutral'}>
              {t(relayStatusLabel)}
            </StatusChip>
          </div>
          {restartingRelay !== null && <p role="status" className="text-sm text-text-secondary">{t('workbench.mobile_connection_relay_restarting')}</p>}
          {relayState.restoreFailed ? <p role="alert" className="text-sm text-destructive">{t('workbench.mobile_connection_relay_restore_failed')}</p> : null}
          {relayState.configured || relayState.externallyManaged ? (
            <div className="space-y-2 border-t border-border/60 pt-3" data-testid="gateway-relay-configured">
              {relayState.connectionStatus === 'denied' ? <p role="alert" className="text-sm text-destructive">{t('workbench.mobile_connection_relay_denied')}</p> : null}
              {relayState.accountAccessStatus === 'denied' ? <p role="alert" className="text-sm text-destructive">{t(relayState.externallyManaged ? 'workbench.mobile_connection_relay_external_denied' : 'workbench.mobile_connection_relay_access_denied')}</p> : null}
              <details open={!embedded || editingRelay || undefined} className="group/relay">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
                  <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-text-muted transition-transform group-open/relay:rotate-180" />
                  {t('workbench.access_links_relay_details')}
                </summary>
                <div className="space-y-3 rounded-xl bg-background/70 p-3">
                  {relayState.publicBaseUrl && <p className="break-all text-sm text-text-secondary">{relayState.publicBaseUrl}</p>}
                  {relayState.accountAccessStatus === 'authorized' && <p className="text-sm text-text-secondary">{t('workbench.mobile_connection_relay_access_authorized')}</p>}
                  <div className="flex flex-wrap gap-2">
                    {relayState.switchSupported && !relayState.restartRequired && !editingRelay && !relayState.switchAttempt ? (
                      <Button type="button" onClick={() => { setRelayAddress(relayState.relayUrl || ''); setEditingRelay(true) }}>
                        {t('workbench.mobile_connection_relay_switch')}
                      </Button>
                    ) : null}
                    {relayState.revokeSupported && !editingRelay && (
                      <Button type="button" variant="outline" disabled={activating || restartingRelay !== null} onClick={() => void applyRelayChange(true)}>
                        {t('workbench.mobile_connection_relay_revoke')}
                      </Button>
                    )}
                  </div>
                </div>
              </details>
            </div>
          ) : null}
          {relayState.restartRequired && !relayState.needsLogin ? (
            <>
              <p className="text-sm text-text-secondary">{t(relayState.liveApplySupported ? 'workbench.mobile_connection_relay_apply_note' : 'workbench.mobile_connection_relay_restart_note')}</p>
              {relayState.selectedRelay ? <p className="break-all text-sm" data-testid="gateway-relay-selected">{t('workbench.mobile_connection_relay_selected')}{relayState.selectedRelay.publicBaseUrl}</p> : null}
              {relayState.liveApplySupported ? <Button type="button" disabled={activating} onClick={() => void applyRelayChange(false)}>
                {t('workbench.mobile_connection_relay_apply')}
              </Button> : relayState.restartSupported ? <Button type="button" disabled={activating || restartingRelay !== null} onClick={() => void applyRelayChange(false)}>
                {t('workbench.mobile_connection_relay_restart')}</Button> :
                <p className="text-sm text-text-secondary">{t('workbench.mobile_connection_relay_restart_manual')}</p>}
            </>
          ) : null}
          {relayState.previousRelay ? <Button type="button" variant="outline" disabled={activating}
            onClick={() => void changeRelay(() => rollbackGatewayRelay(relayState.revision ?? 0))}>
            {t('workbench.mobile_connection_relay_rollback')}
          </Button> : null}
          {((!relayState.configured && !relayState.externallyManaged && (!relayState.restartRequired || relayState.needsLogin || relayAuthRejected)) || editingRelay || relayState.switchAttempt) ? (
            <>
              {relayState.configured || editingRelay || pendingOriginCorrection ? <p className="text-sm text-text-secondary">{t('workbench.mobile_connection_relay_switch_note')}</p> : null}
              {relayState.switchAttempt ? <p className="text-sm" data-testid="gateway-relay-attempt">{t('workbench.mobile_connection_relay_attempt')}{relayState.switchAttempt.url}</p> : null}
              <label htmlFor="relay-address" className="block text-sm">{t('workbench.mobile_connection_relay_address')}</label>
              <input id="relay-address" type="url" className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                value={relayState.switchAttempt?.url || relayAddress} disabled={activating || Boolean(relayState.switchAttempt)}
                placeholder="https://relay.example.com" onChange={event => { relayAddressEdited.current = true; setRelayAddress(event.target.value) }} />
              {needsAccountLogin ? (
                <div className="space-y-2">
                  <p className="text-sm text-text-secondary" id="relay-account-required">{t('workbench.kcoder_account_required')}</p>
                  <Button type="button" variant="outline" aria-describedby="relay-account-required" onClick={() => setShowAccountLogin(true)}>
                    {t('workbench.kcoder_account_login')}
                  </Button>
                </div>
              ) : (!relayState.switchAttempt || relayState.switchAttempt.needsActivation) && useKCoderAccount ?
                <p className="text-sm text-text-secondary">{t('workbench.kcoder_account_enroll_note')}</p> :
                !relayState.switchAttempt || relayState.switchAttempt.needsActivation ? <>
              <fieldset className="space-y-2" disabled={activating}>
                <legend className="block text-sm">{t('workbench.mobile_connection_relay_login_method')}</legend>
                <label className="inline-flex min-h-11 items-center gap-2 pr-4 text-sm">
                  <input type="radio" name="relay-login-method" value="invite" checked={relayLoginMethod === 'invite'}
                    onChange={() => { setRelayLoginMethod('invite'); setRelayPassword(''); setRelayUsername('') }} />
                  {t('workbench.mobile_connection_relay_login_invite')}
                </label>
                <label className="inline-flex min-h-11 items-center gap-2 text-sm">
                  <input type="radio" name="relay-login-method" value="account" checked={relayLoginMethod === 'account'}
                    onChange={() => { setRelayLoginMethod('account'); setActivationLink('') }} />
                  {t('workbench.mobile_connection_relay_login_account')}
                </label>
              </fieldset>
              {relayLoginMethod === 'invite' ? <>
              <label htmlFor="relay-activation-link" className="block text-sm">{t('workbench.mobile_connection_relay_link')}</label>
              <input id="relay-activation-link" type="password" autoComplete="off" spellCheck={false}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
                value={activationLink} onChange={event => {
                  setActivationLink(event.target.value)
                  try {
                    const link = new URL(event.target.value)
                    if (link.protocol === 'https:' && ['/_relay/activate', '/_relay/login'].includes(link.pathname) && !relayState.switchAttempt) {
                      relayAddressEdited.current = true
                      setRelayAddress(link.origin)
                    }
                  } catch { /* A bare account login code uses the selected Relay address. */ }
                }} disabled={activating} />
              </> : <div className="space-y-3">
                <label htmlFor="relay-account-username" className="block text-sm">{t('workbench.mobile_connection_relay_username')}</label>
                <input id="relay-account-username" type="text" autoComplete="username" spellCheck={false} required maxLength={64}
                  pattern="[a-z0-9][a-z0-9._-]{0,63}"
                  className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  value={relayUsername} onChange={event => setRelayUsername(event.target.value)} disabled={activating} />
                <label htmlFor="relay-account-password" className="block text-sm">{t('workbench.mobile_connection_relay_password')}</label>
                <input id="relay-account-password" type="password" autoComplete="current-password" required minLength={12} maxLength={256}
                  className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  value={relayPassword} onChange={event => setRelayPassword(event.target.value)} disabled={activating} />
                <p className="text-sm text-text-secondary">{t('workbench.mobile_connection_relay_account_note')}</p>
              </div>}
              </> : <p className="text-sm text-text-secondary">{t('workbench.mobile_connection_relay_candidate_saved')}</p>}
              {!useKCoderAccount && !relayState.configured && !relayState.externallyManaged && relayLoginMethod === 'invite' ? <p className="text-sm text-text-secondary">{t('workbench.mobile_connection_relay_note')}</p> : null}
              <Button type="submit" disabled={activating || restartingRelay !== null || needsAccountLogin || (!useKCoderAccount && ((!relayState.switchAttempt && (relayLoginMethod === 'account'
                ? (!relayUsername.trim() || relayPassword.length < 12)
                : !activationLink.trim())) || (relayState.switchAttempt?.needsActivation && relayLoginMethod === 'account' && (!relayUsername.trim() || relayPassword.length < 12))))}>
                {activating ? t('workbench.mobile_connection_relay_activating') : t(relaySwitchOperation ? 'workbench.mobile_connection_relay_switch_save' : 'workbench.mobile_connection_relay_activate')}
              </Button>
              {relayState.configured || relayState.switchAttempt ? <Button type="button" variant="outline" disabled={activating} onClick={() => {
                if (relayState.switchAttempt) void changeRelay(() => cancelGatewayRelaySwitch(relayState.revision ?? 0))
                else finishRelayChange()
              }}>{t('workbench.mobile_connection_relay_switch_cancel')}</Button> : null}
            </>
          ) : null}
        </form>
      ) : null}
      {showAccountLogin && accountOrigin && <KCoderAccountDialog signOut={false}
        portalUrl={new URL('/_relay/account/', accountOrigin).href} onClose={() => setShowAccountLogin(false)}
        onDone={value => {
          setAccount(value)
          if (!value.relayRegistrationFailed) setShowAccountLogin(false)
          void load()
        }} />}

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
      {loading ? (
        <div
          className="flex items-center gap-2 py-8 text-sm text-text-secondary"
          data-testid="mobile-pairing-loading"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('common.loading')}
        </div>
      ) : settings ? (
        <div className="space-y-6">
          <section aria-labelledby="access-links-public-title" aria-busy={savingAccess} className="space-y-3">
            <div>
              <h2 id="access-links-public-title" className="heading-sm">{t('workbench.access_links_public_title')}</h2>
              {access && <p className="mt-1 text-sm text-text-secondary">{t('workbench.access_links_public_help')}</p>}
            </div>
            <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-background">
              {(desktopWeb || access) && (
                <AccessLinkRow
                  id="access-desktop-web"
                  title={t('workbench.access_links_desktop_title')}
                  description={t('workbench.access_links_desktop_description')}
                  icon={<Laptop />}
                  control={publicToggle('desktopWeb')}
                >
                  {desktopWeb && access?.surfaces.desktopWeb !== false && desktopWeb(relayState?.publicBaseUrl ?? null)}
                </AccessLinkRow>
              )}
              <AccessLinkRow
                id="access-mobile-web"
                title={t('workbench.access_links_mobile_web_title')}
                description={t('workbench.access_links_mobile_web_description')}
                icon={<Globe />}
                control={publicToggle('mobileWeb')}
                defaultOpen={!embedded}
              >
                {access?.surfaces.mobileWeb !== false && (
                  <AccessLinkPanel qr={mobileWebQrValue && (
                    <div className="max-w-full rounded-xl bg-white p-2" data-testid="mobile-web-pairing-qr">
                      <QRCodeSVG className="h-auto w-44 max-w-full" value={mobileWebQrValue} size={208} level="M"
                        marginSize={2} title={t('workbench.mobile_connection_web_title')} />
                    </div>
                  )}>
                    <div>
                      <label htmlFor="mobile-web-address" className="mb-1.5 block text-sm font-medium">
                        {t('workbench.mobile_connection_web_address_label')}
                      </label>
                      <input id="mobile-web-address" data-testid="mobile-web-address" type="url" value={mobileWebAddress}
                        onChange={event => {
                          mobileWebAddressEdited.current = true
                          setMobileWebAddress(event.target.value)
                        }}
                        autoComplete="url" spellCheck={false} className={accessAddressClass} />
                      <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                        {t(!mobileWebQrValue && pairingErrorKey ? pairingErrorKey
                          : localAddress(mobileWebAddress) ? 'workbench.mobile_connection_web_local_warning'
                          : !mobileWebQrValue ? 'workbench.mobile_connection_web_address_invalid'
                          : 'workbench.mobile_connection_web_help')}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" disabled={!mobileWebQrValue}
                        onClick={() => void openExternalUrl(mobileWebQrValue, { target: 'system' })}>
                        <ExternalLink />
                        {t('workbench.access_links_open_mobile_web')}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => void copyLink('web', mobileWebQrValue)}
                        disabled={!mobileWebQrValue}
                        data-testid="mobile-web-pairing-copy-link"
                      >
                        {copied === 'web' ? <Check /> : <Copy />}
                        {t(copied === 'web' ? 'workbench.mobile_connection_copied' : 'workbench.mobile_connection_copy_link')}
                      </Button>
                    </div>
                  </AccessLinkPanel>
                )}
              </AccessLinkRow>
              <AccessLinkRow
                id="access-mobile-app"
                title={t('workbench.mobile_connection_app_title')}
                description={t('workbench.access_links_mobile_app_description')}
                icon={<Smartphone />}
                control={publicToggle('mobileApp')}
                defaultOpen={!embedded}
              >
                {access?.surfaces.mobileApp !== false && (
                  <AccessLinkPanel qr={qrValue && (
                    <div className="max-w-full rounded-xl bg-white p-2" data-testid="mobile-pairing-qr">
                      <QRCodeSVG className="h-auto w-44 max-w-full" value={qrValue} size={232} level="M"
                        marginSize={2} title={t('workbench.mobile_connection_qr_title')} />
                    </div>
                  )}>
                    <div>
                      <label htmlFor="mobile-gateway-address" className="mb-1.5 block text-sm font-medium">
                        {t('workbench.mobile_connection_address_label')}
                      </label>
                      <input id="mobile-gateway-address" data-testid="mobile-gateway-address" type="url"
                        value={gatewayAddress} onChange={event => {
                          gatewayAddressEdited.current = true
                          setGatewayAddress(event.target.value)
                        }}
                        autoComplete="url" spellCheck={false} className={accessAddressClass} />
                      <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                        {t(pairingErrorKey || 'workbench.mobile_connection_address_help')}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" onClick={() => void copyLink('app', qrValue)} disabled={!qrValue} data-testid="mobile-pairing-copy-link">
                        {copied === 'app' ? <Check /> : <Copy />}
                        {t(copied === 'app' ? 'workbench.mobile_connection_copied' : 'workbench.mobile_connection_copy_link')}
                      </Button>
                      <Button variant="outline" onClick={() => void rotate()} disabled={rotating} data-testid="mobile-pairing-rotate">
                        {rotating ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                        {t('workbench.mobile_connection_rotate')}
                      </Button>
                    </div>
                    <p className="text-xs text-text-secondary" data-testid="mobile-pairing-expiry">
                      {t('workbench.mobile_connection_expires', {
                        date: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(settings.expiresAt),
                      })}
                    </p>
                    <p className="text-xs leading-relaxed text-text-secondary">{t('workbench.mobile_connection_security_note')}</p>
                  </AccessLinkPanel>
                )}
              </AccessLinkRow>
            </div>
          </section>

          <div className="overflow-hidden rounded-2xl border border-border/60 bg-background">
            <AccessLinkRow id="access-paired-devices" title={`${t('workbench.mobile_connection_devices')} (${settings.devices.length})`}
              description={t('workbench.access_links_devices_description')} icon={<ShieldCheck />} defaultOpen={!embedded}>
              {settings.devices.length === 0 ? (
                <p className="rounded-xl bg-surface/40 px-4 py-5 text-sm text-text-secondary">
                  {t('workbench.mobile_connection_devices_empty')}
                </p>
              ) : (
                <div className="divide-y divide-border/60 rounded-xl border border-border/60 bg-background">
                  {settings.devices.map(device => (
                    <div
                      key={device.id}
                      className="flex items-center gap-3 px-4 py-3"
                      data-testid={`mobile-paired-device-${device.id}`}
                    >
                      <Smartphone
                        className="h-4 w-4 shrink-0 text-text-secondary"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-text-primary">
                          {device.label}
                        </div>
                        <div className="text-xs text-text-secondary">
                          {t('workbench.mobile_connection_device_last_used', {
                            date: deviceExpiry(
                              device.lastUsedAt,
                              t('workbench.mobile_connection_never'),
                              i18n.language
                            ),
                          })}
                        </div>
                      </div>
                      <span className="hidden text-xs text-text-secondary sm:inline">
                        {t('workbench.mobile_connection_device_expires', {
                          date: deviceExpiry(
                            device.expiresAt,
                            t('workbench.mobile_connection_never'),
                            i18n.language
                          ),
                        })}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11 shrink-0"
                        aria-label={t('workbench.mobile_connection_revoke', { label: device.label })}
                        title={t('workbench.mobile_connection_revoke', { label: device.label })}
                        disabled={revoking === device.id}
                        onClick={() => void revoke(device)}
                        data-testid={`mobile-paired-device-revoke-${device.id}`}
                      >
                        {revoking === device.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </AccessLinkRow>
          </div>
        </div>
      ) : null}
    </Container>
  )
}
