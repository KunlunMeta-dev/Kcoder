import { TOOLS_CATALOG_INVALIDATED_EVENT, toolsCatalogChangeApplies } from './toolsCatalogEvents'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { useTranslation } from '@/hooks/useTranslation'
import { useRetainedPageVisible } from '@/components/layout/retainedPageState'
import { CONVERSATION_GUIDANCE_TOOL } from '@/components/chat/blocks/toolBlockKinds'
import {
  ToolsCatalogContext,
  ToolProgressScopeContext,
  emptyToolsCatalog as empty,
  readToolsCatalog,
  toolCatalogIcons,
  type ToolCatalogEntry,
  type ToolCatalogSnapshot,
} from './toolsCatalogContext'
import { toolPathPreviews } from './toolPathPreview'
import type { ProcessingBlock, ToolBlock, WorkbenchMessage } from '@/types/workbench'

const isCatalogTool = (block: ProcessingBlock): block is ToolBlock =>
  block.type === 'tool' && block.toolName !== CONVERSATION_GUIDANCE_TOOL

const noSubscribe = () => () => {}
const noInputs = () => false

function createTranscriptToolPresenceReader() {
  const presenceByMessage = new WeakMap<WorkbenchMessage, boolean>()
  return (messages: readonly WorkbenchMessage[]) => messages.some(message => {
    let hasTool = presenceByMessage.get(message)
    if (hasTool === undefined) {
      hasTool = message.blocks?.some(isCatalogTool) ?? false
      presenceByMessage.set(message, hasTool)
    }
    return hasTool
  })
}

export function ToolsCatalogProvider({
  children,
  taskId,
  serverId,
  messages,
  progressEnabled = true,
  progressTaskId = taskId,
}: {
  children: ReactNode
  taskId?: string
  serverId?: string
  messages: readonly WorkbenchMessage[]
  isWaitingForAssistant?: boolean
  progressEnabled?: boolean
  progressTaskId?: string
}) {
  const { t } = useTranslation('chat')
  const visible = useRetainedPageVisible()
  const readTranscriptToolPresence = useMemo(() => createTranscriptToolPresenceReader(), [])
  const hasTranscriptTools = useMemo(() => visible && readTranscriptToolPresence(messages),
    [visible, messages, readTranscriptToolPresence])
  const subscribe = useCallback((listener: () => void) =>
    toolPathPreviews.subscribe(listener, serverId, progressTaskId), [serverId, progressTaskId])
  const hasGeneratingTools = useSyncExternalStore(
    visible && progressEnabled && serverId && progressTaskId && !hasTranscriptTools ? subscribe : noSubscribe,
    () => visible && progressEnabled && !hasTranscriptTools && toolPathPreviews.hasInputs(serverId, progressTaskId),
    noInputs
  )
  const needsCatalog = hasTranscriptTools || hasGeneratingTools
  const revision = needsCatalog ? 'available' : null
  const [state, setState] = useState<{
    key: string
    revision: string
    snapshot: ToolCatalogSnapshot
  } | null>(null)
  const key = JSON.stringify([serverId, taskId])
  const readScope = useMemo(() => ({ key, visible }), [key, visible])
  const inFlight = useRef<{
    scope: object
    promise: Promise<ToolCatalogSnapshot>
  } | null>(null)
  const progressScope = useMemo(
    () => (visible && progressEnabled ? { target: serverId, task: progressTaskId } : {}),
    [visible, progressEnabled, serverId, progressTaskId]
  )
  useEffect(() => {
    if (progressEnabled && serverId && progressTaskId)
      return toolPathPreviews.acquire(serverId, progressTaskId)
  }, [progressEnabled, serverId, progressTaskId])
  useEffect(() => {
    if (revision === null) return
    let active = true
    let generation = 0
    let pending: Promise<ToolCatalogSnapshot | undefined> | undefined
    const refresh = (event?: Event) => {
      if (event && !toolsCatalogChangeApplies(event, serverId)) return
      const visible = document.visibilityState !== 'hidden'
      if (!visible || (event && event.type !== 'focus'))
        pending = undefined
      if (pending) return
      const current = ++generation
      setState(null)
      if (!visible || !taskId) return
      const previous = inFlight.current
      const request = (async () => {
        // Lifecycle changes retire the old display, then reconcile the latest state once.
        // Explicit invalidations must not wait for a pre-change catalog.
        if (!event && previous?.scope === readScope) await previous.promise.catch(() => {})
        // Finish the notification cohort before dispatching its latest display read.
        await Promise.resolve()
        if (!active || current !== generation) return
        const read = { scope: readScope, promise: readToolsCatalog(taskId, serverId) }
        inFlight.current = read
        try { return await read.promise }
        finally { if (inFlight.current === read) inFlight.current = null }
      })()
      pending = request
      void request
        .then(snapshot => {
          if (snapshot && active && current === generation) setState({ key, revision, snapshot })
        })
        .catch(() => {
          if (active && current === generation) setState(null)
        })
        .finally(() => {
          if (pending === request) pending = undefined
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener(TOOLS_CATALOG_INVALIDATED_EVENT, refresh)
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
      window.removeEventListener(TOOLS_CATALOG_INVALIDATED_EVENT, refresh)
      window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, refresh)
    }
  }, [taskId, serverId, key, revision, readScope])
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
      <ToolProgressScopeContext.Provider value={progressScope}>
        {children}
      </ToolProgressScopeContext.Provider>
    </ToolsCatalogContext.Provider>
  )
}

export function ToolCatalogIcon({ entry }: { entry: ToolCatalogEntry }) {
  const Icon = toolCatalogIcons[entry.icon] ?? toolCatalogIcons.tool
  return (
    <Icon className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" data-tool-group={entry.group} />
  )
}
