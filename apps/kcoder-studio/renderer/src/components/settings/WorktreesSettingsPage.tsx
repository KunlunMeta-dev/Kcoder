import { CircleCheck, Loader2, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  DeviceInfo,
  RuntimeManagedWorktree,
  RuntimeTaskAddress,
  RuntimeWorktreeArchivePreview,
  RuntimeWorktreeConversation,
  RuntimeWorktreeSettings,
} from '@/types/api'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'

type RuntimeWorkApi = NonNullable<WorkbenchServices['runtimeWorkApi']>

interface WorktreesSettingsPageProps {
  api?: RuntimeWorkApi
  devices?: Array<Pick<DeviceInfo, 'device_id' | 'name' | 'status'>>
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  onRefreshWorkLists?: () => Promise<void>
  onLeaveSettings?: () => void
}

function groupWorktrees(items: RuntimeManagedWorktree[]) {
  const groups = new Map<
    string,
    { name: string; sourcePath?: string | null; items: RuntimeManagedWorktree[] }
  >()
  items.forEach(item => {
    const key = item.sourcePath || item.repositoryName
    const existing = groups.get(key)
    if (existing) {
      existing.items.push(item)
    } else {
      groups.set(key, { name: item.repositoryName, sourcePath: item.sourcePath, items: [item] })
    }
  })
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function WorktreeRow({
  item,
  busy,
  openingTaskId,
  onArchive,
  onRestore,
  onForget,
  onOpenConversation,
}: {
  item: RuntimeManagedWorktree
  busy: boolean
  openingTaskId: string | null
  onArchive: () => void
  onRestore: () => void
  onForget: () => void
  onOpenConversation?: (conversation: RuntimeWorktreeConversation) => void
}) {
  const { t } = useTranslation('common')
  return (
    <div data-testid="worktree-row" className="flex flex-col gap-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-text-primary">
              {t('workbench.worktrees_row_title')}
            </div>
          </div>
          <div className="mt-1 truncate text-xs text-text-secondary" title={item.path}>
            {item.path}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />}
          {item.state === 'active' && (
            <button
              type="button"
              data-testid={`archive-worktree-button-${item.worktreeId}`}
              onClick={onArchive}
              disabled={busy}
              className="inline-flex h-8 items-center rounded-md bg-red-500/10 px-3 text-sm font-medium text-red-500 hover:bg-red-500/15 disabled:opacity-50"
            >
              {t('workbench.worktrees_archive')}
            </button>
          )}
          {item.state === 'restorable' && (
            <button
              type="button"
              data-testid={`restore-worktree-button-${item.worktreeId}`}
              onClick={onRestore}
              disabled={busy}
              className="inline-flex h-8 items-center rounded-md bg-primary/10 px-3 text-sm font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
            >
              {t('workbench.worktrees_restore')}
            </button>
          )}
          {item.state !== 'active' && (
            <button
              type="button"
              data-testid={`forget-worktree-button-${item.worktreeId}`}
              onClick={onForget}
              disabled={busy || item.conversations.length > 0}
              className="inline-flex h-8 items-center rounded-md bg-red-500/10 px-3 text-sm font-medium text-red-500 hover:bg-red-500/15 disabled:opacity-50"
            >
              {t('workbench.worktrees_forget')}
            </button>
          )}
        </div>
      </div>
      <div className="text-xs text-text-secondary">
        {t('workbench.worktrees_state')}: {item.state}
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-text-secondary">{t('workbench.worktrees_conversations')}</div>
        {item.conversations.length === 0 ? (
          <div className="text-xs text-text-secondary">
            {t('workbench.worktrees_no_conversations')}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {item.conversations.map(conversation => (
              <button
                type="button"
                key={`${conversation.deviceId}-${conversation.taskId}`}
                data-testid="worktree-linked-task"
                onClick={() => onOpenConversation?.(conversation)}
                disabled={!onOpenConversation || openingTaskId === conversation.taskId}
                className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-sm text-text-primary hover:bg-muted hover:text-text-primary/80 disabled:cursor-default disabled:opacity-60"
              >
                {openingTaskId === conversation.taskId && (
                  <Loader2 className="mr-2 h-3.5 w-3.5 shrink-0 animate-spin" />
                )}
                <span className="truncate">{conversation.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function WorktreesSettingsPage(props: WorktreesSettingsPageProps) {
  const availableDevices = (props.devices ?? []).filter(device => device.status === 'online')
  const [deviceId, setDeviceId] = useState('')
  const selectedDeviceId = availableDevices.some(device => device.device_id === deviceId)
    ? deviceId
    : (availableDevices[0]?.device_id ?? '')
  // A different target owns a different form, including drafts and confirmation dialogs.
  return (
    <WorktreeTargetSettings
      key={selectedDeviceId}
      {...props}
      availableDevices={availableDevices}
      selectedDeviceId={selectedDeviceId}
      onSelectDevice={setDeviceId}
    />
  )
}

function WorktreeTargetSettings({
  api,
  availableDevices,
  selectedDeviceId,
  onSelectDevice,
  onOpenRuntimeTask,
  onRefreshWorkLists,
  onLeaveSettings,
}: WorktreesSettingsPageProps & {
  availableDevices: NonNullable<WorktreesSettingsPageProps['devices']>
  selectedDeviceId: string
  onSelectDevice: (deviceId: string) => void
}) {
  const { t } = useTranslation('common')
  const loadGeneration = useRef(0)
  const [settings, setSettings] = useState<RuntimeWorktreeSettings | null>(null)
  const [rootDraft, setRootDraft] = useState('')
  const [keepCountDraft, setKeepCountDraft] = useState('15')
  const [items, setItems] = useState<RuntimeManagedWorktree[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [openingTaskId, setOpeningTaskId] = useState<string | null>(null)
  const [pendingDisableCleanup, setPendingDisableCleanup] = useState(false)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingArchive, setPendingArchive] = useState<{
    item: RuntimeManagedWorktree
    preview: RuntimeWorktreeArchivePreview
  } | null>(null)
  const [pendingForget, setPendingForget] = useState<RuntimeManagedWorktree | null>(null)
  const [forgetDraft, setForgetDraft] = useState('')

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    if (!api || !selectedDeviceId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [nextSettings, response] = await Promise.all([
        api.getWorktreeSettings({ deviceId: selectedDeviceId }),
        api.listWorktrees({ deviceId: selectedDeviceId }),
      ])
      if (generation !== loadGeneration.current) return
      setSettings(nextSettings)
      setRootDraft(nextSettings.worktreeRoot)
      setKeepCountDraft(String(nextSettings.keepCount))
      setItems(response.items)
    } catch (loadError) {
      if (generation !== loadGeneration.current) return
      setError(
        loadError instanceof Error ? loadError.message : t('workbench.worktrees_load_failed')
      )
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }, [api, selectedDeviceId, t])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => {
      loadGeneration.current += 1
      window.clearTimeout(timer)
    }
  }, [load])

  useEffect(() => {
    if (!savedNotice) return
    const timer = window.setTimeout(() => setSavedNotice(null), 2000)
    return () => window.clearTimeout(timer)
  }, [savedNotice])

  const updateSettings = useCallback(
    async (
      patch: Partial<
        Pick<RuntimeWorktreeSettings, 'worktreeRoot' | 'autoCleanupEnabled' | 'keepCount'>
      >,
      successNotice?: string
    ) => {
      if (!api || !selectedDeviceId || loading || saving) return false
      setSaving(true)
      setError(null)
      try {
        const next = await api.updateWorktreeSettings({ deviceId: selectedDeviceId, ...patch })
        setSettings(next)
        setRootDraft(next.worktreeRoot)
        setKeepCountDraft(String(next.keepCount))
        if (successNotice) setSavedNotice(successNotice)
        return true
      } catch (saveError) {
        setError(
          saveError instanceof Error ? saveError.message : t('workbench.worktrees_save_failed')
        )
        return false
      } finally {
        setSaving(false)
      }
    },
    [api, loading, saving, selectedDeviceId, t]
  )

  const commitKeepCount = useCallback(() => {
    if (!settings) return
    const keepCount = Math.max(1, Number(keepCountDraft) || 1)
    setKeepCountDraft(String(keepCount))
    if (keepCount === settings.keepCount) return
    void updateSettings({ keepCount }, t('workbench.worktrees_saved_limit'))
  }, [keepCountDraft, settings, t, updateSettings])

  const previewArchive = useCallback(
    async (item: RuntimeManagedWorktree) => {
      if (!api) return
      setBusyPath(item.path)
      setError(null)
      try {
        const response = await api.previewWorktreeArchive({
          deviceId: item.deviceId,
          path: item.path,
        })
        if (!response.preview.archiveAllowed) {
          throw new Error(
            response.preview.blockingReasons.join('；') || t('workbench.worktrees_archive_blocked')
          )
        }
        setPendingArchive({ item, preview: response.preview })
      } catch (deleteError) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : t('workbench.worktrees_archive_failed')
        )
      } finally {
        setBusyPath(null)
      }
    },
    [api, t]
  )

  const confirmArchive = useCallback(async () => {
    if (!api || !pendingArchive) return
    const { item, preview } = pendingArchive
    setBusyPath(item.path)
    setError(null)
    try {
      await api.archiveWorktree({
        deviceId: item.deviceId,
        path: item.path,
        expectedRevision: preview.revision,
        expectedContentToken: preview.contentToken,
        riskAccepted: true,
      })
      setPendingArchive(null)
      await load()
    } catch (archiveError) {
      setError(
        archiveError instanceof Error
          ? archiveError.message
          : t('workbench.worktrees_archive_failed')
      )
    } finally {
      setBusyPath(null)
    }
  }, [api, load, pendingArchive, t])

  const restoreWorktree = useCallback(
    async (item: RuntimeManagedWorktree) => {
      if (!api) return
      setBusyPath(item.path)
      setError(null)
      try {
        await api.restoreWorktree({
          deviceId: item.deviceId,
          path: item.path,
          expectedRevision: item.revision,
        })
        await load()
      } catch (restoreError) {
        setError(
          restoreError instanceof Error
            ? restoreError.message
            : t('workbench.worktrees_restore_failed')
        )
      } finally {
        setBusyPath(null)
      }
    },
    [api, load, t]
  )

  const confirmForget = useCallback(async () => {
    if (!api || !pendingForget || forgetDraft !== pendingForget.worktreeId) return
    setBusyPath(pendingForget.path)
    setError(null)
    try {
      await api.forgetWorktree({
        deviceId: pendingForget.deviceId,
        path: pendingForget.path,
        expectedRevision: pendingForget.revision,
        confirmPermanent: true,
      })
      setPendingForget(null)
      setForgetDraft('')
      await load()
    } catch (forgetError) {
      setError(
        forgetError instanceof Error ? forgetError.message : t('workbench.worktrees_forget_failed')
      )
    } finally {
      setBusyPath(null)
    }
  }, [api, forgetDraft, load, pendingForget, t])

  const groups = useMemo(() => groupWorktrees(items), [items])
  const unavailable = !api || availableDevices.length === 0

  const openConversation = useCallback(
    async (conversation: RuntimeWorktreeConversation) => {
      if (!onOpenRuntimeTask) return
      setOpeningTaskId(conversation.taskId)
      setError(null)
      try {
        await onRefreshWorkLists?.()
        await onOpenRuntimeTask(conversation)
        onLeaveSettings?.()
      } catch (openError) {
        setError(
          openError instanceof Error
            ? openError.message
            : t('workbench.worktrees_open_conversation_failed')
        )
      } finally {
        setOpeningTaskId(null)
      }
    },
    [onLeaveSettings, onOpenRuntimeTask, onRefreshWorkLists, t]
  )

  return (
    <SettingsPage data-testid="worktrees-settings-page">
      <SettingsPageHeader title={t('workbench.worktrees_title')} />

      {availableDevices.length > 1 && (
        <label className="block text-sm text-text-secondary">
          <span className="mb-2 block">{t('workbench.worktrees_device')}</span>
          <select
            data-testid="worktrees-device-select"
            value={selectedDeviceId}
            onChange={event => onSelectDevice(event.target.value)}
            disabled={saving || busyPath !== null || openingTaskId !== null}
            className="h-9 w-full max-w-[360px] rounded-md border border-border bg-background px-3 text-sm text-text-primary"
          >
            {availableDevices.map(device => (
              <option key={device.device_id} value={device.device_id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {unavailable ? (
        <div className="mt-8 rounded-lg border border-border bg-surface px-4 py-4 text-sm text-text-secondary">
          {t('workbench.worktrees_device_unavailable')}
        </div>
      ) : (
        settings && (
          <SettingsGroup className={availableDevices.length > 1 ? 'mt-6' : ''}>
            <SettingsRow
              label={t('workbench.worktrees_root')}
              description={t('workbench.worktrees_root_description')}
              control={
                <input
                  data-testid="worktrees-root-input"
                  value={rootDraft}
                  onChange={event => setRootDraft(event.target.value)}
                  onBlur={() => {
                    if (rootDraft !== settings.worktreeRoot)
                      void updateSettings(
                        { worktreeRoot: rootDraft },
                        t('workbench.worktrees_saved_root')
                      )
                  }}
                  placeholder={t('workbench.worktrees_default')}
                  disabled={loading || saving}
                  className="w-56 rounded-md border border-border bg-background px-2.5 py-1.5 text-base text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-primary disabled:opacity-50 max-sm:w-full"
                />
              }
            />
            <SettingsRow
              label={t('workbench.worktrees_auto_cleanup')}
              description={t('workbench.worktrees_auto_cleanup_description')}
              control={
                <SettingsSwitch
                  checked={settings.autoCleanupEnabled}
                  data-testid="worktrees-auto-cleanup-switch"
                  onCheckedChange={checked => {
                    if (!checked) {
                      setPendingDisableCleanup(true)
                    } else {
                      void updateSettings(
                        { autoCleanupEnabled: true },
                        t('workbench.worktrees_saved_cleanup')
                      )
                    }
                  }}
                  disabled={loading || saving}
                  aria-label={t('workbench.worktrees_auto_cleanup')}
                />
              }
            />
            <SettingsRow
              label={t('workbench.worktrees_keep_count')}
              description={t('workbench.worktrees_keep_count_description')}
              control={
                <div className="ml-6 max-sm:ml-0">
                  <input
                    type="number"
                    min={1}
                    data-testid="worktrees-keep-count-input"
                    value={keepCountDraft}
                    onChange={event => setKeepCountDraft(event.target.value)}
                    onBlur={commitKeepCount}
                    onKeyDown={event => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                    disabled={loading || saving || !settings.autoCleanupEnabled}
                    className="w-24 rounded-md border border-border bg-background px-2.5 py-1.5 text-base text-text-primary outline-none [appearance:textfield] focus:border-primary disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </div>
              }
            />
          </SettingsGroup>
        )
      )}

      {error && (
        <div className="mt-5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {error}
        </div>
      )}

      <section className="mt-10">
        {loading ? (
          <div className="py-10 text-center text-sm text-text-secondary">{t('common.loading')}</div>
        ) : groups.length === 0 ? (
          <div>
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                data-testid="worktrees-refresh-button"
                onClick={() => void load()}
                disabled={unavailable || loading || saving || busyPath !== null}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
                aria-label={t('workbench.worktrees_refresh')}
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            <div className="rounded-2xl border border-border bg-surface px-4 py-4 text-sm text-text-secondary">
              {t('workbench.worktrees_empty_description')}
            </div>
          </div>
        ) : (
          <div className="space-y-10">
            {groups.map((group, index) => (
              <div key={group.key} data-testid="worktree-project-group">
                <div
                  data-testid="worktree-project-header"
                  className="mb-4 flex min-w-0 items-center justify-between gap-3"
                >
                  <h3
                    className="truncate text-sm text-text-primary"
                    title={group.sourcePath || group.name}
                  >
                    {group.sourcePath || group.name}
                  </h3>
                  {index === 0 && (
                    <button
                      type="button"
                      data-testid="worktrees-refresh-button"
                      onClick={() => void load()}
                      disabled={unavailable || loading || saving || busyPath !== null}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
                      aria-label={t('workbench.worktrees_refresh')}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <SettingsGroup className="bg-background">
                  {group.items.map(item => (
                    <WorktreeRow
                      key={`${item.deviceId}-${item.path}`}
                      item={item}
                      busy={busyPath === item.path}
                      openingTaskId={openingTaskId}
                      onArchive={() => void previewArchive(item)}
                      onRestore={() => void restoreWorktree(item)}
                      onForget={() => {
                        setForgetDraft('')
                        setPendingForget(item)
                      }}
                      onOpenConversation={
                        onOpenRuntimeTask
                          ? conversation => void openConversation(conversation)
                          : undefined
                      }
                    />
                  ))}
                </SettingsGroup>
              </div>
            ))}
          </div>
        )}
      </section>

      {savedNotice && (
        <div
          role="status"
          data-testid="worktrees-saved-notice"
          className="fixed left-1/2 top-5 z-[1100] flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-primary/35 bg-[rgb(var(--color-sidebar-active))] px-5 py-3 text-sm font-medium text-text-primary shadow-lg"
        >
          <CircleCheck className="h-5 w-5 text-primary" />
          <span>{savedNotice}</span>
          <button
            type="button"
            data-testid="dismiss-worktrees-saved-notice-button"
            onClick={() => setSavedNotice(null)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
            aria-label={t('workbench.worktrees_dismiss_saved_notice')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {pendingArchive && (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/45 px-4">
          <div
            role="dialog"
            aria-modal="true"
            data-testid="archive-worktree-dialog"
            className="w-full max-w-[640px] rounded-[28px] border border-border bg-popover px-8 py-7 shadow-[0_24px_64px_rgba(0,0,0,0.34)]"
          >
            <h2 className="heading-base text-text-primary">
              {t('workbench.worktrees_archive_title')}
            </h2>
            <p className="mt-4 text-sm leading-7 text-text-secondary">{pendingArchive.item.path}</p>
            <ul className="mt-3 list-disc pl-5 text-sm leading-7 text-text-secondary">
              <li>
                {t('workbench.worktrees_dirty')}:{' '}
                {pendingArchive.preview.dirty
                  ? t('workbench.worktrees_yes')
                  : t('workbench.worktrees_no')}
              </li>
              <li>
                {t('workbench.worktrees_untracked')}: {pendingArchive.preview.untrackedFileCount}
              </li>
              <li>
                {t('workbench.worktrees_commits_since_creation')}:{' '}
                {pendingArchive.preview.commitsSinceCreation}
              </li>
            </ul>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setPendingArchive(null)}
                className="h-10 rounded-xl px-5 text-sm text-text-secondary hover:bg-muted"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                data-testid="confirm-archive-worktree-button"
                onClick={() => void confirmArchive()}
                disabled={busyPath === pendingArchive.item.path}
                className="h-10 rounded-xl bg-red-500/15 px-5 text-sm font-semibold text-red-500 hover:bg-red-500/20 disabled:opacity-50"
              >
                {t('workbench.worktrees_archive')}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingForget && (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/45 px-4">
          <div
            role="dialog"
            aria-modal="true"
            data-testid="forget-worktree-dialog"
            className="w-full max-w-[640px] rounded-[28px] border border-border bg-popover px-8 py-7 shadow-[0_24px_64px_rgba(0,0,0,0.34)]"
          >
            <h2 className="heading-base text-text-primary">
              {t('workbench.worktrees_forget_title')}
            </h2>
            <p className="mt-4 text-sm leading-7 text-text-secondary">
              {t('workbench.worktrees_forget_description', { id: pendingForget.worktreeId })}
            </p>
            <input
              data-testid="forget-worktree-confirmation-input"
              value={forgetDraft}
              onChange={event => setForgetDraft(event.target.value)}
              className="mt-4 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary"
            />
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setPendingForget(null)}
                className="h-10 rounded-xl px-5 text-sm text-text-secondary hover:bg-muted"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                data-testid="confirm-forget-worktree-button"
                onClick={() => void confirmForget()}
                disabled={
                  forgetDraft !== pendingForget.worktreeId || busyPath === pendingForget.path
                }
                className="h-10 rounded-xl bg-red-500/15 px-5 text-sm font-semibold text-red-500 hover:bg-red-500/20 disabled:opacity-50"
              >
                {t('workbench.worktrees_forget')}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDisableCleanup && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/45 px-4"
          onClick={event => {
            if (!saving && event.target === event.currentTarget) setPendingDisableCleanup(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            data-testid="disable-worktree-cleanup-dialog"
            className="w-full max-w-[640px] rounded-[28px] border border-border bg-popover px-8 py-7 shadow-[0_24px_64px_rgba(0,0,0,0.34)]"
          >
            <h2 className="heading-base text-text-primary">
              {t('workbench.worktrees_disable_cleanup_title')}
            </h2>
            <p className="mt-5 text-sm leading-7 text-text-secondary">
              {t('workbench.worktrees_disable_cleanup_description')}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                data-testid="keep-worktree-cleanup-button"
                onClick={() => setPendingDisableCleanup(false)}
                disabled={loading || saving}
                className="h-10 rounded-xl px-5 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
              >
                {t('workbench.worktrees_keep_cleanup_enabled')}
              </button>
              <button
                type="button"
                data-testid="disable-worktree-cleanup-button"
                onClick={() => {
                  void updateSettings(
                    { autoCleanupEnabled: false },
                    t('workbench.worktrees_saved_cleanup')
                  ).then(success => {
                    if (success) setPendingDisableCleanup(false)
                  })
                }}
                disabled={loading || saving}
                className="h-10 rounded-xl bg-red-500/15 px-5 text-sm font-semibold text-red-500 hover:bg-red-500/20 disabled:opacity-50"
              >
                {t('workbench.worktrees_disable_cleanup')}
              </button>
            </div>
          </div>
        </div>
      )}
    </SettingsPage>
  )
}
