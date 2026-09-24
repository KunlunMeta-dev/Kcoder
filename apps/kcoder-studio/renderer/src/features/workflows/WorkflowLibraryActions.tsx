import { useEffect, useRef, useState } from 'react'
import { Copy, Download, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { workflowApi, type WorkflowDefinition } from './workflowApi'
export function WorkflowLibraryActions({
  serverId,
  definition,
  version,
  disabled,
  isCurrent,
  onVersion,
  onCreated,
  onError,
}: {
  serverId: string
  definition: WorkflowDefinition
  version: number | null
  disabled: boolean
  isCurrent: () => boolean
  onVersion: (version: number | null) => void
  onCreated: (definition: WorkflowDefinition) => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation('common')
  const [versions, setVersions] = useState<Array<{ version: number; title: string }>>([])
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let stopped = false
    void workflowApi
      .versions(serverId, definition.id)
      .then(value => {
        if (!stopped && isCurrent()) setVersions(value)
      })
      .catch(error => {
        if (!stopped && isCurrent()) onError(String(error))
      })
    return () => {
      stopped = true
    }
  }, [serverId, definition.id, definition.savedVersion, isCurrent, onError])
  const action = async (operation: () => Promise<void>) => {
    setBusy(true)
    try {
      await operation()
    } catch (error) {
      if (isCurrent()) onError(error instanceof Error ? error.message : String(error))
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="workflow-library-actions">
      <select
        aria-label={t('workflowCanvas.version')}
        className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
        value={version ?? ''}
        disabled={disabled || busy}
        onChange={event => onVersion(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">{t('workflowCanvas.editDraft')}</option>
        {versions.map(item => (
          <option key={item.version} value={item.version}>
            v{item.version} · {item.title}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || busy}
        onClick={() =>
          void action(async () => {
            const next = await workflowApi.clone(serverId, definition.id, version ?? undefined)
            if (isCurrent()) onCreated(next)
          })
        }
      >
        <Copy />
        {t('workflowCanvas.clone')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          void action(async () => {
            const next = await workflowApi.exportDefinition(
              serverId,
              definition.id,
              version ?? undefined
            )
            if (!isCurrent()) return
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(next)], { type: 'application/json' })
            )
            const link = document.createElement('a')
            link.href = url
            link.download = `workflow-${next.id}${version ? `-v${version}` : ''}.json`
            link.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
          })
        }
      >
        <Download />
        {t('workflowCanvas.export')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || busy}
        onClick={() => file.current?.click()}
      >
        <Upload />
        {t('workflowCanvas.import')}
      </Button>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={event => {
          const chosen = event.target.files?.[0]
          event.target.value = ''
          if (!chosen) return
          void action(async () => {
            if (chosen.size > 131072) throw new Error(t('workflowCanvas.importTooLarge'))
            const parsed: unknown = JSON.parse(await chosen.text())
            if (!isCurrent()) return
            const next = await workflowApi.importDefinition(serverId, parsed)
            if (isCurrent()) onCreated(next)
          })
        }}
      />
      {version != null && (
        <span className="text-xs text-text-muted">{t('workflowCanvas.readOnlyVersion')}</span>
      )}
    </div>
  )
}

export function WorkflowImportButton({
  serverId,
  isCurrent,
  onCreated,
  onError,
  disabled = false,
}: {
  disabled?: boolean
  serverId: string
  isCurrent: () => boolean
  onCreated: (definition: WorkflowDefinition) => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation('common')
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="w-full"
        disabled={busy || disabled}
        onClick={() => input.current?.click()}
      >
        <Upload />
        {t('workflowCanvas.import')}
      </Button>
      <input
        data-testid="workflow-import-file"
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          setBusy(true)
          void (async () => {
            if (file.size > 131072) throw new Error(t('workflowCanvas.importTooLarge'))
            const definition: unknown = JSON.parse(await file.text())
            if (!isCurrent()) return
            const next = await workflowApi.importDefinition(serverId, definition)
            if (isCurrent()) onCreated(next)
          })()
            .catch(error => {
              if (isCurrent()) onError(error instanceof Error ? error.message : String(error))
            })
            .finally(() => {
              if (isCurrent()) setBusy(false)
            })
        }}
      />
    </>
  )
}
