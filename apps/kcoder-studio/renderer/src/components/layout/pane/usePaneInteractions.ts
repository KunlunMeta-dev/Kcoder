import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import {
  requestUserInputRelatedKeysForPayloads,
} from '@/components/chat/requestUserInputMessages'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import {
  markRuntimeTerminalAdditionalContextDelivered,
  readRuntimeTerminalAdditionalContext,
} from '@/lib/runtime-terminal-context'
import type { RequestUserInputResponse, RuntimeRollbackRequest } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { runtimeAddressDebug } from './paneDiagnostics'
import {
  createLocalUserMessage,
  isEditableLastUserMessage,
  requestUserInputResponseText,
} from './paneMessageReducer'
import { type SendRequestUserInputResponseOptions } from './sessionTypes'
import type { usePaneSend } from './usePaneSend'

export function usePaneInteractions(context: ReturnType<typeof usePaneSend>) {
  const {
    currentRuntimeTask,
    projectChat,
    sendRuntimePaneMessage,
    editLastUserMessage,
    cancelRuntimePaneTask,
    setError,
    requestUserInputAliasTrackerRef,
    updateAnsweredRequestUserInputIds,
    messagesRef,
    dispatchMessages,
    paneStatus,
    getRuntimeModelFields,
    applyLocalRequestUserInputResponse,
  } = context
  const questionOwnerKey = JSON.stringify(currentRuntimeTask)
  const questionVisit = useMemo(() => ({ key: questionOwnerKey }), [questionOwnerKey])
  const questionOwner = useRef<object | null>(null)
  const pendingQuestionIgnore = useRef<object | null>(null)
  useLayoutEffect(() => {
    questionOwner.current = questionVisit
    return () => { questionOwner.current = null }
  }, [questionVisit])
  const sendRequestUserInputResponse = useCallback(
    async (
      responseValue: RequestUserInputResponse,
      options: SendRequestUserInputResponseOptions = {}
    ): Promise<boolean> => {
      if (!currentRuntimeTask || questionOwner.current !== questionVisit) return false

      // Keep the dispatched identity and answer fixed through the receipt wait.
      const response: RequestUserInputResponse = JSON.parse(JSON.stringify(responseValue))
      const message = requestUserInputResponseText(response)
      const runtimeModelOverride = options.forceDefaultCollaborationMode
        ? { collaborationMode: 'default' }
        : undefined
      if (options.forceDefaultCollaborationMode) {
        projectChat.setSelectedModelOption('collaborationMode', 'default')
      }
      const appendedUserMessage = options.appendUserMessage ? createLocalUserMessage(message) : null
      if (appendedUserMessage) {
        dispatchMessages({ type: 'user_added', message: appendedUserMessage })
      }
      const runtimeModelFields = options.appendUserMessage
        ? getRuntimeModelFields(runtimeModelOverride)
        : {}
      const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const sent = await sendRuntimePaneMessage({
        address: currentRuntimeTask,
        message,
        ...(appendedUserMessage ? { clientMessageId: appendedUserMessage.id } : {}),
        ...runtimeModelFields,
        ...(options.appendUserMessage ? {} : { requestUserInputResponse: response }),
        ...(additionalContext ? { additionalContext } : {}),
      })
      if (sent) {
        markRuntimeTerminalAdditionalContextDelivered(additionalContext)
      }
      // Only confirmed sends settle the local card. A receipt also belongs to
      // this exact task visit, including when the user leaves and returns.
      if (sent && questionOwner.current === questionVisit) {
        // Recovery can discover another projection of this question while the
        // send is pending. Reconcile it against the original accepted identity.
        const requestUserInputKeys = requestUserInputRelatedKeysForPayloads(
          requestUserInputAliasTrackerRef.current.previousPayloads,
          response,
          requestUserInputAliasTrackerRef.current.aliasesByKey
        )
        if (requestUserInputKeys.length > 0) {
          updateAnsweredRequestUserInputIds(current => {
            if (requestUserInputKeys.every(key => current.has(key))) return current
            const next = new Set(current)
            for (const key of requestUserInputKeys) next.add(key)
            return next
          })
        }
        applyLocalRequestUserInputResponse(response)
      }
      return sent
    },
    [
      applyLocalRequestUserInputResponse,
      currentRuntimeTask,
      dispatchMessages,
      getRuntimeModelFields,
      projectChat,
      requestUserInputAliasTrackerRef,
      questionVisit,
      sendRuntimePaneMessage,
      updateAnsweredRequestUserInputIds,
    ]
  )

  const editLastUserMessageInPane = useCallback(
    async (message: WorkbenchMessage, content: string): Promise<boolean> => {
      const submittedContent = content.trim()
      if (!submittedContent) return false
      if (!currentRuntimeTask) return false
      if (paneStatus.isBusy) {
        setError('当前回复仍在进行中，完成后再编辑')
        return false
      }

      const currentMessages = messagesRef.current
      const messageIndex = currentMessages.findIndex(item => item.id === message.id)
      if (!isEditableLastUserMessage(currentMessages, messageIndex)) {
        setError('只能编辑最后一轮已完成的问题')
        return false
      }

      const previousMessages = currentMessages
      const messageAttachments = message.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
      const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const editedMessage = createLocalUserMessage(submittedContent, messageAttachments, {
        runtimeGoalRequest: message.runtimeGoalRequest === true,
      })
      const nextMessages = [...currentMessages.slice(0, messageIndex), editedMessage]
      const request: RuntimeRollbackRequest = {
        address: currentRuntimeTask,
        message: submittedContent,
        messageId: message.id,
        ...getRuntimeModelFields(),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(additionalContext ? { additionalContext } : {}),
      }

      dispatchMessages({ type: 'reset', messages: nextMessages })
      try {
        const sent = await editLastUserMessage(request)
        if (sent) {
          markRuntimeTerminalAdditionalContextDelivered(additionalContext)
          return true
        }
        dispatchMessages({ type: 'reset', messages: previousMessages })
        return false
      } catch (error) {
        dispatchMessages({ type: 'reset', messages: previousMessages })
        console.error('[KCoder Studio] Runtime last user message edit failed', {
          address: runtimeAddressDebug(currentRuntimeTask),
          messageId: message.id,
          error,
        })
        setError('编辑失败')
        return false
      }
    },
    [
      currentRuntimeTask,
      dispatchMessages,
      editLastUserMessage,
      getRuntimeModelFields,
      messagesRef,
      paneStatus.isBusy,
      setError,
    ]
  )

  const ignoreRequestUserInput = useCallback(
    async (payload: RequestUserInputPayload) => {
      if (!currentRuntimeTask || questionOwner.current !== questionVisit) return
      if (payload.sourceAgent) {
        return sendRequestUserInputResponse({
          requestId: payload.requestId ?? payload.request_id,
          itemId: payload.itemId ?? payload.item_id,
          sourceAgent: payload.sourceAgent,
          answers: {},
          annotations: { ignored: true },
        })
      }
      const cancellationTargets = messagesRef.current.filter(
        message => message.role === 'assistant' && message.status === 'streaming' &&
          (payload.turnId == null || (message.turnId ?? message.subtaskId) === payload.turnId)
      )
      if (pendingQuestionIgnore.current === questionVisit) return
      pendingQuestionIgnore.current = questionVisit
      try {
        const originalQuestion: RequestUserInputResponse = {
          threadId: payload.threadId,
          turnId: payload.turnId,
          appServerEpoch: payload.appServerEpoch,
          requestId: payload.requestId ?? payload.request_id,
          itemId: payload.itemId ?? payload.item_id,
          answers: {},
        }
        // Keep the question's turn through asynchronous transport preparation.
        // A retained card must never fall through to the task's newer turn.
        const cancelled = await cancelRuntimePaneTask({
          ...currentRuntimeTask,
          ...(payload.threadId == null ? {} : { threadId: payload.threadId }),
          ...(payload.turnId == null ? {} : { expectedTurnId: payload.turnId }),
        })
        // Only this task visit may apply the cancellation receipt. Keep the card
        // available until confirmation, including after rejection or lost receipts.
        if (!cancelled || questionOwner.current !== questionVisit) return
        // A refresh can restore another projection while cancellation waits.
        // Settle its current aliases against the captured original identity.
        const requestUserInputKeys = requestUserInputRelatedKeysForPayloads(
          requestUserInputAliasTrackerRef.current.previousPayloads,
          originalQuestion,
          requestUserInputAliasTrackerRef.current.aliasesByKey
        )
        if (requestUserInputKeys.length > 0) {
          updateAnsweredRequestUserInputIds(current => {
            if (requestUserInputKeys.every(key => current.has(key))) return current
            const next = new Set(current)
            for (const key of requestUserInputKeys) next.add(key)
            return next
          })
        }

        for (const message of cancellationTargets)
          dispatchMessages({
            type: 'assistant_cancelled',
            messageId: message.id,
            subtaskId: message.attemptId ?? message.subtaskId ?? message.turnId,
          })
      } finally {
        if (pendingQuestionIgnore.current === questionVisit) pendingQuestionIgnore.current = null
      }
    },
    [
      cancelRuntimePaneTask,
      currentRuntimeTask,
      dispatchMessages,
      messagesRef,
      questionVisit,
      requestUserInputAliasTrackerRef,
      sendRequestUserInputResponse,
      updateAnsweredRequestUserInputIds,
    ]
  )
  return {
    ...context,
    sendRequestUserInputResponse,
    editLastUserMessageInPane,
    ignoreRequestUserInput,
  }
}
