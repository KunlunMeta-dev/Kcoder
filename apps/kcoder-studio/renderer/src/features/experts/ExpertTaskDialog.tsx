import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { isContract } from '../../../../shared/generated/validator.mjs'
import type { OfficeAssistantVersion } from '../../../../shared/generated/contracts'
import type { OfficeAssistantItem, OfficeList } from '@/features/office-integration/controller'
import type { ExpertClient } from './client'
import { expertPresentation } from './presentation'

/** Selection prepares an ordinary draft; only its first submission creates a Native task. */
export function ExpertTaskDialog({
  client,
  initial,
  onClose,
  onSelect,
  onClear,
  nextTurn = false,
}: {
  client: ExpertClient
  initial?: OfficeAssistantItem
  onClose: () => void
  onSelect?: (expert: import('@/types/workbench').ExpertTaskSelection) => void | Promise<void>
  onClear?: () => Promise<void>
  nextTurn?: boolean
}) {
  const { t, i18n } = useTranslation('experts')
  const { startExpertTask } = useWorkbench()
  const [items, setItems] = useState<OfficeAssistantItem[]>(initial ? [initial] : [])
  const [id, setId] = useState(initial?.definition.id ?? '')
  const [versions, setVersions] = useState<OfficeAssistantVersion[]>([])
  const [version, setVersion] = useState('')
  const [cursor, setCursor] = useState<string>()
  const [next, setNext] = useState<string | null>(null)
  const [versionCursor, setVersionCursor] = useState<string>()
  const [versionNext, setVersionNext] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (initial) return
    const abort = new AbortController()
    void client
      .list(cursor, i18n.language.startsWith('zh') ? 'zh-CN' : 'en', abort.signal)
      .then(result => {
        if (abort.signal.aborted) return
        setItems(
          result.items.filter(
            item =>
              expertPresentation(item.definition).kind !== 'team' &&
              expertPresentation(item.definition).enabled
          )
        )
        setNext(result.nextCursor)
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true)
      })
    return () => abort.abort()
  }, [client, cursor, i18n.language, initial])
  useEffect(() => {
    const abort = new AbortController()
    if (!id) {
      queueMicrotask(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
      return () => abort.abort()
    }
    queueMicrotask(() => {
      if (!abort.signal.aborted) {
        setBusy(true)
        setError(false)
      }
    })
    void client.controller
      .call<OfficeList<OfficeAssistantVersion>>(
        'assistant/versions',
        { id, limit: 10, ...(versionCursor ? { cursor: versionCursor } : {}) },
        undefined,
        abort.signal
      )
      .then(result => {
        if (abort.signal.aborted) return
        const scope = JSON.parse(client.controller.scopeKey())
        setVersions(
          result.items.filter(
            saved =>
              isContract('OfficeAssistantVersion', saved) &&
              !saved.archived &&
              saved.definition.id === id &&
              saved.owner.accountId === scope.accountId &&
              saved.owner.targetId === scope.targetId &&
              saved.owner.workspaceId === scope.workspaceId
          )
        )
        setVersionNext(result.nextCursor)
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => abort.abort()
  }, [client, id, versionCursor])
  const saved = versions.find(item => item.version === version)
  const target = client.target
  return (
    <ModalDialog
      title={t('task.selectorLabel')}
      testId="expert-task-dialog"
      onClose={onClose}
      closeLabel={t('close')}
    >
      <div className="mt-4 space-y-4">
        {!initial && (
          <SettingsSelect
            aria-label={t('task.selectorLabel')}
            data-testid="expert-task-expert-select"
            value={id ? `expert:${id}` : ''}
            disabled={busy}
            onChange={async event => {
              const value = event.target.value
              if (value === 'none' && onClear) {
                setBusy(true)
                setError(false)
                try {
                  await onClear()
                  onClose()
                } catch {
                  setError(true)
                } finally {
                  setBusy(false)
                }
                return
              }
              setId(value.slice('expert:'.length))
              setVersion('')
              setVersions([])
              setVersionCursor(undefined)
              setVersionNext(null)
            }}
          >
            <option value="" disabled>
              {t('task.choose')}
            </option>
            {onClear && <option value="none">{t('task.noExpert')}</option>}
            {items.map(item => (
              <option key={item.definition.id} value={`expert:${item.definition.id}`}>
                {item.definition.title}
              </option>
            ))}
          </SettingsSelect>
        )}
        {next && !initial && (
          <Button
            variant="ghost"
            onClick={() => {
              setCursor(next)
              setId('')
              setVersion('')
              setVersions([])
              setVersionCursor(undefined)
              setVersionNext(null)
            }}
          >
            {t('next')}
          </Button>
        )}
        {id && (
          <SettingsSelect
            aria-label={t('version')}
            data-testid="expert-task-version-select"
            value={version}
            disabled={busy || !id}
            onChange={event => setVersion(event.target.value)}
          >
            <option value="">{t('task.chooseVersion')}</option>
            {versions.map(item => (
              <option key={item.version} value={item.version}>
                {item.definition.title} · {item.version}
              </option>
            ))}
          </SettingsSelect>
        )}
        {id && versionNext && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setVersionCursor(versionNext)
              setVersion('')
              setVersions([])
            }}
          >
            {t('next')}
          </Button>
        )}
        {id && !busy && !versions.length && !error && (
          <p role="status">{t('task.saveVersionFirst')}</p>
        )}
        {(error || !target?.workspacePath) && <p role="alert">{t('unavailable')}</p>}
        {id && nextTurn && (
          <p className="sr-only" role="status">
            {t('task.nextTurnHint')}
          </p>
        )}
        {id && (
          <Button
            disabled={busy || !saved || !target?.workspacePath || !(onSelect ?? startExpertTask)}
            onClick={async () => {
              const select = onSelect ?? startExpertTask
              if (!saved || !target?.workspacePath || !select) return
              setBusy(true)
              setError(false)
              try {
                await select({
                  deviceId: target.serverId,
                  workspacePath: target.workspacePath,
                  reference: {
                    id: saved.definition.id,
                    version: saved.version,
                    definitionSha256: saved.definitionSha256,
                  },
                  title: saved.definition.title,
                })
                onClose()
              } catch {
                setError(true)
              } finally {
                setBusy(false)
              }
            }}
          >
            {t(onSelect ? 'task.apply' : 'task.prepare')}
          </Button>
        )}
      </div>
    </ModalDialog>
  )
}
