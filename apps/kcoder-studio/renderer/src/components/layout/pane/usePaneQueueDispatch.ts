import i18n from '@/i18n'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import {
  markRuntimeTerminalAdditionalContextDelivered,
  readRuntimeTerminalAdditionalContext,
} from '@/lib/runtime-terminal-context'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import { useCallback, useEffect } from 'react'

import type { usePaneInteractions } from './usePaneInteractions'

export function usePaneQueueDispatch(context: ReturnType<typeof usePaneInteractions>) {
  const {
    currentRuntimeTask,
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
      setQueuedMessages(messages =>
        messages.map(message =>
          message.id === queuedMessage.id ? { ...message, status: 'sending' } : message
        )
      )

      try {
        const sent = await sendRuntimeMessage(queuedMessage)
        setQueuedMessages(messages =>
          sent
            ? messages.filter(message => message.id !== queuedMessage.id)
            : messages.map(message =>
                message.id === queuedMessage.id
                  ? { ...message, status: 'failed', error: '发送失败' }
                  : message
              )
        )
      } catch (error) {
        console.error('[KCoder Studio] Queued runtime message send failed', {
          id: queuedMessage.id,
          error,
        })
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === queuedMessage.id
              ? { ...message, status: 'failed', error: '发送失败' }
              : message
          )
        )
      } finally {
        queuedMessageSendInFlightIdsRef.current.delete(queuedMessage.id)
      }
    },
    [queuedMessageSendInFlightIdsRef, sendRuntimeMessage, setQueuedMessages]
  )

  useEffect(() => {
    if (queuedMessagesPaused) return
    if (!paneStatus.canSendQueuedMessage) return
    if (queuedMessages.some(message => message.status === 'sending')) return
    const queuedMessage = queuedMessages.find(message => message.status === 'queued')
    if (!queuedMessage) return

    // This advances the next queued message once the pane becomes idle.
    void sendQueuedMessage(queuedMessage)
  }, [paneStatus.canSendQueuedMessage, queuedMessages, queuedMessagesPaused, sendQueuedMessage])

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
            message.id === id
              ? { ...message, status: 'failed', error: '当前回复缺少引导上下文' }
              : message
          )
        )
        return
      }

      if (queuedMessage.status === 'sending') return

      setError(null)
      if (!paneStatus.isBusy) {
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? { ...message, status: 'sending', error: undefined, notice: undefined }
              : message
          )
        )
        try {
          const sent = await sendRuntimeMessage(queuedMessage)
          setQueuedMessages(messages =>
            sent
              ? messages.filter(message => message.id !== id)
              : messages.map(message =>
                  message.id === id
                    ? { ...message, status: 'failed', notice: undefined, error: '发送失败' }
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
                ? { ...message, status: 'failed', notice: undefined, error: '发送失败' }
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
        })
        if (!result.sent && result.code === 'no_active_turn') {
          pendingAppliedGuidancesRef.current.delete(id)
          if (interruptedGuidanceIdsRef.current.delete(id)) return
          const sent = await sendRuntimeMessage(queuedMessage)
          setQueuedMessages(messages =>
            sent
              ? messages.filter(message => message.id !== id)
              : messages.map(message =>
                  message.id === id
                    ? { ...message, status: 'failed', notice: undefined, error: '发送失败' }
                    : message
                )
          )
          return
        }
        if (result.sent) {
          markRuntimeTerminalAdditionalContextDelivered(additionalContext)
        }
        if (!result.sent) {
          pendingAppliedGuidancesRef.current.delete(id)
          if (interruptedGuidanceIdsRef.current.delete(id)) {
            setQueuedMessages(messages => messages.filter(message => message.id !== id))
            return
          }
          setQueuedMessages(messages =>
            messages.map(message =>
              message.id === id
                ? { ...message, status: 'failed', notice: undefined, error: '引导发送失败' }
                : message
            )
          )
        }
      } catch (error) {
        pendingAppliedGuidancesRef.current.delete(id)
        if (interruptedGuidanceIdsRef.current.delete(id)) {
          setQueuedMessages(messages => messages.filter(message => message.id !== id))
          return
        }
        console.error('[KCoder Studio] Queued guidance send failed', {
          id,
          error,
        })
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? { ...message, status: 'failed', notice: undefined, error: '引导发送失败' }
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
