import { useEffect, useMemo, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, ExternalLink, Loader2, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { GatewayConnectionSettings } from './GatewayConnectionSettings'
import { AccessLinkPanel, AccessLinkRow, accessAddressClass } from './access-link-layout'
import {
  createBrowserLoginUrl,
  fetchBrowserAccessInfo,
  type BrowserAccessInfo,
} from '@/kcoder/browserAccess'
import { SettingsPage, SettingsPageHeader } from './settings-ui'
import { StableLabel } from '@/components/ui/stable-content'

export function BrowserAccessSettingsPage() {
  const { t } = useTranslation('common')
  const [info, setInfo] = useState<BrowserAccessInfo | null>(null)
  const [localAddress, setLocalAddress] = useState('')
  const [publicAddressOverride, setPublicAddressOverride] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const [refreshRevision, setRefreshRevision] = useState(0)
  const [replacing, setReplacing] = useState(false)

  useEffect(() => {
    let active = true
    void fetchBrowserAccessInfo()
      .then(value => {
        if (!active) return
        setInfo(value)
        setLocalAddress(current => current || value.localBaseUrl)
      })
      .catch(cause => active && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      active = false
    }
  }, [refreshRevision])

  const replaceLinks = async () => {
    if (!info || replacing) return
    setReplacing(true)
    try { setInfo(await fetchBrowserAccessInfo(info.token)); setError('') }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      // Read the current generation after a lost reply; never repeat a rotation.
      setRefreshRevision(value => value + 1)
    } finally { setReplacing(false) }
  }

  const localLink = useMemo(() => {
    try {
      return info ? createBrowserLoginUrl(localAddress, info.token, info.linkKind ?? 'legacy') : ''
    } catch {
      return ''
    }
  }, [info, localAddress])
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

  const linkActions = (key: string, link: string) => (
    <div className="flex flex-wrap gap-2">
      <Button disabled={!link} onClick={() => void copy(key, link)}>
        {copied === key ? <Check /> : <Copy />}
        <StableLabel alternatives={[t('workbench.browser_access_copied'), t('workbench.browser_access_copy')]}>{t(copied === key ? 'workbench.browser_access_copied' : 'workbench.browser_access_copy')}</StableLabel>
      </Button>
      <Button variant="outline" disabled={!link} onClick={() => void open(link)}>
        <ExternalLink />
        {t('workbench.browser_access_open')}
      </Button>
    </div>
  )

  return (
    <SettingsPage data-testid="browser-access-settings-page">
      <SettingsPageHeader
        title={t('workbench.settings_nav_access_links')}
        description={t('workbench.access_links_description')}
      />
      {info?.linkKind === 'single-use' && <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">{t('workbench.browser_access_single_use')}</p>
        <Button variant="outline" onClick={() => { setError(''); setRefreshRevision(value => value + 1) }}>
          {t('workbench.browser_access_refresh')}
        </Button>
      </div>}
      {info?.linkKind === 'persistent' && <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">{t('workbench.browser_access_persistent')}</p>
        <Button variant="outline" disabled={replacing} onClick={() => void replaceLinks()}>
          {t('workbench.browser_access_replace')}
        </Button>
      </div>}
      {!info && !error ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="size-4 animate-spin" />
          {t('workbench.browser_access_loading')}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {info ? (
        <div className="space-y-6">
          <GatewayConnectionSettings desktopWeb={publicBaseUrl => {
            const publicAddress = publicAddressOverride ?? publicBaseUrl ?? ''
            let publicLink = ''
            try { if (publicAddress) publicLink = createBrowserLoginUrl(publicAddress, info.token) } catch { /* Invalid address. */ }
            return (
              <AccessLinkPanel qr={publicLink && (
                <div className="max-w-full rounded-xl bg-white p-2">
                  <QRCodeSVG data-testid="browser-access-qr" className="h-auto w-44 max-w-full"
                    value={publicLink} size={176} level="M" marginSize={2} title={t('workbench.browser_access_qr')} />
                </div>
              )}>
                <div>
                  <label htmlFor="public-browser-address" className="mb-1.5 block text-sm font-medium">
                    {t('workbench.browser_access_public_address')}
                  </label>
                  <input id="public-browser-address" type="url" autoComplete="url" spellCheck={false}
                    className={accessAddressClass} value={publicAddress} placeholder="https://relay.example/g/gateway-id"
                    onChange={event => setPublicAddressOverride(event.target.value)} />
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                    {t(publicLink ? 'workbench.browser_access_public_help' : 'workbench.browser_access_qr_unavailable')}
                  </p>
                </div>
                {linkActions('public', publicLink)}
              </AccessLinkPanel>
            )
          }} />
          <div className="overflow-hidden rounded-2xl border border-border/60 bg-background">
            <AccessLinkRow id="access-local-browser" title={t('workbench.browser_access_local_title')}
              description={t('workbench.access_links_local_description')} icon={<Monitor />}>
              <AccessLinkPanel>
                <div>
                  <label htmlFor="local-browser-address" className="mb-1.5 block text-sm font-medium">
                    {t('workbench.browser_access_address')}
                  </label>
                  <input id="local-browser-address" type="url" autoComplete="url" spellCheck={false}
                    className={accessAddressClass} value={localAddress}
                    onChange={event => setLocalAddress(event.target.value)} />
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{t('workbench.browser_access_local_help')}</p>
                </div>
                {linkActions('local', localLink)}
              </AccessLinkPanel>
            </AccessLinkRow>
          </div>
        </div>
      ) : null}
    </SettingsPage>
  )
}
