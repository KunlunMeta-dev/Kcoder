import { isPendingInput, isTerminalInput } from '@/features/workbench/inputDelivery'
import i18n from '@/i18n'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import {
  markRuntimeTerminalAdditionalContextDelivered,
  readRuntimeTerminalAdditionalContext,
} from '@/lib/runtime-terminal-context'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import type { usePaneInteractions } from './usePaneInteractions'

export function usePaneQueueDispatch(context: ReturnType<typeof usePaneInteractions>) {
  const {
    currentRuntimeTask,
    refreshQueuedDelivery,
    sendRuntimePaneGuidance,
    queuedMessages,
    queuedMessagesPaused,
    setQueuedMessages,
    setError,
    loadRuntimeTranscriptForPaneRef,
    pendingAppliedGuidancesRef,
    interruptedGuidanceIdsRef,
    queuedMessageSendInFlightIdsRef,
    runtimeTaskLoadTarget,
    messagesRef,
    paneStatus,
    sendRuntimeMessage,
  } = context
  const sendQueuedMessage = useCallback(
    async (queuedMessage: RuntimePaneQueuedMessage) => {
      if (queuedMessageSendInFlightIdsRef.current.has(queuedMessage.id)) return
      queuedMessageSendInFlightIdsRef.current.add(queuedMessage.id)

      try {
        await sendRuntimeMessage(queuedMessage)
      } catch {
        setQueuedMessages(rows => rows.map(row => row.id === queuedMessage.id ? { ...row, status: 'unknown' } : row))
      } finally {
        queuedMessageSendInFlightIdsRef.current.delete(queuedMessage.id)
      }
    },
    [queuedMessageSendInFlightIdsRef, sendRuntimeMessage, setQueuedMessages]
  )

  useEffect(() => {
    if (queuedMessagesPaused) return
    if (!paneStatus.canSendQueuedMessage) return
    if (queuedMessages.some(message => !['queued', 'failed'].includes(message.status) && !isTerminalInput(message.status))) return
    const queuedMessage = queuedMessages.find(message => message.status === 'queued')
    if (!queuedMessage) return

    // This advances the next queued message once the pane becomes idle.
    void sendQueuedMessage(queuedMessage)
  }, [paneStatus.canSendQueuedMessage, queuedMessages, queuedMessagesPaused, sendQueuedMessage])

  const cancellationsInFlight = useRef(new Set<string>())
  const observedRows = useRef(queuedMessages)
  useLayoutEffect(() => { observedRows.current = queuedMessages }, [queuedMessages])
  const deviceId = currentRuntimeTask?.deviceId
  const taskId = currentRuntimeTask?.taskId
  const hasObservedRows = queuedMessages.some(row => !['queued', 'failed'].includes(row.status) && !isTerminalInput(row.status))
  const pendingObservationKey = queuedMessages.filter(row => !['queued', 'failed'].includes(row.status) &&
    isPendingInput(row))
    .map(row => `${row.id}:${row.status}:${row.cancelRequested === true}`).join('|')
  const refresh = useCallback((mode: Parameters<typeof refreshQueuedDelivery>[1] = 'observe') => {
    for (const row of observedRows.current) {
      if (['queued', 'failed'].includes(row.status) || isTerminalInput(row.status) ||
          (mode === 'pending' && !isPendingInput(row)) ||
          queuedMessageSendInFlightIdsRef.current.has(row.id) || cancellationsInFlight.current.has(row.id) ||
          (row.status === 'sending' && pendingAppliedGuidancesRef.current.has(row.id))) continue
      if (row.cancelRequested) cancellationsInFlight.current.add(row.id)
      void refreshQueuedDelivery(row.id, mode).finally(() => {
        if (row.cancelRequested) cancellationsInFlight.current.delete(row.id)
      })
    }
  }, [pendingAppliedGuidancesRef, queuedMessageSendInFlightIdsRef, refreshQueuedDelivery])
  useEffect(() => {
    if (!hasObservedRows) return
    refresh()
    const refreshReceipt = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId?: string; deviceId?: string }>).detail
      if (taskId && deviceId && detail?.taskId === taskId && detail.deviceId === deviceId) refresh('reconcile')
    }
    window.addEventListener('kcoder:turn-receipt-reconciled', refreshReceipt)
    return () => {
      window.removeEventListener('kcoder:turn-receipt-reconciled', refreshReceipt)
    }
  }, [deviceId, taskId, hasObservedRows, paneStatus.isBusy, refresh])
  useEffect(() => {
    if (!pendingObservationKey) return
    refresh('pending')
    const needsPolling = observedRows.current.some(row => row.status === 'unknown' || row.status === 'accepted' || row.cancelRequested)
    const interval = needsPolling ? window.setInterval(() => refresh('pending'), 15_000) : undefined
    return () => window.clearInterval(interval)
  }, [pendingObservationKey, refresh])

  const loadFullTranscriptForExport = useCallback(async () => {
    if (!runtimeTaskLoadTarget) return messagesRef.current

    const transcript = await loadRuntimeTranscriptForPaneRef.current(
      runtimeTaskLoadTarget.address,
      {
        includeFullContent: true,
        refresh: true,
      }
    )
    if (transcript.fullContent !== true) {
      throw new Error('The complete task transcript is unavailable')
    }
    return transcript.messages.length > 0 ? transcript.messages : messagesRef.current
  }, [loadRuntimeTranscriptForPaneRef, messagesRef, runtimeTaskLoadTarget])

  const sendQueuedMessageAsGuidance = useCallback(
    async (queuedMessage: RuntimePaneQueuedMessage) => {
      if (queuedMessage.turnMode && queuedMessage.turnMode !== 'standard' && paneStatus.isBusy) {
        setError(i18n.t('workbench.execution_mode_queue_only'))
        return
      }
      const id = queuedMessage.id
      if (!currentRuntimeTask) {
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id && !isTerminalInput(message.status)
              ? { ...message, status: 'failed', error: '当前回复缺少引导上下文' }
              : message
          )
        )
        return
      }

      if (queuedMessage.status === 'sending') return

      setError(null)
      if (!paneStatus.isBusy) {
        try {
          const sent = await sendRuntimeMessage(queuedMessage)
          setQueuedMessages(messages =>
            sent
              ? messages
              : messages.map(message =>
                  message.id === id
                    ? (message.status === 'sending' ? { ...message, status: 'unknown', notice: undefined } : message)
                    : message
                )
          )
        } catch (error) {
          console.error('[KCoder Studio] Queued runtime message send failed', {
            id,
            error,
          })
          setQueuedMessages(messages =>
            messages.map(message =>
              message.id === id
                ? (message.status === 'sending' ? { ...message, status: 'unknown', notice: undefined } : message)
                : message
            )
          )
        }
        return
      }

      setQueuedMessages(messages =>
        messages.map(message =>
          message.id === id
            ? {
                ...message,
                status: 'sending',
                deliveryMode: 'guidance',
                error: undefined,
                notice: '正在引导当前对话',
              }
            : message
        )
      )

      pendingAppliedGuidancesRef.current.set(id, queuedMessage)

      try {
        const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
        const messageAttachments = queuedMessage.attachments ?? []
        const attachmentIds = remoteAttachmentIds(messageAttachments)
        const attachments = localRuntimeAttachments(messageAttachments)
        const result = await sendRuntimePaneGuidance({
          address: currentRuntimeTask,
          message: queuedMessage.content,
          clientGuidanceId: id,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(additionalContext ? { additionalContext } : {}),
        }, { onError: setError })
        if (!pendingAppliedGuidancesRef.current.has(id)) return
        if (!result.sent && result.code === 'no_active_turn') {
          pendingAppliedGuidancesRef.current.delete(id)
          if (interruptedGuidanceIdsRef.current.delete(id)) return
          setQueuedMessages(rows => rows.map(row => row.id === id && !isTerminalInput(row.status) ? { ...row, status: 'queued', notice: undefined } : row))
          const sent = await sendRuntimeMessage(queuedMessage)
          setQueuedMessages(messages =>
            sent
              ? messages
              : messages.map(message =>
                  message.id === id
                    ? (message.status === 'sending' ? { ...message, status: 'unknown', notice: undefined } : message)
                    : message
                )
          )
          return
        }
        if (result.sent) {
          markRuntimeTerminalAdditionalContextDelivered(additionalContext)
          setQueuedMessages(rows => rows.map(row => row.id === id && !isTerminalInput(row.status)
            ? { ...row, status: 'accepted', turnId: undefined, notice: undefined } : row))
        }
        if (!result.sent) {
          if (result.rejected === true) pendingAppliedGuidancesRef.current.delete(id)
          if (interruptedGuidanceIdsRef.current.delete(id)) {
            setQueuedMessages(messages => messages.filter(message => message.id !== id || message.notice !== '正在引导当前对话'))
            return
          }
          setQueuedMessages(messages =>
            messages.map(message =>
              message.id === id && !isTerminalInput(message.status)
                ? { ...message, status: result.rejected === true ? 'failed' : 'unknown', notice: result.rejected === true ? undefined : message.notice, error: result.rejected ? '引导发送失败' : undefined }
                : message
            )
          )
        }
      } catch (error) {
        if (!pendingAppliedGuidancesRef.current.has(id)) return
        if (interruptedGuidanceIdsRef.current.delete(id)) {
          setQueuedMessages(messages => messages.filter(message => message.id !== id || message.notice !== '正在引导当前对话'))
          return
        }
        console.error('[KCoder Studio] Queued guidance send failed', {
          id,
          error,
        })
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id && !isTerminalInput(message.status)
              ? { ...message, status: 'unknown', error: undefined }
              : message
          )
        )
      }
    },
    [
      currentRuntimeTask,
      interruptedGuidanceIdsRef,
      paneStatus.isBusy,
      pendingAppliedGuidancesRef,
      sendRuntimeMessage,
      sendRuntimePaneGuidance,
      setError,
      setQueuedMessages,
    ]
  )
  return { ...context, sendQueuedMessage, loadFullTranscriptForExport, sendQueuedMessageAsGuidance }
}
