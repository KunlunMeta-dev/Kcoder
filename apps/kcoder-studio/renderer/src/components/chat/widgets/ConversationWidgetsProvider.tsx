import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import type { WidgetRef } from '../../../../../shared/generated/contracts'
import { createWidgetApi, validateWidgetReference, type WidgetRequest } from '@/kcoder/widgetApi'
import { createMcpAppApi } from '@/kcoder/mcpAppApi'
import { subscribeCommittedWidgets } from '@/kcoder/widgetEvents'
import {
  captureAccountContextRevision,
  listenAccountContextChanges,
} from '@/kcoder/accountContextEvents'
import { clearWidgetUiStateForTarget } from '@/kcoder/widgetUiState'
import { createRandomUuid } from '@/lib/random-id'
import {
  clearWidgetPreviews,
  readWidgetPreviews,
  subscribeWidgetPreviews,
} from '@/kcoder/widgetPreviewEvents'
import { ConversationWidgetsContext } from './widgetContext'

interface Props {
  address?: RuntimeTaskAddress | null
  messages: WorkbenchMessage[]
  onSendPrompt: (text: string) => void
  request?: WidgetRequest
  children: ReactNode
}

function resolvedThreadId(address?: RuntimeTaskAddress | null): string | undefined {
  const handle = address?.runtimeHandle
  const id = address?.threadId ?? handle?.threadId ?? handle?.sessionId ?? handle?.session_id
  return typeof id === 'string' && id ? id : undefined
}

export function ConversationWidgetsProvider(props: Props) {
  const threadId = resolvedThreadId(props.address)
  if (!props.address || !threadId) return <>{props.children}</>
  const scopeKey = `${props.address.deviceId}:${props.address.taskId}:${threadId}:${props.address.workspacePath ?? ''}`
  return (
    <ScopedWidgetsProvider
      {...props}
      address={props.address}
      threadId={threadId}
      scopeKey={scopeKey}
      key={scopeKey}
    />
  )
}

function ScopedWidgetsProvider({
  address,
  threadId,
  scopeKey,
  messages,
  onSendPrompt,
  request,
  children,
}: Props & { address: RuntimeTaskAddress; threadId: string; scopeKey: string }) {
  const [boundAddress] = useState(address)
  const [references, setReferences] = useState<WidgetRef[]>([])
  const [previews, setPreviews] = useState(() =>
    readWidgetPreviews(address.deviceId, address.taskId)
  )
  const [invalidated, setInvalidated] = useState(false)
  const [listingStatus, setListingStatus] = useState<'unrequested' | 'loaded' | 'failed'>(
    'unrequested'
  )
  const [reloadGeneration, setReloadGeneration] = useState(0)
  const reload = useCallback(() => {
    setListingStatus('unrequested')
    setReloadGeneration(value => value + 1)
  }, [])
  const probeClaims = useRef(new Set<string>())
  const claimProbe = useCallback((widget: WidgetRef) => {
    const key = `${widget.widgetId}:${widget.revision}:${widget.sha256}`
    if (probeClaims.current.has(key)) return false
    probeClaims.current.add(key)
    if (probeClaims.current.size > 512)
      probeClaims.current.delete(probeClaims.current.values().next().value!)
    return true
  }, [])
  const [mountIdentity] = useState(createRandomUuid)
  const [accountValid] = useState(captureAccountContextRevision)
  const isCurrent = useCallback(
    () => accountValid(address.deviceId),
    [accountValid, address.deviceId]
  )
  const callbacks = useRef({ onSendPrompt })
  useEffect(() => {
    callbacks.current = { onSendPrompt }
  }, [onSendPrompt])
  const api = useMemo(
    () => createWidgetApi(boundAddress, threadId, request),
    [boundAddress, threadId, request]
  )
  const mcpApps = useMemo(
    () => createMcpAppApi(boundAddress, threadId, request),
    [boundAddress, threadId, request]
  )
  const addReference = useCallback(
    (widget: WidgetRef) => {
      validateWidgetReference(widget, threadId)
      setReferences(previous => {
        if (
          previous.some(
            item =>
              item.widgetId === widget.widgetId &&
              item.revision === widget.revision &&
              item.sha256 === widget.sha256
          )
        )
          return previous
        return [
          ...previous.filter(
            item => item.widgetId !== widget.widgetId || item.revision !== widget.revision
          ),
          widget,
        ].slice(-512)
      })
    },
    [threadId]
  )
  useEffect(
    () =>
      subscribeCommittedWidgets(event => {
        if (
          !invalidated &&
          event.deviceId === address.deviceId &&
          event.taskId === address.taskId &&
          event.widget.threadId === threadId
        )
          addReference(event.widget)
      }),
    [address.deviceId, address.taskId, addReference, invalidated, threadId]
  )
  useEffect(
    () =>
      listenAccountContextChanges(targetId => {
        if (targetId === address.deviceId) {
          setInvalidated(true)
          setReferences([])
          setPreviews([])
          clearWidgetPreviews(targetId)
          clearWidgetUiStateForTarget(targetId)
        }
      }),
    [address.deviceId]
  )
  useEffect(
    () =>
      subscribeWidgetPreviews((deviceId, taskId, previews) => {
        if (deviceId === address.deviceId && (!taskId || taskId === address.taskId))
          setPreviews(previews.filter(item => item.threadId === threadId))
      }),
    [address.deviceId, address.taskId, threadId]
  )
  const containsWidgets =
    address.runtimeHandle?.studioWorkMode === 'kworker' ||
    messages.some(
      message =>
        message.content.includes('::kcoder-widget') ||
        message.blocks?.some(block => block.type === 'tool' && block.toolName === 'show_widget')
    )
  useEffect(() => {
    if (!containsWidgets || invalidated) return
    const controller = new AbortController()
    api
      .list(controller.signal)
      .then(widgets => {
        if (!controller.signal.aborted) {
          widgets.forEach(addReference)
          setListingStatus('loaded')
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setListingStatus('failed')
      })
    return () => controller.abort()
  }, [addReference, api, containsWidgets, invalidated, reloadGeneration])
  const sendPrompt = useCallback(
    (text: string) => {
      if (!invalidated && isCurrent()) callbacks.current.onSendPrompt(text)
    },
    [invalidated, isCurrent]
  )
  const value = useMemo(
    () => ({
      key: scopeKey,
      hostPanelId: `widget-panel:${mountIdentity}`,
      threadId,
      references,
      previews,
      api,
      mcpApps,
      claimProbe,
      invalidated,
      listingStatus,
      reload,
      isCurrent,
      addReference,
      sendPrompt,
    }),
    [
      scopeKey,
      mountIdentity,
      threadId,
      references,
      previews,
      api,
      mcpApps,
      claimProbe,
      invalidated,
      listingStatus,
      reload,
      isCurrent,
      addReference,
      sendPrompt,
    ]
  )
  return (
    <ConversationWidgetsContext.Provider value={value}>
      {children}
    </ConversationWidgetsContext.Provider>
  )
}
