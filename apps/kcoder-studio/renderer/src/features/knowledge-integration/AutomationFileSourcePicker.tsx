import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import {
  KnowledgeOperationError,
  type KnowledgeIntegrationClient,
  type SelectedAutomationFiles,
} from './client'
import type { AutomationFileEntry, NativeAutomationFileInputs } from './automationFileInputs'
import { OperationError, PageActions } from './shared'
import { createRandomUuid } from '@/lib/random-id'

export function AutomationFileSourcePicker({
  client,
  provider,
  active,
  disabled,
  onSelection,
}: {
  client: KnowledgeIntegrationClient
  provider?: NativeAutomationFileInputs
  active: boolean
  disabled: boolean
  onSelection: (selection?: SelectedAutomationFiles) => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const identity = useMemo(
    () => ({ client, provider, active, key: createRandomUuid() }),
    [client, provider, active]
  )
  const namespace = identity.key
  const [navigation, setNavigation] = useState<{ namespace: string; directory: string }>()
  const directory = navigation?.namespace === namespace ? navigation.directory : '.'
  const [chosen, setChosen] = useState<{ namespace: string; names: string[] }>()
  const names = chosen?.namespace === namespace ? chosen.names : []
  const [revision, setRevision] = useState(0)
  const key = JSON.stringify([namespace, directory, revision])
  const lifetime = useRef<{ key: string; cancel: AbortController } | undefined>(undefined)
  const [metadata, setMetadata] = useState<{
    key: string
    entries: AutomationFileEntry[]
    error?: KnowledgeOperationError
  }>()
  const owned = metadata?.key === key ? metadata : undefined
  const entries = owned?.entries ?? []
  const loading = active && provider?.ownerKey === client.ownerKey && !owned
  const [pageState, setPageState] = useState<{ key: string; value: number }>()
  const page = pageState?.key === key ? pageState.value : 0
  const setPage = (update: (value: number) => number) => setPageState({ key, value: update(page) })
  const [pendingKey, setPendingKey] = useState<string>()
  const pending = pendingKey === key
  const [selectionState, setSelectionState] = useState<{
    key: string
    value: SelectedAutomationFiles
  }>()
  const selected = selectionState?.key === key ? selectionState.value : undefined
  const setSelected = (value?: SelectedAutomationFiles) =>
    setSelectionState(value ? { key, value } : undefined)
  const [actionError, setActionError] = useState<{ key: string; error: KnowledgeOperationError }>()
  const originalOperation = client.pendingFileSelection()
  const error =
    actionError?.key === key
      ? actionError.error
      : !pending && originalOperation
        ? new KnowledgeOperationError(
            'AUTOMATION_FILE_SELECTION_UNCONFIRMED',
            originalOperation.operationId,
            true
          )
        : owned?.error
  const notify = useRef(onSelection)
  useEffect(() => {
    notify.current = onSelection
  }, [onSelection])
  useEffect(() => {
    const cancel = new AbortController()
    lifetime.current = { key, cancel }
    const releaseSelection = notify.current
    if (active && provider?.ownerKey === client.ownerKey) {
      void provider
        .listDirectory({ relativeDirectory: directory, signal: cancel.signal })
        .then(entries => {
          if (!cancel.signal.aborted) setMetadata({ key, entries })
        })
        .catch((reason: unknown) => {
          if (!cancel.signal.aborted)
            setMetadata({
              key,
              entries: [],
              error:
                reason instanceof KnowledgeOperationError
                  ? reason
                  : new KnowledgeOperationError('AUTOMATION_FILE_DIRECTORY_UNAVAILABLE'),
            })
        })
    }
    return () => {
      cancel.abort()
      releaseSelection(undefined)
    }
  }, [active, client, provider, directory, key])
  const setNames = (update: (value: string[]) => string[]) =>
    setChosen(previous => ({
      namespace,
      names: update(previous?.namespace === namespace ? previous.names : []),
    }))
  const changeDirectory = (directory: string) => {
    setChosen(undefined)
    setNavigation({ namespace, directory })
  }
  const run = async (inspect: boolean) => {
    const ownedLifetime = lifetime.current
    if (!ownedLifetime || ownedLifetime.key !== key) return
    const cancel = ownedLifetime.cancel
    if (
      pending ||
      disabled ||
      !active ||
      !provider ||
      provider.ownerKey !== client.ownerKey ||
      cancel.signal.aborted
    )
      return
    setPendingKey(key)
    try {
      let selection: SelectedAutomationFiles | undefined
      if (inspect) {
        if (!error?.operationId) return
        const result = await client.reconcileFileEventSelection(error.operationId, cancel.signal)
        if (!['completed', 'rejected', 'cancelled'].includes(result.phase)) return
        selection = result.selection
      } else {
        if (error?.uncertain || names.length === 0 || names.length > 32) return
        const receipt = await client.selectFileEventSource(
          { relativeDirectory: directory, fileNames: names },
          cancel.signal
        )
        selection = {
          sourceRef: receipt.sourceRef,
          selectionRevision: receipt.selectionRevision,
          fileNames: receipt.items.map(item => item.name),
        }
      }
      if (cancel.signal.aborted) return
      setSelected(selection)
      notify.current(selection)
      setActionError(undefined)
    } catch (reason) {
      if (cancel.signal.aborted) return
      setSelected(undefined)
      notify.current(undefined)
      setActionError({
        key,
        error:
          reason instanceof KnowledgeOperationError
            ? reason
            : new KnowledgeOperationError('KNOWLEDGE_OPERATION_UNAVAILABLE'),
      })
    } finally {
      if (!cancel.signal.aborted) setPendingKey(undefined)
    }
  }
  const blocked = disabled || pending || !!error?.uncertain
  return (
    <div
      className="studio-card-spacing workbench-card space-y-3"
      data-testid="automation-file-picker"
      aria-busy={loading || pending}
    >
      <h4 className="font-medium">{t('fileEventFiles')}</h4>
      {!provider || provider.ownerKey !== client.ownerKey ? (
        <p role="status" className="text-sm text-text-secondary">
          {t('fileWorkspaceRequired')}
        </p>
      ) : (
        <>
          <p className="break-all text-sm text-text-secondary">
            {provider.workspaceLabel}
            {directory === '.' ? '' : ` / ${directory}`}
          </p>
          <p className="text-sm text-text-muted">{t('fileEventHint')}</p>
          <Button
            type="button"
            variant="ghost"
            disabled={blocked || directory === '.'}
            data-testid="automation-file-parent"
            onClick={() =>
              changeDirectory(
                directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '.'
              )
            }
          >
            {t('fileParent')}
          </Button>
          <div className="space-y-1">
            {loading ? (
              <p role="status" className="text-sm text-text-muted">
                {t('loading')}
              </p>
            ) : (
              entries.slice(page * 10, page * 10 + 10).map(entry =>
                entry.isDirectory ? (
                  <Button
                    key={entry.name}
                    type="button"
                    variant="ghost"
                    className="min-h-11 w-full justify-start"
                    disabled={blocked}
                    data-testid="automation-file-directory"
                    onClick={() =>
                      changeDirectory(directory === '.' ? entry.name : `${directory}/${entry.name}`)
                    }
                  >
                    {entry.name} /
                  </Button>
                ) : (
                  <label
                    key={entry.name}
                    className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm hover:bg-muted"
                    data-testid="automation-file-row"
                  >
                    <Checkbox
                      checked={names.includes(entry.name)}
                      aria-label={entry.name}
                      data-testid="automation-file-checkbox"
                      disabled={
                        blocked ||
                        entry.size > 1024 * 1024 ||
                        (names.length >= 32 && !names.includes(entry.name))
                      }
                      onChange={event => {
                        setNames(value =>
                          event.target.checked
                            ? [...value, entry.name]
                            : value.filter(name => name !== entry.name)
                        )
                        setSelected(undefined)
                        notify.current(undefined)
                      }}
                    />
                    <span className="min-w-0 break-all">{entry.name}</span>
                    {entry.size > 1024 * 1024 && (
                      <span className="text-text-muted">{t('fileTooLarge')}</span>
                    )}
                  </label>
                )
              )
            )}
            {!loading && entries.length === 0 && !error && (
              <p className="text-sm text-text-muted">{t('empty')}</p>
            )}
          </div>
          <PageActions
            page={page + 1}
            pending={loading || blocked}
            hasPrevious={page > 0}
            hasNext={(page + 1) * 10 < entries.length}
            previous={() => setPage(value => value - 1)}
            next={() => setPage(value => value + 1)}
            refresh={() => setRevision(value => value + 1)}
          />
          <p className="text-sm text-text-secondary">
            {t('fileSelectedCount', { count: names.length })}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={
              blocked ||
              loading ||
              names.length === 0 ||
              names.some(name => !entries.some(entry => !entry.isDirectory && entry.name === name))
            }
            data-testid="automation-file-confirm"
            onClick={() => void run(false)}
          >
            {t('fileConfirmSelection')}
          </Button>
          {selected && (
            <p
              role="status"
              data-testid="automation-file-ready"
              className="text-sm text-text-secondary"
            >
              {t('fileSelectionReady', { count: selected.fileNames.length })}
            </p>
          )}
        </>
      )}
      {error?.code === 'AUTOMATION_FILE_READ_AUTHORIZATION_REQUIRED' ? (
        <p
          role="alert"
          className="text-sm text-destructive"
          data-testid="automation-file-authorization-required"
        >
          {t('fileReadAuthorizationRequired')}
        </p>
      ) : (
        <OperationError
          error={error}
          onInspect={error?.uncertain && !pending && active ? () => void run(true) : undefined}
        />
      )}
    </div>
  )
}
