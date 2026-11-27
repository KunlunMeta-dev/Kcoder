import { canCancelInput, canSubmitInput, isTerminalInput } from '@/features/workbench/inputDelivery'
import { getRuntimeConversationQueuedMessagesByKey, runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import type { CodeCommentContext } from '@/types/workspace-files'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { type RuntimePaneSendOptions } from './sessionTypes'
import type { usePaneComposer } from './usePaneComposer'

export function usePaneQueueControls(context: ReturnType<typeof usePaneComposer>) {
  const {
    currentRuntimeTask,
    queuedMessageSendInFlightIdsRef,
    refreshQueuedDelivery,
    pendingAppliedGuidancesRef,
    currentRuntimeTaskRef,
    accountScopeInvalidatedRef,
    projectChat,
    queuedMessages,
    setQueuedMessages,
    setQueuedMessagesPaused,
    setCodeCommentContexts,
    input,
    scopedSetInput,
    setInput,
    interruptAndSendQueuedMessage,
    sendQueuedMessageAsGuidance,
    send,
  } = context
  const commentOwner = useMemo(() => ({
    deviceId: currentRuntimeTask?.deviceId,
    taskId: currentRuntimeTask?.taskId,
    accountCurrent: captureAccountContextRevision(),
  }), [currentRuntimeTask?.deviceId, currentRuntimeTask?.taskId])
  const addCodeComment = useCallback(
    (context: CodeCommentContext) => {
      if (accountScopeInvalidatedRef.current ||
          commentOwner.deviceId !== currentRuntimeTaskRef.current?.deviceId ||
          commentOwner.taskId !== currentRuntimeTaskRef.current?.taskId ||
          (commentOwner.deviceId && !commentOwner.accountCurrent(commentOwner.deviceId))) return
      setCodeCommentContexts(current => [
        ...current.filter(item => item.id !== context.id),
        context,
      ])
    },
    [commentOwner, accountScopeInvalidatedRef, currentRuntimeTaskRef, setCodeCommentContexts]
  )

  const clearCodeComments = useCallback(() => {
    setCodeCommentContexts([])
  }, [setCodeCommentContexts])

  const inputRef = useRef(input)
  useLayoutEffect(() => { inputRef.current = input }, [input])
  const restoreCancelledInput = useCallback((message: RuntimePaneQueuedMessage) => {
    if (accountScopeInvalidatedRef.current || !currentRuntimeTask ||
        currentRuntimeTaskRef.current?.taskId !== currentRuntimeTask.taskId ||
        currentRuntimeTaskRef.current?.deviceId !== currentRuntimeTask.deviceId ||
        !commentOwner.accountCurrent(currentRuntimeTask.deviceId)) return
    const restored = [message.displayContent ?? message.content, inputRef.current].filter(Boolean).join('\n\n')
    inputRef.current = restored
    setInput(restored)
    message.attachments?.forEach(projectChat.addExistingAttachment)
    if (message.codeComments) setCodeCommentContexts(current => [...current, ...message.codeComments!.filter(item => !current.some(existing => existing.id === item.id))])
  }, [accountScopeInvalidatedRef, commentOwner, currentRuntimeTask, currentRuntimeTaskRef, projectChat, setCodeCommentContexts, setInput])

  const currentQueuedMessage = useCallback((id: string) => {
    if (!currentRuntimeTask || accountScopeInvalidatedRef.current ||
        currentRuntimeTaskRef.current?.taskId !== currentRuntimeTask.taskId ||
        currentRuntimeTaskRef.current?.deviceId !== currentRuntimeTask.deviceId ||
        !commentOwner.accountCurrent(currentRuntimeTask.deviceId)) return undefined
    return getRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(currentRuntimeTask)).find(row => row.id === id)
  }, [currentRuntimeTask, currentRuntimeTaskRef, accountScopeInvalidatedRef, commentOwner])

  const cancelQueuedMessage = useCallback((id: string, action: 'cancel' | 'dismiss' = 'cancel') => {
    if (!currentRuntimeTask || accountScopeInvalidatedRef.current || !commentOwner.accountCurrent(currentRuntimeTask.deviceId)) return
    const message = currentQueuedMessage(id)
    if (!message || message.cancelRequested || !canCancelInput(message)) return
    if (isTerminalInput(message.status)) {
      if (action !== 'dismiss') return
      setQueuedMessages(rows => rows.filter(row => row.id !== id))
      return
    }
    if (canSubmitInput(message) && !queuedMessageSendInFlightIdsRef.current.has(id)) {
      setQueuedMessages(rows => rows.filter(row => row.id !== id))
      restoreCancelledInput(message)
      return
    }
    setQueuedMessages(rows => rows.map(row => row.id === id ? { ...row, cancelRequested: true } : row))
    void refreshQueuedDelivery(id)
  }, [currentRuntimeTask, accountScopeInvalidatedRef, commentOwner, currentQueuedMessage, queuedMessageSendInFlightIdsRef, restoreCancelledInput, refreshQueuedDelivery, setQueuedMessages])

  useEffect(() => {
    if (!currentRuntimeTask || currentRuntimeTaskRef.current?.taskId !== currentRuntimeTask.taskId || currentRuntimeTaskRef.current?.deviceId !== currentRuntimeTask.deviceId || !commentOwner.accountCurrent(currentRuntimeTask.deviceId)) return
    const cancelled = (queuedMessages ?? []).filter(row => currentRuntimeTask && row.ownerKey === runtimeConversationKey(currentRuntimeTask) && (row.status === 'interrupted' || row.status === 'failed') && row.cancelRequested)
    if (!cancelled.length || accountScopeInvalidatedRef.current) return
    setQueuedMessages(rows => rows.filter(row => !cancelled.some(item => item.id === row.id)))
    for (const row of cancelled) restoreCancelledInput(row)
  }, [queuedMessages, currentRuntimeTask, currentRuntimeTaskRef, commentOwner, accountScopeInvalidatedRef, restoreCancelledInput, setQueuedMessages])

  const resumeQueuedMessages = useCallback(() => {
    // The dispatcher alone decides when the next entry may run.
    setQueuedMessagesPaused(false)
  }, [setQueuedMessagesPaused])

  const resumeQueuedMessagesWithInput = useCallback(
    async (inputOverride?: string, options?: RuntimePaneSendOptions) => {
      await send(inputOverride, options)
      setQueuedMessagesPaused(false)
    },
    [send, setQueuedMessagesPaused]
  )

  const clearQueuedMessages = useCallback(() => {
    setQueuedMessages(rows => rows.filter(row => !canSubmitInput(row) && !isTerminalInput(row.status)))
    setQueuedMessagesPaused(false)
  }, [setQueuedMessages, setQueuedMessagesPaused])

  const reorderQueuedMessages = useCallback(
    (sourceId: string, targetId: string) => {
      setQueuedMessages(messages => {
        const sourceIndex = messages.findIndex(message => message.id === sourceId)
        const targetIndex = messages.findIndex(message => message.id === targetId)
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return messages

        const source = messages[sourceIndex]
        const target = messages[targetIndex]
        if (source.status !== 'queued' || target.status !== 'queued') return messages

        const reordered = [...messages]
        reordered.splice(sourceIndex, 1)
        const insertIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
        reordered.splice(insertIndex, 0, source)
        return reordered
      })
    },
    [setQueuedMessages]
  )

  const editQueuedMessage = useCallback(
    (id: string) => {
      const queuedMessage = currentQueuedMessage(id)
      if (!queuedMessage || !canSubmitInput(queuedMessage)) return

      setInput(queuedMessage.content)
      queuedMessage.attachments?.forEach(attachment => {
        projectChat.addExistingAttachment(attachment)
      })
      setQueuedMessages(messages => messages.filter(message => message.id !== id))
    },
    [projectChat, currentQueuedMessage, setInput, setQueuedMessages]
  )

  const sendQueuedAsGuidance = useCallback(
    async (id: string) => {
      const queuedMessage = currentQueuedMessage(id)
      if (!queuedMessage || !canSubmitInput(queuedMessage)) return
      await sendQueuedMessageAsGuidance(queuedMessage)
    },
    [currentQueuedMessage, sendQueuedMessageAsGuidance]
  )

  const interruptAndSendQueued = useCallback(
    async (id: string) => {
      const queuedMessage = currentQueuedMessage(id)
      if (!queuedMessage || (!canSubmitInput(queuedMessage) && !pendingAppliedGuidancesRef.current.has(id))) return
      const submittedInput = input.trim()
      const currentAttachments = projectChat.attachments
      const combinedMessage: RuntimePaneQueuedMessage = {
        ...queuedMessage,
        content: [queuedMessage.content, submittedInput].filter(Boolean).join('\n\n'),
        displayContent: [queuedMessage.displayContent ?? queuedMessage.content, submittedInput]
          .filter(Boolean)
          .join('\n\n'),
        attachments: [...(queuedMessage.attachments ?? []), ...currentAttachments],
        notice: undefined,
      }
      setInput('')
      projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
      const sent = await interruptAndSendQueuedMessage(combinedMessage)
      if (sent) return
      const observed = currentRuntimeTask && getRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(currentRuntimeTask)).find(row => row.id === id)
      if (!observed || observed.status !== 'failed') return
      scopedSetInput(combinedMessage.displayContent ?? combinedMessage.content)
      combinedMessage.attachments?.forEach(projectChat.addExistingAttachment)
      if (combinedMessage.codeComments && combinedMessage.codeComments.length > 0) {
        setCodeCommentContexts(combinedMessage.codeComments)
      }
    },
    [
      currentQueuedMessage,
      currentRuntimeTask,
      pendingAppliedGuidancesRef,
      input,
      interruptAndSendQueuedMessage,
      projectChat,
      scopedSetInput,
      setCodeCommentContexts,
      setInput,
    ]
  )
  return {
    ...context,
    addCodeComment,
    clearCodeComments,
    cancelQueuedMessage,
    resumeQueuedMessages,
    resumeQueuedMessagesWithInput,
    clearQueuedMessages,
    reorderQueuedMessages,
    editQueuedMessage,
    sendQueuedAsGuidance,
    interruptAndSendQueued,
  }
}
