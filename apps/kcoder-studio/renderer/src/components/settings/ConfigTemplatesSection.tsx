import {
  FileCode,
  Info,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

import { ActionMenu } from '@/components/common/ActionMenu'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import {
  deleteSettingsTemplate,
  listSettingsTemplates,
  readSettingsTemplate,
  saveSettingsTemplate,
  setDefaultSettingsTemplate,
  type SettingsTemplateCatalog,
  type SettingsTemplateSummary,
} from '@/kcoder/configTemplates'

import { RuntimeTargetConfirmDialog } from './RuntimeTargetConfirmDialog'
import { SectionHeader, SettingsGroup } from './settings-ui'

interface TemplateDraft {
  id?: string
  name: string
  description: string
  content: string
}

export function ConfigTemplatesSection({ serverId }: { serverId: string }) {
  // Each target owns its catalog, pending operations and editor independently.
  return <ConfigTemplatesEditor key={serverId} serverId={serverId} />
}

function ConfigTemplatesEditor({ serverId }: { serverId: string }) {
  const { t } = useTranslation('common')
  const fileInput = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  const generation = useRef(0)
  const pending = useRef(false)
  const [templates, setTemplates] = useState<SettingsTemplateSummary[]>([])
  const [defaultId, setDefaultId] = useState<string>()
  const [draft, setDraft] = useState<TemplateDraft | null>(null)
  const [deleting, setDeleting] = useState<SettingsTemplateSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const label = (key: string) => t(`configTemplates.${key}`)

  const runOperation = useCallback(
    async <T,>(
      operation: () => Promise<T>,
      onSuccess: (result: T) => void,
      onFailure?: () => void
    ) => {
      if (!serverId || pending.current) return
      pending.current = true
      const current = generation.current
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        const result = await operation()
        if (current === generation.current) onSuccess(result)
      } catch (failure) {
        if (current === generation.current) {
          setError(failure instanceof Error ? failure.message : String(failure))
          onFailure?.()
        }
      } finally {
        if (current === generation.current) {
          pending.current = false
          setBusy(false)
        }
      }
    },
    [serverId]
  )

  const applyCatalog = (catalog: SettingsTemplateCatalog) => {
    setTemplates(catalog.templates)
    setDefaultId(catalog.defaultId)
  }

  const refresh = useCallback(
    () =>
      runOperation(
        async () => {
          setLoadState('loading')
          return listSettingsTemplates(serverId)
        },
        catalog => {
          setTemplates(catalog.templates)
          setDefaultId(catalog.defaultId)
          setLoadState('ready')
        },
        () => setLoadState('error')
      ),
    [runOperation, serverId]
  )

  useEffect(() => {
    let active = true
    const current = generation.current
    void Promise.resolve().then(() => {
      if (active) void refresh()
    })
    return () => {
      active = false
      generation.current = current + 1
      pending.current = false
    }
  }, [refresh])

  const edit = (id: string) =>
    runOperation(
      () => readSettingsTemplate(serverId, id),
      stored => {
        setDraft({
          id: stored.summary.id,
          name: stored.summary.name,
          description: stored.summary.description ?? '',
          content: stored.content,
        })
      }
    )

  const save = async () => {
    if (!draft || !draft.name.trim()) return
    await runOperation(
      () =>
        saveSettingsTemplate(serverId, {
          ...(draft.id ? { id: draft.id } : {}),
          name: draft.name.trim(),
          ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
          content: draft.content,
        }),
      saved => {
        // Use the authoritative save response; a failed second read must not
        // turn a successful write into an apparent save failure.
        setTemplates(previous => {
          const exists = previous.some(template => template.id === saved.template.id)
          return exists
            ? previous.map(template =>
                template.id === saved.template.id ? saved.template : template
              )
            : [...previous, saved.template]
        })
        setDefaultId(saved.defaultId)
        setDraft(null)
        setNotice(label('saved'))
      }
    )
  }

  const remove = async () => {
    if (!deleting) return
    await runOperation(
      () => deleteSettingsTemplate(serverId, deleting.id),
      catalog => {
        applyCatalog(catalog)
        setDeleting(null)
        setNotice(label('removed'))
      }
    )
  }

  const switchDefault = (id: string | null) =>
    runOperation(
      () => setDefaultSettingsTemplate(serverId, id),
      catalog => {
        applyCatalog(catalog)
        setNotice(id ? label('defaultSet') : label('defaultCleared'))
      }
    )

  const importFile = (file: File) =>
    runOperation(
      () => file.text(),
      content => {
        setDraft({ name: file.name.replace(/\.jsonc?$/i, ''), description: '', content })
      }
    )

  const actionsDisabled = busy || !serverId || loadState !== 'ready' || Boolean(draft || deleting)
  const defaultName = templates.find(template => template.id === defaultId)?.name ?? defaultId
  const errorFeedback = error && (
    <div
      data-testid="config-templates-error"
      role="alert"
      className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive break-words"
    >
      {error}
    </div>
  )

  return (
    <SettingsGroup data-testid="config-templates-section" className="space-y-4 bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeader
          icon={<FileCode />}
          title={label('title')}
          description={label('description')}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="config-templates-refresh"
            variant="outline"
            size="sm"
            className="max-md:min-h-11 max-md:min-w-11"
            aria-label={label('refresh')}
            title={label('refresh')}
            disabled={busy || !serverId || Boolean(draft || deleting)}
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {label('refresh')}
          </Button>
          <Button
            data-testid="config-templates-import-button"
            variant="outline"
            size="sm"
            className="max-md:min-h-11"
            disabled={actionsDisabled}
            onClick={() => fileInput.current?.click()}
          >
            <FileCode className="h-4 w-4" aria-hidden="true" />
            {label('chooseFile')}
          </Button>
          <Button
            data-testid="config-templates-new"
            size="sm"
            className="max-md:min-h-11"
            disabled={actionsDisabled}
            onClick={event => {
              event.currentTarget.focus()
              setError(null)
              setNotice(null)
              setDraft({ name: '', description: '', content: '{\n  \n}\n' })
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {label('newTemplate')}
          </Button>
        </div>
      </div>
      <input
        ref={fileInput}
        data-testid="config-templates-import"
        type="file"
        accept=".json,.jsonc"
        hidden
        aria-label={label('chooseFile')}
        disabled={actionsDisabled}
        onChange={event => {
          const file = event.target.files?.[0]
          if (file) void importFile(file)
          event.target.value = ''
        }}
      />
      {(loadState === 'ready' || templates.length > 0) && (
        <div
          data-testid={defaultId ? 'config-templates-default' : undefined}
          className="flex items-start gap-3 rounded-xl border border-focus/10 bg-accent-surface p-4 text-sm text-text-secondary break-words"
        >
          <Info className="mt-0.5 size-4 shrink-0 text-focus" aria-hidden="true" />
          <p>
            {defaultId
              ? t('configTemplates.defaultHelp', { name: defaultName })
              : label('defaultUnset')}
          </p>
        </div>
      )}
      {error && !draft && !deleting && errorFeedback}
      {loadState === 'error' && (
        <Button
          data-testid="config-templates-retry"
          variant="outline"
          size="sm"
          className="max-md:min-h-11"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {t('common.retry')}
        </Button>
      )}
      {busy && !draft && !deleting && (
        <p
          data-testid="config-templates-loading"
          role="status"
          className="flex items-center gap-2 text-sm text-text-secondary"
        >
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('common.loading')}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-text-secondary">
          {notice}
        </p>
      )}
      {loadState === 'ready' && templates.length === 0 && (
        <p data-testid="config-templates-empty" className="text-sm text-text-muted">
          {label('empty')}
        </p>
      )}
      {templates.length > 0 && (
        <ul className="divide-y divide-border/40" aria-busy={busy}>
          {templates.map(template => (
            <li
              key={template.id}
              data-testid={`config-template-${template.id}`}
              className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50"
            >
              <FileCode className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              <button
                type="button"
                data-testid={`config-template-edit-${template.id}`}
                disabled={actionsDisabled}
                className="min-h-11 min-w-0 flex-1 rounded-lg py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 disabled:opacity-50"
                onClick={event => {
                  event.currentTarget.focus()
                  void edit(template.id)
                }}
              >
                <span className="block truncate text-sm font-medium text-text-primary">
                  {template.name}
                </span>
                {template.description && (
                  <span className="mt-1 block line-clamp-2 text-xs text-text-secondary">
                    {template.description}
                  </span>
                )}
              </button>
              {template.id === defaultId && (
                <span
                  data-testid={`config-template-default-${template.id}`}
                  className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs text-text-secondary"
                >
                  {label('defaultBadge')}
                </span>
              )}
              <ActionMenu
                testId={`config-template-actions-${template.id}`}
                ariaLabel={t('configTemplates.actions', { name: template.name })}
                placement="bottom-end"
                disabled={actionsDisabled}
                items={[
                  {
                    label: label('edit'),
                    icon: Pencil,
                    testId: `config-template-menu-edit-${template.id}`,
                    onSelect: () => edit(template.id),
                  },
                  template.id === defaultId
                    ? {
                        label: label('clearDefault'),
                        icon: StarOff,
                        testId: `config-template-clear-${template.id}`,
                        onSelect: () => switchDefault(null),
                      }
                    : {
                        label: label('useAsDefault'),
                        icon: Star,
                        testId: `config-template-default-action-${template.id}`,
                        onSelect: () => switchDefault(template.id),
                      },
                  {
                    label: label('remove'),
                    icon: Trash2,
                    testId: `config-template-delete-${template.id}`,
                    danger: true,
                    onSelect: () => {
                      setError(null)
                      setNotice(null)
                      setDeleting(template)
                    },
                  },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {draft && (
        <ModalDialog
          testId="config-templates-editor"
          title={label(draft.id ? 'edit' : 'newTemplate')}
          pending={busy}
          onClose={() => setDraft(null)}
        >
          <form
            className="mt-4 space-y-4"
            onSubmit={event => {
              event.preventDefault()
              void save()
            }}
          >
            {errorFeedback}
            <div>
              <label htmlFor={`${fieldId}-name`} className="block text-sm">
                {label('nameLabel')}
              </label>
              <input
                id={`${fieldId}-name`}
                data-testid="config-templates-name"
                className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 outline-none focus:border-focus max-md:min-h-11"
                value={draft.name}
                disabled={busy}
                onChange={event => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor={`${fieldId}-description`} className="block text-sm">
                {label('descriptionLabel')}
              </label>
              <input
                id={`${fieldId}-description`}
                data-testid="config-templates-description"
                className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 outline-none focus:border-focus max-md:min-h-11"
                value={draft.description}
                disabled={busy}
                onChange={event => setDraft({ ...draft, description: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor={`${fieldId}-content`} className="block text-sm">
                {label('contentLabel')}
              </label>
              <textarea
                id={`${fieldId}-content`}
                data-testid="config-templates-content"
                className="text-code mt-1 h-56 w-full resize-y rounded-lg border border-border bg-background p-3 outline-none focus:border-focus"
                spellCheck={false}
                value={draft.content}
                disabled={busy}
                onChange={event => setDraft({ ...draft, content: event.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                data-testid="config-templates-cancel"
                type="button"
                variant="ghost"
                className="max-md:min-h-11"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                {label('cancel')}
              </Button>
              <Button
                data-testid="config-templates-save"
                type="submit"
                className="max-md:min-h-11"
                disabled={busy || !draft.name.trim()}
              >
                {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {busy ? t('common.saving') : label('save')}
              </Button>
            </div>
          </form>
        </ModalDialog>
      )}
      {deleting && (
        <RuntimeTargetConfirmDialog
          testId="config-template-delete-dialog"
          title={label('remove')}
          description={t('configTemplates.deleteConfirm', { name: deleting.name })}
          cancelLabel={label('cancel')}
          closeLabel={t('common.close')}
          confirmLabel={label('remove')}
          destructive
          pending={busy}
          error={error ?? undefined}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove()}
        />
      )}
    </SettingsGroup>
  )
}
