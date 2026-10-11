import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, Loader2, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsPage, SettingsPageHeader, SettingsGroup } from './settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { getRuntimeConfig } from '@/config/runtime'
import {
  fetchMobilePairingSettings,
  revokeMobilePairingDevice,
  rotateMobilePairingCredential,
  type MobilePairingDevice,
  type MobilePairingSettings,
} from '@/kcoder/mobilePairing'

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

function pairingLink(gatewayAddress: string, token: string): string {
  const gateway = new URL(gatewayAddress.trim())
  if (
    !['https:', 'http:'].includes(gateway.protocol) ||
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash
  )
    throw new Error('请输入手机能够访问的 Gateway 地址')
  gateway.pathname = gateway.pathname.replace(/\/+$/, '')
  const link = new URL('kcoder-studio://connect')
  link.searchParams.set('gateway', gateway.toString().replace(/\/$/, ''))
  link.searchParams.set('token', token)
  const route = gateway.pathname.match(/^\/g\/([A-Za-z0-9_-]+)$/)
  if (route) link.searchParams.set('gatewayId', route[1])
  return link.toString()
}

function mobileWebPairingLink(
  mobileWebAddress: string,
  gatewayAddress: string,
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
  mobileWeb.searchParams.set('gateway', gatewayAddress)
  mobileWeb.searchParams.set('token', token)
  return mobileWeb.toString()
}

function localAddress(gatewayAddress: string): boolean {
  try {
    const hostname = new URL(gatewayAddress).hostname.toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('127.')
    )
  } catch {
    return false
  }
}

function deviceExpiry(expiresAt: number, never: string, locale: string): string {
  return expiresAt >= Number.MAX_SAFE_INTEGER
    ? never
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(expiresAt)
}

export function MobileConnectionSettingsPage({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useTranslation('common')
  const [settings, setSettings] = useState<MobilePairingSettings | null>(null)
  const [gatewayAddress, setGatewayAddress] = useState(defaultGatewayAddress)
  const [mobileWebAddress, setMobileWebAddress] = useState(defaultMobileWebAddress)
  const gatewayAddressEdited = useRef(false)
  const [loading, setLoading] = useState(true)
  const [rotating, setRotating] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const qrValue = useMemo(() => {
    if (!settings) return ''
    try {
      return pairingLink(gatewayAddress, settings.token)
    } catch {
      return ''
    }
  }, [gatewayAddress, settings])
  const mobileWebQrValue = useMemo(() => {
    if (!settings || !qrValue || localAddress(mobileWebAddress)) return ''
    try {
      return mobileWebPairingLink(mobileWebAddress, gatewayAddress, settings.token)
    } catch {
      return ''
    }
  }, [gatewayAddress, mobileWebAddress, qrValue, settings])

  const load = useCallback(async () => {
    try {
      const result = await fetchMobilePairingSettings()
      setSettings(result)
      if (!gatewayAddressEdited.current) {
        setGatewayAddress(result.publicBaseUrl || defaultGatewayAddress())
      }
      setError('')
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('workbench.mobile_connection_load_failed')
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])
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

  const copyLink = async () => {
    if (!qrValue) return
    try {
      await navigator.clipboard.writeText(qrValue)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError(t('workbench.mobile_connection_copy_failed'))
    }
  }

  return (
    <SettingsPage data-testid="mobile-connection-settings-page">
      {!embedded ? (
        <SettingsPageHeader
          title={t('workbench.settings_nav_mobile_connection')}
          description={t('workbench.mobile_connection_description')}
        />
      ) : null}

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
          <section className="flex flex-col items-center gap-4 rounded-2xl bg-surface/50 p-5 text-center">
            <h2 className="heading-sm">{t('workbench.mobile_connection_web_title')}</h2>
            {mobileWebQrValue ? (
              <div className="rounded-xl bg-white p-3" data-testid="mobile-web-pairing-qr">
                <QRCodeSVG
                  value={mobileWebQrValue}
                  size={208}
                  level="M"
                  marginSize={2}
                  title={t('workbench.mobile_connection_web_title')}
                />
              </div>
            ) : (
              <div className="flex min-h-40 max-w-md items-center justify-center text-sm text-text-secondary">
                {localAddress(mobileWebAddress)
                  ? t('workbench.mobile_connection_web_local_warning')
                  : t('workbench.mobile_connection_web_address_invalid')}
              </div>
            )}
            <div className="w-full max-w-xl text-left">
              <label htmlFor="mobile-web-address" className="mb-1.5 block text-sm font-medium">
                {t('workbench.mobile_connection_web_address_label')}
              </label>
              <input
                id="mobile-web-address"
                data-testid="mobile-web-address"
                type="url"
                value={mobileWebAddress}
                onChange={event => setMobileWebAddress(event.target.value)}
                autoComplete="url"
                spellCheck={false}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {localAddress(mobileWebAddress)
                  ? t('workbench.mobile_connection_web_local_warning')
                  : t('workbench.mobile_connection_web_help')}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  if (!mobileWebQrValue) return
                  try {
                    await navigator.clipboard.writeText(mobileWebQrValue)
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1600)
                  } catch {
                    setError(t('workbench.mobile_connection_copy_failed'))
                  }
                }}
                disabled={!mobileWebQrValue}
                data-testid="mobile-web-pairing-copy-link"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied
                  ? t('workbench.mobile_connection_copied')
                  : t('workbench.mobile_connection_copy_link')}
              </Button>
            </div>
          </section>
          <section className="flex flex-col items-center gap-4 rounded-2xl bg-surface/50 p-5 text-center">
            <h2 className="heading-sm">{t('workbench.mobile_connection_app_title')}</h2>
            {qrValue ? (
              <div className="rounded-xl bg-white p-3" data-testid="mobile-pairing-qr">
                <QRCodeSVG
                  value={qrValue}
                  size={232}
                  level="M"
                  marginSize={2}
                  title={t('workbench.mobile_connection_qr_title')}
                />
              </div>
            ) : (
              <div className="flex min-h-48 max-w-md items-center justify-center text-sm text-text-secondary">
                {t('workbench.mobile_connection_address_invalid')}
              </div>
            )}
            <div className="w-full max-w-xl text-left">
              <label htmlFor="mobile-gateway-address" className="mb-1.5 block text-sm font-medium">
                {t('workbench.mobile_connection_address_label')}
              </label>
              <input
                id="mobile-gateway-address"
                data-testid="mobile-gateway-address"
                type="url"
                value={gatewayAddress}
                onChange={event => {
                  gatewayAddressEdited.current = true
                  setGatewayAddress(event.target.value)
                }}
                autoComplete="url"
                spellCheck={false}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {localAddress(gatewayAddress)
                  ? t('workbench.mobile_connection_local_address_warning')
                  : t('workbench.mobile_connection_address_help')}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="outline"
                onClick={() => void copyLink()}
                disabled={!qrValue}
                data-testid="mobile-pairing-copy-link"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied
                  ? t('workbench.mobile_connection_copied')
                  : t('workbench.mobile_connection_copy_link')}
              </Button>
              <Button
                variant="outline"
                onClick={() => void rotate()}
                disabled={rotating}
                data-testid="mobile-pairing-rotate"
              >
                {rotating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {t('workbench.mobile_connection_rotate')}
              </Button>
            </div>
            <p className="text-xs text-text-secondary" data-testid="mobile-pairing-expiry">
              {t('workbench.mobile_connection_expires', {
                date: new Intl.DateTimeFormat(i18n.language, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(settings.expiresAt),
              })}
            </p>
          </section>

          <section>
            <div className="mb-3 flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-text-secondary" aria-hidden="true" />
              <h2 className="heading-sm">{t('workbench.mobile_connection_devices')}</h2>
              <span className="text-sm text-text-secondary">{settings.devices.length}</span>
            </div>
            {settings.devices.length === 0 ? (
              <p className="rounded-xl bg-surface/40 px-4 py-5 text-sm text-text-secondary">
                {t('workbench.mobile_connection_devices_empty')}
              </p>
            ) : (
              <SettingsGroup>
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
              </SettingsGroup>
            )}
          </section>
          <p className="text-xs leading-relaxed text-text-secondary">
            {t('workbench.mobile_connection_security_note')}
          </p>
        </div>
      ) : null}
    </SettingsPage>
  )
}
