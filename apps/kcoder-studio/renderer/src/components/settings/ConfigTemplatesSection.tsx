import { FileCode } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

import { Button } from '@/components/ui/button'
import {
  deleteSettingsTemplate,
  listSettingsTemplates,
  readSettingsTemplate,
  saveSettingsTemplate,
  setDefaultSettingsTemplate,
  type SettingsTemplateSummary,
} from '@/kcoder/configTemplates'

import { SectionHeader, SettingsGroup } from './settings-ui'

interface TemplateDraft {
  id?: string
  name: string
  description: string
  content: string
}

function emptyDraft(): TemplateDraft {
  return { name: '', description: '', content: '{\n  \n}\n' }
}

export function ConfigTemplatesSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation('common')
  const fileInput = useRef<HTMLInputElement>(null)
  const importDescriptionId = useId()
  const [templates, setTemplates] = useState<SettingsTemplateSummary[]>([])
  const [defaultId, setDefaultId] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<TemplateDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const label = (key: string) => t(`configTemplates.${key}`)

  const refresh = useCallback(async () => {
    if (!serverId) return
    setBusy(true)
    setError(null)
    try {
      const catalog = await listSettingsTemplates(serverId)
      setTemplates(catalog.templates)
      setDefaultId(catalog.defaultId)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setTemplates([])
      setDefaultId(undefined)
    } finally {
      setBusy(false)
    }
  }, [serverId])

  // Editor state resets come from the parent's `key={serverId}` remount. The
  // fetch starts on a microtask so the effect body itself never calls setState
  // synchronously (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await Promise.resolve()
      if (!cancelled) await refresh()
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  const edit = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      const stored = await readSettingsTemplate(serverId, id)
      setDraft({
        id: stored.summary.id,
        name: stored.summary.name,
        description: stored.summary.description ?? '',
        content: stored.content,
      })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await saveSettingsTemplate(serverId, {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        content: draft.content,
      })
      setDraft(null)
      setNotice(label('saved'))
      await refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (summary: SettingsTemplateSummary) => {
    if (!window.confirm(label('deleteConfirm').replace('{name}', summary.name))) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const catalog = await deleteSettingsTemplate(serverId, summary.id)
      setTemplates(catalog.templates)
      setDefaultId(catalog.defaultId)
      setNotice(label('removed'))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const switchDefault = async (id: string | null) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const catalog = await setDefaultSettingsTemplate(serverId, id)
      setTemplates(catalog.templates)
      setDefaultId(catalog.defaultId)
      setNotice(id ? label('defaultSet') : label('defaultCleared'))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const importFile = async (file: File) => {
    setError(null)
    try {
      const content = await file.text()
      setDraft({
        name: file.name.replace(/\.jsonc?$/i, ''),
        description: '',
        content,
      })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  return (
    <SettingsGroup data-testid="config-templates-section" className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeader
          icon={<FileCode />}
          title={label('title')}
          description={label('description')}
        />
        <div className="flex gap-2">
          <Button
            data-testid="config-templates-refresh"
            variant="outline"
            disabled={busy || !serverId}
            onClick={() => void refresh()}
          >
            {label('refresh')}
          </Button>
          <Button
            data-testid="config-templates-new"
            disabled={!serverId}
            onClick={() => setDraft(emptyDraft())}
          >
            {label('newTemplate')}
          </Button>
        </div>
      </div>

      {defaultId ? (
        <p data-testid="config-templates-default" className="text-sm text-muted-foreground">
          {label('defaultHelp').replace('{id}', defaultId)}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{label('defaultUnset')}</p>
      )}

      {error && (
        <div data-testid="config-templates-error" role="alert" className="text-sm text-red-600">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="text-sm text-muted-foreground">
          {notice}
        </div>
      )}

      {templates.length === 0 ? (
        <p data-testid="config-templates-empty" className="text-sm text-muted-foreground">
          {label('empty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {templates.map(template => (
            <li
              key={template.id}
              data-testid={`config-template-${template.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface/60 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {template.name}
                  {template.id === defaultId && (
                    <span
                      data-testid={`config-template-default-${template.id}`}
                      className="ml-2 text-xs text-muted-foreground"
                    >
                      {label('defaultBadge')}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {template.id} · {Math.max(1, Math.round(template.sizeBytes / 1024))} KiB
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  data-testid={`config-template-edit-${template.id}`}
                  variant="outline"
                  disabled={busy}
                  onClick={() => void edit(template.id)}
                >
                  {label('edit')}
                </Button>
                {template.id === defaultId ? (
                  <Button
                    data-testid={`config-template-clear-${template.id}`}
                    variant="outline"
                    disabled={busy}
                    onClick={() => void switchDefault(null)}
                  >
                    {label('clearDefault')}
                  </Button>
                ) : (
                  <Button
                    data-testid={`config-template-default-action-${template.id}`}
                    variant="outline"
                    disabled={busy}
                    onClick={() => void switchDefault(template.id)}
                  >
                    {label('useAsDefault')}
                  </Button>
                )}
                <Button
                  data-testid={`config-template-delete-${template.id}`}
                  variant="outline"
                  disabled={busy}
                  onClick={() => void remove(template)}
                >
                  {label('remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        <p id={importDescriptionId} className="text-sm">
          {label('importFile')}
        </p>
        <Button
          type="button"
          variant="outline"
          data-testid="config-templates-import-button"
          aria-describedby={importDescriptionId}
          disabled={!serverId || busy}
          onClick={() => fileInput.current?.click()}
        >
          <FileCode className="h-4 w-4" aria-hidden="true" />
          {label('chooseFile')}
        </Button>
        <input
          ref={fileInput}
          data-testid="config-templates-import"
          type="file"
          accept=".json,.jsonc"
          hidden
          aria-label={label('chooseFile')}
          disabled={!serverId || busy}
          onChange={event => {
            const file = event.target.files?.[0]
            if (file) void importFile(file)
            event.target.value = ''
          }}
        />
      </div>

      {draft && (
        <form
          data-testid="config-templates-editor"
          className="space-y-2 rounded-lg border border-border p-3"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="block text-sm">
            {label('nameLabel')}
            <input
              data-testid="config-templates-name"
              className="mt-1 block w-full rounded border border-border bg-transparent px-2 py-1"
              value={draft.name}
              onChange={event => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            {label('descriptionLabel')}
            <input
              data-testid="config-templates-description"
              className="mt-1 block w-full rounded border border-border bg-transparent px-2 py-1"
              value={draft.description}
              onChange={event => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            {label('contentLabel')}
            <textarea
              data-testid="config-templates-content"
              className="mt-1 block h-40 w-full rounded border border-border bg-transparent px-2 py-1 font-mono text-xs"
              value={draft.content}
              onChange={event => setDraft({ ...draft, content: event.target.value })}
            />
          </label>
          <div className="flex gap-2">
            <Button
              data-testid="config-templates-save"
              type="submit"
              disabled={busy || !draft.name.trim()}
            >
              {label('save')}
            </Button>
            <Button
              data-testid="config-templates-cancel"
              type="button"
              variant="outline"
              onClick={() => setDraft(null)}
            >
              {label('cancel')}
            </Button>
          </div>
        </form>
      )}
    </SettingsGroup>
  )
}
