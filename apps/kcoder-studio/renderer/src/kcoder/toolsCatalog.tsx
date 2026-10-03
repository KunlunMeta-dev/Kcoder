import { useEffect, useState, type ReactNode } from 'react'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { useTranslation } from '@/hooks/useTranslation'
import {
  ToolsCatalogContext,
  emptyToolsCatalog as empty,
  readToolsCatalog,
  toolCatalogIcons,
  type ToolCatalogEntry,
  type ToolCatalogSnapshot,
} from './toolsCatalogContext'

export function ToolsCatalogProvider({
  children,
  taskId,
  serverId,
  revision,
}: {
  children: ReactNode
  taskId?: string
  serverId?: string
  revision?: unknown
}) {
  const { t } = useTranslation('chat')
  const [state, setState] = useState<{
    key: string
    revision: unknown
    snapshot: ToolCatalogSnapshot
  } | null>(null)
  const key = JSON.stringify([serverId, taskId])
  useEffect(() => {
    let active = true
    let generation = 0
    const refresh = () => {
      const current = ++generation
      setState(null)
      if (!taskId) return
      void readToolsCatalog(taskId, serverId)
        .then(snapshot => {
          if (active && current === generation) setState({ key, revision, snapshot })
        })
        .catch(() => {
          if (active && current === generation) setState(null)
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('kcoder:tools-catalog-invalidated', refresh)
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
      window.removeEventListener('kcoder:tools-catalog-invalidated', refresh)
      window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
    }
  }, [taskId, serverId, key, revision])
  const snapshot = state?.key === key && state.revision === revision ? state.snapshot : null
  return (
    <ToolsCatalogContext.Provider value={snapshot?.entries ?? empty}>
      {snapshot?.truncated && (
        <p
          role="status"
          data-testid="tools-catalog-truncation"
          className="px-4 py-2 text-xs text-text-secondary"
        >
          {t('tool_activity.catalog_truncated', {
            shown: snapshot.entries.size,
            total: snapshot.total,
          })}
        </p>
      )}
      {children}
    </ToolsCatalogContext.Provider>
  )
}

export function ToolCatalogIcon({ entry }: { entry: ToolCatalogEntry }) {
  const Icon = toolCatalogIcons[entry.icon] ?? toolCatalogIcons.tool
  return (
    <Icon className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" data-tool-group={entry.group} />
  )
}
