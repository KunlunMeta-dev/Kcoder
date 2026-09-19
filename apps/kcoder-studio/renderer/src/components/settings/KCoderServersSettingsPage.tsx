import { CheckCircle2, Laptop, Loader2, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  fetchGatewayServersWithHealth,
  GatewayRpcError,
  removeGatewayServer,
  saveGatewayServer,
  testGatewayServer,
  type GatewayServer,
} from '@/kcoder/gatewayRpc'
import { RuntimeTargetConfirmDialog } from './RuntimeTargetConfirmDialog'
import { RuntimeTargetEditor } from './RuntimeTargetEditor'
import { KCoderAccountLogin } from './KCoderAccountLogin'
import { KCoderAccountManagement } from './KCoderAccountManagement'
import {
  RUNTIME_TARGET_FIELD_ORDER,
  createRuntimeTargetSession,
  editRuntimeTargetSession,
  runtimeTargetConfigFromDraft,
  runtimeTargetSessionIsDirty,
  updateRuntimeTargetSession,
  validateRuntimeTarget,
  type RuntimeTargetDraft,
  type RuntimeTargetEditorSession,
  type RuntimeTargetErrors,
  type RuntimeTargetField,
} from './runtime-target-model'
import { SettingsPage, SettingsPageHeader, StatusChip } from './settings-ui'

interface PendingNavigation {
  next: RuntimeTargetEditorSession | null
  trigger: HTMLElement
}

interface DeleteCandidate {
  server: GatewayServer
  trigger: HTMLButtonElement
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fieldTestId(field: RuntimeTargetField): string {
  const testIds: Partial<Record<RuntimeTargetField, string>> = {
    label: 'runtime-target-label',
    id: 'runtime-target-id',
    host: 'runtime-target-host',
    port: 'runtime-target-port',
    workspacePath: 'runtime-target-workspace',
    command: 'runtime-target-command',
    accountMode: 'runtime-target-account-mode',
    settingsFile: 'runtime-target-settings-file',
  }
  return testIds[field] ?? `runtime-target-${field}`
}

function needsAdvanced(field: RuntimeTargetField): boolean {
  return ['user', 'port', 'command', 'profile', 'settingsFile', 'chromiumBin'].includes(field)
}

export function KCoderServersSettingsPage() {
  const { t } = useTranslation('localRuntime')
  const [servers, setServers] = useState<GatewayServer[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [editor, setEditor] = useState<RuntimeTargetEditorSession | null>(null)
  const [editorEpoch, setEditorEpoch] = useState(0)
  const [editorErrors, setEditorErrors] = useState<RuntimeTargetErrors>({})
  const [editorBusy, setEditorBusy] = useState<'test' | 'save' | null>(null)
  const [editorResult, setEditorResult] = useState<{
    kind: 'success' | 'error'
    message: string
    detail?: string
  } | null>(null)
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null)
  const [noSandboxTrigger, setNoSandboxTrigger] = useState<HTMLElement | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<DeleteCandidate | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const editorOpenerRef = useRef<HTMLElement | null>(null)
  const loadRevisionRef = useRef(0)

  const localizedErrorDetail = useCallback(
    (error: unknown) => {
      if (!(error instanceof GatewayRpcError)) return messageOf(error)
      if (error.reason === 'unauthorized') return t('targets.errors.unauthorized')
      if (error.reason === 'http') {
        return t('targets.errors.http', { status: error.code > 0 ? error.code : '?' })
      }
      if (error.reason === 'invalid-response') return t('targets.errors.invalidResponse')
      if (error.reason === 'connection') return t('targets.errors.connection')
      return error.message
    },
    [t]
  )

  const load = useCallback(async () => {
    const revision = ++loadRevisionRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const loaded = await fetchGatewayServersWithHealth()
      if (loadRevisionRef.current !== revision) return
      setServers(loaded)
    } catch (error) {
      if (loadRevisionRef.current !== revision) return
      setLoadError(localizedErrorDetail(error))
    } finally {
      if (loadRevisionRef.current === revision) setLoading(false)
    }
  }, [localizedErrorDetail])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const healthUnavailable = useMemo(
    () => servers.find(server => server.status === 'unavailable')?.healthError ?? null,
    [servers]
  )

  const applyEditor = useCallback(
    (next: RuntimeTargetEditorSession | null, trigger?: HTMLElement) => {
      if (next) editorOpenerRef.current = trigger ?? editorOpenerRef.current
      setEditor(next)
      setEditorEpoch(value => value + 1)
      setEditorErrors({})
      setEditorResult(null)
      setSuccess(null)
      if (!next) {
        const focusTarget = editorOpenerRef.current ?? addButtonRef.current
        window.setTimeout(() => focusTarget?.focus(), 0)
      }
    },
    []
  )

  const requestEditorNavigation = useCallback(
    (next: RuntimeTargetEditorSession | null, trigger: HTMLElement) => {
      if (editorBusy) return
      if (editor && runtimeTargetSessionIsDirty(editor)) {
        setPendingNavigation({ next, trigger })
        return
      }
      applyEditor(next, trigger)
    },
    [applyEditor, editor, editorBusy]
  )

  const focusFirstError = useCallback((errors: RuntimeTargetErrors) => {
    const first = RUNTIME_TARGET_FIELD_ORDER.find(field => errors[field])
    if (!first) return
    if (needsAdvanced(first)) {
      setEditor(current => (current ? { ...current, advancedOpen: true } : current))
    }
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-testid="${fieldTestId(first)}"]`)?.focus()
    }, 0)
  }, [])

  const validateEditor = useCallback(() => {
    if (!editor) return null
    const errors = validateRuntimeTarget(editor, servers)
    setEditorErrors(errors)
    if (Object.keys(errors).length > 0) {
      focusFirstError(errors)
      return null
    }
    return runtimeTargetConfigFromDraft(editor)
  }, [editor, focusFirstError, servers])

  const updateEditor = useCallback(
    <K extends RuntimeTargetField>(field: K, value: RuntimeTargetDraft[K]) => {
      setEditor(current => (current ? updateRuntimeTargetSession(current, field, value) : current))
      setEditorErrors(current => ({ ...current, [field]: undefined }))
      setEditorResult(null)
      setSuccess(null)
    },
    []
  )

  const validateField = useCallback(
    (field: RuntimeTargetField) => {
      if (!editor) return
      const errors = validateRuntimeTarget(editor, servers)
      setEditorErrors(current => ({ ...current, [field]: errors[field] }))
    },
    [editor, servers]
  )

  const testConnection = useCallback(async () => {
    if (editorBusy || !editor) return
    const config = validateEditor()
    if (!config) return
    const requestIdentity = `${editor.mode}:${editor.originalId ?? editor.draft.id}`
    const requestRevision = editor.revision
    setEditorBusy('test')
    setEditorResult(null)
    try {
      const result = await testGatewayServer(config)
      setEditor(current => {
        if (!current) return current
        const currentIdentity = `${current.mode}:${current.originalId ?? current.draft.id}`
        if (currentIdentity === requestIdentity && current.revision === requestRevision) {
          const detail = [result.serverInfo?.version, result.protocolVersion]
            .filter(Boolean)
            .join(' · ')
          setEditorResult({
            kind: 'success',
            message: t('targets.testSucceeded'),
            detail: detail || undefined,
          })
        }
        return current
      })
    } catch (error) {
      setEditor(current => {
        if (!current) return current
        const currentIdentity = `${current.mode}:${current.originalId ?? current.draft.id}`
        if (currentIdentity === requestIdentity && current.revision === requestRevision) {
          setEditorResult({
            kind: 'error',
            message: t('targets.testFailed'),
            detail: `${t('targets.testFailedHelp')} ${localizedErrorDetail(error)}`,
          })
        }
        return current
      })
    } finally {
      setEditorBusy(current => (current === 'test' ? null : current))
    }
  }, [editor, editorBusy, localizedErrorDetail, t, validateEditor])

  const save = useCallback(async () => {
    if (editorBusy || !editor) return
    const config = validateEditor()
    if (!config) return
    const requestIdentity = `${editor.mode}:${editor.originalId ?? editor.draft.id}`
    const requestRevision = editor.revision
    const originalId = editor.originalId
    setEditorBusy('save')
    setEditorResult(null)
    try {
      const saved = await saveGatewayServer(config)
      const view: GatewayServer = { ...saved, status: saved.status ?? 'unknown' }
      setServers(current => [...current.filter(item => item.id !== (originalId ?? saved.id)), view])
      window.dispatchEvent(new CustomEvent('kcoder:servers-changed'))
      setEditor(current => {
        if (!current) return current
        const currentIdentity = `${current.mode}:${current.originalId ?? current.draft.id}`
        if (currentIdentity === requestIdentity && current.revision === requestRevision) {
          window.setTimeout(() => (editorOpenerRef.current ?? addButtonRef.current)?.focus(), 0)
          setSuccess(t('targets.savedHelp'))
          return null
        }
        return current
      })
    } catch (error) {
      setEditor(current => {
        if (!current) return current
        const currentIdentity = `${current.mode}:${current.originalId ?? current.draft.id}`
        if (currentIdentity === requestIdentity && current.revision === requestRevision) {
          const reason = `${t('targets.saveFailedHelp')} ${localizedErrorDetail(error)}`
          setEditorResult({ kind: 'error', message: t('targets.saveFailed'), detail: reason })
        }
        return current
      })
    } finally {
      setEditorBusy(current => (current === 'save' ? null : current))
    }
  }, [editor, editorBusy, localizedErrorDetail, t, validateEditor])

  const confirmDelete = useCallback(async () => {
    if (!deleteCandidate || deletingId) return
    const { server, trigger } = deleteCandidate
    setDeletingId(server.id)
    setRowErrors(current => {
      const next = { ...current }
      delete next[server.id]
      return next
    })
    try {
      await removeGatewayServer(server.id)
      setServers(current => current.filter(item => item.id !== server.id))
      setDeleteCandidate(null)
      window.dispatchEvent(new CustomEvent('kcoder:servers-changed'))
      window.setTimeout(() => addButtonRef.current?.focus(), 0)
    } catch (error) {
      setDeleteCandidate(null)
      setRowErrors(current => ({ ...current, [server.id]: localizedErrorDetail(error) }))
      window.setTimeout(() => trigger.focus(), 0)
    } finally {
      setDeletingId(null)
    }
  }, [deleteCandidate, deletingId, localizedErrorDetail])

  return (
    <SettingsPage>
      <SettingsPageHeader
        title={t('targets.title')}
        description={t('targets.description')}
        actions={
          <Button
            ref={addButtonRef}
            type="button"
            variant="secondary"
            size="sm"
            data-testid="runtime-target-add"
            disabled={editorBusy !== null}
            onClick={event =>
              requestEditorNavigation(createRuntimeTargetSession(), event.currentTarget)
            }
            className="focus-visible:ring-blue-500 max-md:h-11"
          >
            <Plus className="h-4 w-4" />
            {t('targets.add')}
          </Button>
        }
      />

      {success && (
        <div
          role="status"
          className="mb-4 rounded-lg bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:text-green-400"
        >
          <span className="font-medium">{t('targets.saved')}</span>
          <span className="ml-2">{success}</span>
        </div>
      )}

      {loadError && (
        <div role="alert" className="mb-4 rounded-lg bg-red-500/10 px-3 py-3 text-sm text-red-500">
          <p className="font-medium">{t('targets.loadFailed')}</p>
          <p className="mt-1 text-xs">{t('targets.loadFailedHelp')}</p>
          <p className="mt-1 break-words text-xs opacity-80">{loadError}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="runtime-target-load-retry"
            onClick={() => void load()}
            className="mt-2 focus-visible:ring-blue-500 max-md:h-11"
          >
            {t('targets.retry')}
          </Button>
        </div>
      )}

      {editor && (
        <RuntimeTargetEditor
          key={editorEpoch}
          session={editor}
          errors={editorErrors}
          busy={editorBusy}
          result={editorResult}
          t={t}
          onUpdate={updateEditor}
          onBlur={validateField}
          onToggleAdvanced={() =>
            setEditor(current =>
              current ? { ...current, advancedOpen: !current.advancedOpen } : current
            )
          }
          onClose={trigger => requestEditorNavigation(null, trigger)}
          onTest={() => void testConnection()}
          onSubmit={() => void save()}
          onRequestNoSandbox={trigger => setNoSandboxTrigger(trigger)}
        />
      )}

      {healthUnavailable && !loadError && (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400"
        >
          <span className="font-medium">{t('targets.healthUnavailable')}</span>
          <span className="text-xs">{t('targets.healthUnavailableHelp')}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="runtime-target-health-retry"
            onClick={() => void load()}
            className="ml-auto focus-visible:ring-blue-500 max-md:h-11"
          >
            {t('targets.retry')}
          </Button>
        </div>
      )}

      {loading && servers.length === 0 && !loadError ? (
        <div role="status" className="flex items-center gap-2 py-4 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('targets.loading')}
        </div>
      ) : servers.length === 0 && !loadError ? (
        <div className="rounded-xl bg-surface/50 px-4 py-8 text-center ring-1 ring-border">
          <Server className="mx-auto h-6 w-6 text-text-muted" aria-hidden="true" />
          <h2 className="mt-3 text-base font-medium text-text-primary">
            {t('targets.emptyTitle')}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">{t('targets.emptyDescription')}</p>
        </div>
      ) : (
        <div
          data-testid="runtime-target-list"
          className="overflow-hidden rounded-xl bg-surface/40 ring-1 ring-border"
        >
          {servers.map((server, index) => {
            const status = server.status ?? 'unknown'
            const statusLabel = t(`targets.status.${status}`)
            const location =
              server.transport === 'local'
                ? server.workspacePath || server.description
                : `${server.user ? `${server.user}@` : ''}${server.host ?? ''}${server.port ? `:${server.port}` : ''}`
            return (
              <article
                key={server.id}
                data-testid={`runtime-target-row-${server.id}`}
                className={`flex min-h-16 items-center gap-3 px-3 py-3 max-md:items-start ${index > 0 ? 'border-t border-border' : ''}`}
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-text-secondary max-md:h-11 max-md:w-11">
                  {server.transport === 'local' ? (
                    <Laptop className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Server className="h-4 w-4" aria-hidden="true" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h2
                      className="min-w-0 truncate text-sm font-medium text-text-primary"
                      title={server.label}
                    >
                      {server.label}
                    </h2>
                    <span className="text-code-sm text-text-muted">
                      {server.id} · {t(`targets.transport.${server.transport}Short`)}
                    </span>
                  </div>
                  <p className="mt-1 break-all text-xs text-text-secondary" title={location}>
                    {location}
                    {server.workspacePath && server.transport === 'ssh'
                      ? ` · ${server.workspacePath}`
                      : ''}
                  </p>
                  {server.error && status === 'offline' && (
                    <p className="mt-1 break-words text-xs text-red-500">{server.error}</p>
                  )}
                  {server.security && <KCoderAccountLogin server={server} onChanged={load} />}
                  {server.accountIdentity?.role === 'admin' && (
                    <KCoderAccountManagement serverId={server.id} />
                  )}
                  {rowErrors[server.id] && (
                    <div
                      role="alert"
                      className="mt-2 rounded-md bg-red-500/10 px-2 py-1.5 text-xs text-red-500"
                    >
                      <p className="font-medium">{t('targets.deleteFailed')}</p>
                      <p>{t('targets.deleteFailedHelp')}</p>
                      <p className="mt-1 break-words opacity-80">{rowErrors[server.id]}</p>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1 max-md:flex-wrap max-md:justify-end">
                  <StatusChip
                    className="mr-1"
                    variant={
                      status === 'online'
                        ? 'success'
                        : status === 'offline'
                          ? 'destructive'
                          : 'neutral'
                    }
                  >
                    {statusLabel}
                    {typeof server.latencyMs === 'number' &&
                    (status === 'online' || status === 'offline')
                      ? ` · ${server.latencyMs} ms`
                      : ''}
                  </StatusChip>
                  {server.id === 'local' ? (
                    <StatusChip variant="neutral">{t('targets.builtIn')}</StatusChip>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        data-testid={`runtime-target-edit-${server.id}`}
                        aria-label={t('targets.editAction', { name: server.label })}
                        title={t('targets.editAction', { name: server.label })}
                        disabled={editorBusy !== null || deletingId === server.id}
                        onClick={event =>
                          requestEditorNavigation(
                            editRuntimeTargetSession(server),
                            event.currentTarget
                          )
                        }
                        className="h-8 w-8 text-text-secondary focus-visible:ring-blue-500 max-md:h-11 max-md:w-11"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        data-testid={`runtime-target-delete-${server.id}`}
                        aria-label={
                          deletingId === server.id
                            ? t('targets.deleting', { name: server.label })
                            : t('targets.deleteAction', { name: server.label })
                        }
                        title={t('targets.deleteAction', { name: server.label })}
                        disabled={deletingId === server.id}
                        onClick={event =>
                          setDeleteCandidate({ server, trigger: event.currentTarget })
                        }
                        className="h-8 w-8 text-red-500 hover:bg-red-500/10 hover:text-red-500 focus-visible:ring-blue-500 max-md:h-11 max-md:w-11"
                      >
                        {deletingId === server.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {servers.length > 0 && (
        <p className="mt-4 flex items-center gap-2 text-xs text-text-muted">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('targets.storageNote')}
        </p>
      )}

      {pendingNavigation && (
        <RuntimeTargetConfirmDialog
          title={t('targets.discardTitle')}
          description={t('targets.discardDescription')}
          cancelLabel={t('targets.keepEditing')}
          closeLabel={t('targets.closeDialog')}
          confirmLabel={t('targets.discard')}
          testId="runtime-target-discard-dialog"
          onCancel={() => {
            const trigger = pendingNavigation.trigger
            setPendingNavigation(null)
            window.setTimeout(() => trigger.focus(), 0)
          }}
          onConfirm={() => {
            const pending = pendingNavigation
            setPendingNavigation(null)
            applyEditor(pending.next, pending.trigger)
          }}
        />
      )}

      {noSandboxTrigger && (
        <RuntimeTargetConfirmDialog
          title={t('targets.noSandboxConfirmTitle')}
          description={t('targets.noSandboxConfirmDescription')}
          cancelLabel={t('targets.cancel')}
          closeLabel={t('targets.closeDialog')}
          confirmLabel={t('targets.noSandboxConfirm')}
          testId="runtime-target-no-sandbox-dialog"
          onCancel={() => {
            const trigger = noSandboxTrigger
            setNoSandboxTrigger(null)
            window.setTimeout(() => trigger.focus(), 0)
          }}
          onConfirm={() => {
            const trigger = noSandboxTrigger
            setNoSandboxTrigger(null)
            updateEditor('chromiumNoSandbox', true)
            window.setTimeout(() => trigger.focus(), 0)
          }}
        />
      )}

      {deleteCandidate && (
        <RuntimeTargetConfirmDialog
          title={t('targets.deleteTitle', { name: deleteCandidate.server.label })}
          description={t('targets.deleteDescription')}
          cancelLabel={t('targets.cancel')}
          closeLabel={t('targets.closeDialog')}
          confirmLabel={t('targets.delete')}
          testId="runtime-target-delete-dialog"
          pending={deletingId === deleteCandidate.server.id}
          destructive
          onCancel={() => {
            const trigger = deleteCandidate.trigger
            setDeleteCandidate(null)
            window.setTimeout(() => trigger.focus(), 0)
          }}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </SettingsPage>
  )
}
