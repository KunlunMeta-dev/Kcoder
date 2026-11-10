import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import type { CodeCommentContext } from '@/types/workspace-files'
import { useCallback, useMemo } from 'react'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { isInterruptedGuidance } from './sessionIdentity'
import { type RuntimePaneSendOptions } from './sessionTypes'
import type { usePaneComposer } from './usePaneComposer'

export function usePaneQueueControls(context: ReturnType<typeof usePaneComposer>) {
  const {
    currentRuntimeTask,
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
    sendQueuedMessage,
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

  const cancelQueuedMessage = useCallback(
    (id: string) => {
      setQueuedMessages(messages => messages.filter(message => message.id !== id))
    },
    [setQueuedMessages]
  )

  const resumeQueuedMessages = useCallback(() => {
    setQueuedMessagesPaused(false)
    const interruptedGuidance = queuedMessages.find(isInterruptedGuidance)
    const queuedMessage =
      interruptedGuidance ?? queuedMessages.find(message => message.status === 'queued')
    if (queuedMessage) void sendQueuedMessage(queuedMessage)
  }, [queuedMessages, sendQueuedMessage, setQueuedMessagesPaused])

  const resumeQueuedMessagesWithInput = useCallback(
    async (inputOverride?: string, options?: RuntimePaneSendOptions) => {
      const interruptedGuidance = queuedMessages.find(isInterruptedGuidance)
      if (!interruptedGuidance) {
        await send(inputOverride, options)
        setQueuedMessagesPaused(false)
        return
      }

      const submittedInput = (inputOverride ?? input).trim()
      const combinedMessage = {
        ...interruptedGuidance,
        content: [interruptedGuidance.content, submittedInput].filter(Boolean).join('\n\n'),
        notice: undefined,
      }
      setQueuedMessagesPaused(false)
      await sendQueuedMessage(combinedMessage)
    },
    [input, queuedMessages, send, sendQueuedMessage, setQueuedMessagesPaused]
  )

  const clearQueuedMessages = useCallback(() => {
    setQueuedMessages([])
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
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.status === 'sending') return

      setInput(queuedMessage.content)
      queuedMessage.attachments?.forEach(attachment => {
        projectChat.addExistingAttachment(attachment)
      })
      setQueuedMessages(messages => messages.filter(message => message.id !== id))
    },
    [projectChat, queuedMessages, setInput, setQueuedMessages]
  )

  const sendQueuedAsGuidance = useCallback(
    async (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage) return
      await sendQueuedMessageAsGuidance(queuedMessage)
    },
    [queuedMessages, sendQueuedMessageAsGuidance]
  )

  const interruptAndSendQueued = useCallback(
    async (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage) return
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
      scopedSetInput(combinedMessage.displayContent ?? combinedMessage.content)
      combinedMessage.attachments?.forEach(projectChat.addExistingAttachment)
      if (combinedMessage.codeComments && combinedMessage.codeComments.length > 0) {
        setCodeCommentContexts(combinedMessage.codeComments)
      }
    },
    [
      input,
      interruptAndSendQueuedMessage,
      projectChat,
      queuedMessages,
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
