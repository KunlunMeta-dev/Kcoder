import { useEffect, useMemo, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, ExternalLink, Loader2, QrCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { MobileConnectionSettingsPage } from './MobileConnectionSettingsPage'
import {
  createBrowserLoginUrl,
  fetchBrowserAccessInfo,
  type BrowserAccessInfo,
} from '@/kcoder/browserAccess'
import { SettingsPage, SettingsPageHeader, SettingsGroup, SettingsRow } from './settings-ui'

export function BrowserAccessSettingsPage() {
  const { t } = useTranslation('common')
  const [info, setInfo] = useState<BrowserAccessInfo | null>(null)
  const [localAddress, setLocalAddress] = useState('')
  const [phoneAddress, setPhoneAddress] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  useEffect(() => {
    let active = true
    void fetchBrowserAccessInfo()
      .then(value => {
        if (!active) return
        setInfo(value)
        setLocalAddress(value.localBaseUrl)
        setPhoneAddress(value.publicBaseUrl || '')
      })
      .catch(cause => active && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      active = false
    }
  }, [])

  const localLink = useMemo(() => {
    try {
      return info ? createBrowserLoginUrl(localAddress, info.token) : ''
    } catch {
      return ''
    }
  }, [info, localAddress])
  const phoneLink = useMemo(() => {
    try {
      return info && phoneAddress ? createBrowserLoginUrl(phoneAddress, info.token) : ''
    } catch {
      return ''
    }
  }, [info, phoneAddress])

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
      window.setTimeout(() => setCopied(''), 1600)
      setError('')
    } catch {
      setError(t('workbench.browser_access_copy_failed'))
    }
  }

  const open = async (value: string) => {
    if (value) await openExternalUrl(value, { target: 'system' })
  }

  return (
    <SettingsPage data-testid="browser-access-settings-page">
      <SettingsPageHeader
        title={t('workbench.settings_nav_access_links')}
        description={t('workbench.access_links_description')}
      />
      {!info && !error ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="size-4 animate-spin" />
          {t('workbench.browser_access_loading')}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mb-4 text-sm text-status-error">
          {error}
        </p>
      ) : null}
      {info ? (
        <div className="flex flex-col gap-6">
          <MobileConnectionSettingsPage embedded />
          <section>
            <h2 className="mb-2 text-sm font-semibold text-text-primary">
              {t('workbench.browser_access_local_title')}
            </h2>
            <SettingsGroup>
              <SettingsRow
                label={t('workbench.browser_access_address')}
                description={t('workbench.browser_access_local_help')}
                control={
                  <input
                    aria-label={t('workbench.browser_access_address')}
                    className="min-w-64 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    value={localAddress}
                    onChange={event => setLocalAddress(event.target.value)}
                  />
                }
              />
              <SettingsRow
                label={t('workbench.browser_access_login_link')}
                control={
                  <div className="flex gap-2">
                    <Button disabled={!localLink} onClick={() => void copy('local', localLink)}>
                      {copied === 'local' ? <Check /> : <Copy />}
                      {copied === 'local'
                        ? t('workbench.browser_access_copied')
                        : t('workbench.browser_access_copy')}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!localLink}
                      onClick={() => void open(localLink)}
                    >
                      <ExternalLink />
                      {t('workbench.browser_access_open')}
                    </Button>
                  </div>
                }
              />
            </SettingsGroup>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-text-primary">
              {t('workbench.browser_access_phone_title')}
            </h2>
            <SettingsGroup>
              <SettingsRow
                label={t('workbench.browser_access_phone_address')}
                description={t('workbench.browser_access_phone_help')}
                control={
                  <input
                    aria-label={t('workbench.browser_access_phone_address')}
                    className="min-w-64 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    value={phoneAddress}
                    placeholder="https://relay.example/g/gateway-id"
                    onChange={event => setPhoneAddress(event.target.value)}
                  />
                }
              />
              <SettingsRow
                label={t('workbench.browser_access_qr')}
                description={phoneLink ? undefined : t('workbench.browser_access_qr_unavailable')}
                control={
                  phoneLink ? (
                    <div className="rounded-xl bg-white p-3">
                      <QRCodeSVG
                        data-testid="browser-access-qr"
                        value={phoneLink}
                        size={176}
                        level="M"
                        title={t('workbench.browser_access_qr')}
                      />
                    </div>
                  ) : (
                    <QrCode className="size-8 text-text-tertiary" />
                  )
                }
              />
              {phoneLink ? (
                <SettingsRow
                  label={t('workbench.browser_access_login_link')}
                  control={
                    <div className="flex gap-2">
                      <Button onClick={() => void copy('phone', phoneLink)}>
                        {copied === 'phone' ? <Check /> : <Copy />}
                        {copied === 'phone'
                          ? t('workbench.browser_access_copied')
                          : t('workbench.browser_access_copy')}
                      </Button>
                      <Button variant="outline" onClick={() => void open(phoneLink)}>
                        <ExternalLink />
                        {t('workbench.browser_access_open')}
                      </Button>
                    </div>
                  }
                />
              ) : null}
            </SettingsGroup>
          </section>
        </div>
      ) : null}
    </SettingsPage>
  )
}
