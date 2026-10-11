import { useCallback, useEffect, useRef, useState } from 'react'
import { FileCode2, RefreshCw, Server, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconSelect, SettingsPage, SettingsPageHeader } from '@/components/settings/settings-ui'
import { RuntimeTargetConfirmDialog } from '@/components/settings/RuntimeTargetConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { fetchGatewayServers, type GatewayServer } from './gatewayRpc'
import { gatewayServerLabel } from './gatewayServerLabel'
import { hookTargetScope, type HookConfiguration } from './gatewayHookConfiguration'
import { readHookConfiguration, updateHookConfiguration } from './hookConfigurationApi'

const jsonText = (value: unknown) => JSON.stringify(value, null, 2)
function failureKind(error: unknown): string {
  const value = error as { data?: { kind?: string } }
  return value?.data?.kind ?? ''
}
export function KCoderHooksSettingsPage() {
  const { t } = useTranslation('common')
  const [targets, setTargets] = useState<GatewayServer[]>([])
  const [serverId, setServerId] = useState('')
  const [ready, setReady] = useState(false)
  const [scopeVersion, setScopeVersion] = useState(0)
  const [snapshot, setSnapshot] = useState<HookConfiguration | null>(null)
  const [draft, setDraft] = useState('')
  const [snapshotScope, setSnapshotScope] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<'reload' | 'delete' | null>(null)
  const generation = useRef(Symbol())
  const mutation = useRef(false)
  const selectedId = useRef('')
  const target = targets.find(item => item.id === serverId)
  const targetScope = target ? hookTargetScope(target) : ''
  const loginRequired = Boolean(target?.security && !target.accountIdentity)
  const dirty = Boolean(
    snapshot && snapshotScope === targetScope && draft !== jsonText(snapshot.hooks)
  )

  const invalidate = useCallback(() => {
    generation.current = Symbol()
    mutation.current = false
    setSnapshot(null)
    setSnapshotScope('')
    setDraft('')
    setLoading(false)
    setSaving(false)
    setError('')
    setNotice('')
    setConfirmation(null)
  }, [])
  useEffect(() => {
    let disposed = false,
      discovery = 0
    const discover = async (changed = false) => {
      const attempt = ++discovery
      if (changed) {
        invalidate()
        setReady(false)
        setTargets([])
      }
      try {
        const items = await fetchGatewayServers()
        if (disposed || attempt !== discovery) return
        setTargets(items)
        setReady(true)
        setServerId(previous =>
          items.some(item => item.id === previous) ? previous : (items[0]?.id ?? '')
        )
        if (changed) setScopeVersion(value => value + 1)
      } catch {
        if (!disposed && attempt === discovery) setError('readFailed')
      }
    }
    void discover()
    const changed = (event: Event) => {
      const changedId = (event as CustomEvent<{ targetId?: string }>).detail?.targetId
      if (changedId && changedId !== selectedId.current) return
      void discover(true)
    }
    window.addEventListener('kcoder:servers-changed', changed)
    return () => {
      disposed = true
      generation.current = Symbol()
      window.removeEventListener('kcoder:servers-changed', changed)
    }
  }, [invalidate])

  const load = useCallback(async () => {
    if (!ready || !target || loginRequired) return
    const current = Symbol()
    generation.current = current
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const result = await readHookConfiguration(target)
      if (current !== generation.current) return
      setSnapshot(result)
      setSnapshotScope(hookTargetScope(target))
      setDraft(jsonText(result.hooks))
      setConfirmation(null)
    } catch (error) {
      if (current === generation.current)
        setError(failureKind(error) === 'hook_config_unsupported' ? 'unsupported' : 'readFailed')
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [ready, target, loginRequired])
  useEffect(() => {
    selectedId.current = serverId
    const scheduled = generation.current
    void Promise.resolve().then(() => {
      if (scheduled === generation.current) void load()
    })
  }, [serverId, targetScope, scopeVersion, load])

  const save = async (clear = false) => {
    if (
      !target ||
      !snapshot ||
      snapshotScope !== targetScope ||
      !ready ||
      loginRequired ||
      mutation.current ||
      loading
    )
      return
    let hooks: unknown = {}
    if (!clear) {
      if (new TextEncoder().encode(draft).byteLength > 256 * 1024) {
        setError('invalid')
        return
      }
      try {
        hooks = JSON.parse(draft)
      } catch {
        setError('invalid')
        return
      }
      if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
        setError('invalid')
        return
      }
    }
    const current = generation.current
    mutation.current = true
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await updateHookConfiguration(target, hooks, snapshot.revision)
      if (current !== generation.current) return
      setSnapshot(result)
      setSnapshotScope(hookTargetScope(target))
      setDraft(jsonText(result.hooks))
      setConfirmation(null)
      setNotice('saved')
    } catch (error) {
      if (current !== generation.current) return
      const kind = failureKind(error)
      setError(
        kind === 'hook_config_conflict'
          ? 'conflict'
          : kind === 'hook_config_invalid'
            ? 'invalid'
            : kind === 'hook_config_scope_changed'
              ? 'scopeChanged'
              : 'saveUnknown'
      )
    } finally {
      if (current === generation.current) {
        mutation.current = false
        setSaving(false)
      }
    }
  }
  return (
    <SettingsPage data-testid="hooks-settings-page">
      <SettingsPageHeader
        title={t('hookConfiguration.title')}
        description={t('hookConfiguration.description')}
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 text-sm">
          {t('hookConfiguration.target')}
          <IconSelect
            icon={<Server className="h-4 w-4" />}
            data-testid="hooks-target"
            value={serverId}
            disabled={!ready || saving}
            onChange={event => {
              invalidate()
              selectedId.current = event.target.value
              setServerId(event.target.value)
            }}
          >
            {targets.map(item => (
              <option key={item.id} value={item.id}>
                {gatewayServerLabel(item, t)}
              </option>
            ))}
          </IconSelect>
        </label>
        <Button
          variant="secondary"
          data-testid="hooks-refresh"
          disabled={!target || saving || loading}
          onClick={() => (dirty ? setConfirmation('reload') : void load())}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {t('hookConfiguration.refresh')}
        </Button>
      </div>
      <p data-testid="hooks-identity" className="mb-3 break-words text-sm text-text-secondary">
        {target?.accountIdentity
          ? t('hookConfiguration.account', { name: target.accountIdentity.username })
          : t('hookConfiguration.shared')}
      </p>
      <p className="mb-4 text-sm text-text-secondary">{t('hookConfiguration.scopeHelp')}</p>
      {loginRequired && (
        <p role="alert" className="text-sm text-warning">
          {t('hookConfiguration.loginRequired')}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm text-text-secondary">
          {t('hookConfiguration.loading')}
        </p>
      )}
      {error && (
        <p
          id="hook-configuration-error"
          role="alert"
          className="mb-3 break-words rounded-xl bg-destructive/10 p-3 text-sm text-destructive"
        >
          {t(`hookConfiguration.${error}`)}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-3 text-sm text-success">
          {t(`hookConfiguration.${notice}`)}
        </p>
      )}
      {snapshot && snapshotScope === targetScope && ready && !loginRequired && (
        <section className="rounded-2xl border border-border bg-surface/50 p-5">
          <div className="mb-3 flex items-start gap-2 text-sm">
            <FileCode2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <code data-testid="hooks-config-path" className="min-w-0 break-all text-code-sm">
              {snapshot.configurationPath}
            </code>
          </div>
          <label className="block text-sm">
            {t('hookConfiguration.editor')}
            <textarea
              data-testid="hooks-json"
              value={draft}
              onChange={event => {
                setDraft(event.target.value)
                setError('')
                setNotice('')
              }}
              disabled={saving || loading}
              aria-invalid={error === 'invalid'}
              aria-describedby="hook-configuration-help"
              spellCheck={false}
              rows={14}
              className="mt-2 w-full resize-y rounded-xl border border-border bg-background p-3 font-mono text-code outline-none focus:border-focus focus:ring-2 focus:ring-focus/20 disabled:opacity-60"
            />
          </label>
          <p id="hook-configuration-help" className="mt-2 text-sm text-text-secondary">
            {t('hookConfiguration.editorHelp')}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              data-testid="hooks-save"
              disabled={saving || loading || !dirty}
              onClick={() => void save()}
            >
              {t(saving ? 'hookConfiguration.saving' : 'hookConfiguration.save')}
            </Button>
            <Button
              variant="secondary"
              data-testid="hooks-example"
              disabled={saving || loading || dirty}
              onClick={() => {
                const existing = snapshot.hooks as Record<string, unknown>
                setDraft(
                  jsonText({
                    ...existing,
                    UserPromptSubmit: [
                      ...(Array.isArray(existing.UserPromptSubmit)
                        ? existing.UserPromptSubmit
                        : []),
                      { hooks: [{ type: 'command', command: 'echo hook', timeout: 10 }] },
                    ],
                  })
                )
              }}
            >
              {t('hookConfiguration.example')}
            </Button>
            <Button
              variant="ghost"
              data-testid="hooks-clear"
              disabled={saving || loading || jsonText(snapshot.hooks) === '{}'}
              onClick={() => setConfirmation('delete')}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {t('hookConfiguration.clear')}
            </Button>
          </div>
        </section>
      )}
      {confirmation && (
        <RuntimeTargetConfirmDialog
          testId="hooks-confirm"
          title={t(
            confirmation === 'delete' ? 'hookConfiguration.clear' : 'hookConfiguration.refresh'
          )}
          description={t(
            confirmation === 'delete'
              ? 'hookConfiguration.deleteHelp'
              : 'hookConfiguration.reloadHelp'
          )}
          confirmLabel={t(
            confirmation === 'delete' ? 'common.delete' : 'hookConfiguration.refresh'
          )}
          cancelLabel={t('common.cancel')}
          closeLabel={t('common.close')}
          destructive={confirmation === 'delete'}
          pending={saving || loading}
          error={error ? t(`hookConfiguration.${error}`) : undefined}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => (confirmation === 'delete' ? void save(true) : void load())}
        />
      )}
    </SettingsPage>
  )
}
