import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@/lib/runtime-commands'
import { UserRound, Plus, ChevronLeft, ChevronRight, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { createRandomUuid } from '@/lib/random-id'
import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import { setEmbeddedBrowserOcclusion } from '@/lib/embedded-browser'
import type {
  BrowserAccountProfile,
  BrowserAccountProfilePage,
  BrowserProfileSelection,
  IntegrationScope,
} from '../../../../../shared/generated/contracts'

interface Catalog {
  available: boolean
  targetId: string
  targetLabel: string
  scope?: IntegrationScope
  page?: BrowserAccountProfilePage
}
interface Choice {
  selection: BrowserProfileSelection
  profile: BrowserAccountProfile
  gatewayTargetId: string
}
const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60'

interface ControlsProps {
  label: string
  choice: Choice | null
  onSelect: (choice: Choice | null) => Promise<void>
}
export function BrowserAccountControls(props: ControlsProps) {
  return <AccountControlsContent key={props.label} {...props} />
}
function AccountControlsContent({ label, choice, onSelect }: ControlsProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const [name, setName] = useState('')
  const [account, setAccount] = useState('')
  const [purpose, setPurpose] = useState<'business' | 'personal'>('business')
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const [page, setPage] = useState(0)
  const epoch = useRef(0)
  const write = useRef<{ key: string; operationId: string; id: string } | null>(null)
  const targetId = catalog?.targetId
  useEffect(
    () =>
      listenAccountContextChanges(target => {
        if (!targetId || targetId === target) {
          epoch.current += 1
          setCatalog(null)
          setOpen(false)
          setPending(false)
        }
      }),
    [targetId]
  )
  useEffect(
    () => () => {
      epoch.current += 1
    },
    []
  )

  useEffect(() => {
    if (!open) return
    const id = `browser-account-dialog:${label}`
    setEmbeddedBrowserOcclusion(id, true)
    return () => setEmbeddedBrowserOcclusion(id, false)
  }, [open, label])

  const load = async (after?: string) => {
    const revision = ++epoch.current
    setPending(true)
    setError(false)
    try {
      const result = await invoke<Catalog>('embedded_browser_profiles', {
        label,
        action: 'list',
        payload: { after: after ?? null, includeArchived: false },
      })
      if (revision === epoch.current) setCatalog(result)
    } catch {
      if (revision === epoch.current) setError(true)
    } finally {
      if (revision === epoch.current) setPending(false)
    }
  }
  const select = async (profile: BrowserAccountProfile | null) => {
    if (profile && !catalog?.scope) return
    setPending(true)
    setError(false)
    const revision = epoch.current
    try {
      await onSelect(
        profile
          ? {
              profile,
              gatewayTargetId: catalog!.targetId,
              selection: {
                scope: catalog!.scope!,
                profileId: profile.draft.id,
                expectedRevision: profile.revision,
                operationId: createRandomUuid(),
              },
            }
          : null
      )
      if (revision === epoch.current) setOpen(false)
    } catch {
      if (revision === epoch.current) setError(true)
    } finally {
      if (revision === epoch.current) setPending(false)
    }
  }
  const save = async () => {
    if (!catalog?.scope || !name.trim()) return
    const key = JSON.stringify([catalog.scope, name.trim(), account.trim(), purpose])
    if (!write.current || write.current.key !== key)
      write.current = { key, operationId: createRandomUuid(), id: createRandomUuid() }
    const operation = write.current
    const revision = epoch.current
    setPending(true)
    setError(false)
    try {
      await invoke('embedded_browser_profiles', {
        label,
        action: 'save',
        scope: catalog.scope,
        operationId: operation.operationId,
        payload: {
          draft: {
            id: operation.id,
            label: name.trim(),
            accountLabel: account.trim() || null,
            purpose,
          },
          expectedRevision: 0,
        },
      })
      if (revision !== epoch.current) return
      write.current = null
      setName('')
      setAccount('')
      setPage(0)
      setCursors([undefined])
      await load()
    } catch {
      if (revision === epoch.current) setError(true)
    } finally {
      if (revision === epoch.current) setPending(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="max-w-36 shrink-0 max-md:min-h-11"
        aria-label={t('workbench.browser_accounts')}
        disabled={pending}
        onClick={() => {
          setOpen(true)
          void load(cursors[page])
        }}
      >
        <UserRound className="h-4 w-4 shrink-0" />
        <span className="truncate">
          {choice?.profile.draft.label ?? t('workbench.browser_temporary')}
        </span>
      </Button>
      {open && (
        <ModalDialog
          title={t('workbench.browser_accounts')}
          testId="browser-account-dialog"
          pending={pending}
          closeLabel={t('workbench.browser_accounts_close')}
          onClose={() => setOpen(false)}
        >
          <div className="mt-4 space-y-4">
            {catalog?.targetLabel && (
              <p className="text-sm text-text-secondary">
                {t('workbench.browser_account_target', { target: catalog.targetLabel })}
              </p>
            )}
            <p className="text-sm leading-relaxed text-text-secondary">
              {t('workbench.browser_account_help')}
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {t('workbench.browser_account_error')}
              </p>
            )}
            {catalog?.available === false ? (
              <p className="rounded-xl border border-border p-3 text-sm">
                {t('workbench.browser_account_unsupported')}
              </p>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  disabled={pending}
                  onClick={() => void select(null)}
                >
                  {t('workbench.browser_temporary')}
                </Button>
                <div className="space-y-2" data-testid="browser-account-list">
                  {catalog?.page?.items.map(profile => (
                    <Button
                      key={profile.draft.id}
                      type="button"
                      variant="outline"
                      className="h-auto min-h-11 w-full justify-start py-3 text-left"
                      disabled={pending}
                      onClick={() => void select(profile)}
                    >
                      <UserRound className="h-4 w-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="block truncate">{profile.draft.label}</span>
                        {profile.draft.accountLabel && (
                          <span className="block truncate text-xs font-normal text-text-muted">
                            {profile.draft.accountLabel}
                          </span>
                        )}
                      </span>
                    </Button>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending || page === 0}
                    aria-label={t('workbench.browser_accounts_previous')}
                    onClick={() => {
                      setPage(page - 1)
                      void load(cursors[page - 1])
                    }}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-xs text-text-muted">
                    {t('workbench.browser_accounts_page', { page: page + 1 })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending || !catalog?.page?.nextCursor}
                    aria-label={t('workbench.browser_accounts_next')}
                    onClick={() => {
                      const next = catalog?.page?.nextCursor
                      if (!next) return
                      setCursors([...cursors.slice(0, page + 1), next])
                      setPage(page + 1)
                      void load(next)
                    }}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
                <details className="studio-card-spacing rounded-xl border border-border">
                  <summary className="cursor-pointer text-sm font-medium">
                    {t('workbench.browser_account_add')}
                  </summary>
                  <form
                    className="mt-3 space-y-3"
                    onSubmit={event => {
                      event.preventDefault()
                      void save()
                    }}
                  >
                    <label className="block space-y-1 text-sm">
                      <span>{t('workbench.browser_account_name')}</span>
                      <input
                        className={fieldClass}
                        value={name}
                        maxLength={80}
                        disabled={pending}
                        onChange={event => setName(event.target.value)}
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>{t('workbench.browser_account_label')}</span>
                      <input
                        className={fieldClass}
                        value={account}
                        maxLength={80}
                        disabled={pending}
                        onChange={event => setAccount(event.target.value)}
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>{t('workbench.browser_account_purpose')}</span>
                      <SettingsSelect
                        className={fieldClass}
                        value={purpose}
                        disabled={pending}
                        onChange={event => setPurpose(event.target.value as typeof purpose)}
                      >
                        <option value="business">{t('workbench.browser_account_business')}</option>
                        <option value="personal">{t('workbench.browser_account_personal')}</option>
                      </SettingsSelect>
                    </label>
                    <Button type="submit" disabled={pending || !name.trim()}>
                      <Plus className="h-4 w-4" />
                      {t('workbench.browser_account_save')}
                    </Button>
                  </form>
                </details>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => void load(cursors[page])}
            >
              <RotateCw className="h-4 w-4" />
              {t('workbench.browser_accounts_refresh')}
            </Button>
          </div>
        </ModalDialog>
      )}
    </>
  )
}

export type { Choice as BrowserAccountChoice }
