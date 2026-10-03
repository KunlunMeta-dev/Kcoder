import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import {
  requestUserInputPayloadKey,
  requestUserInputRelatedKeysForPayloads,
} from '@/components/chat/requestUserInputMessages'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import {
  markRuntimeTerminalAdditionalContextDelivered,
  readRuntimeTerminalAdditionalContext,
} from '@/lib/runtime-terminal-context'
import type { RequestUserInputResponse, RuntimeRollbackRequest } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { useCallback } from 'react'
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
  const sendRequestUserInputResponse = useCallback(
    async (
      response: RequestUserInputResponse,
      options: SendRequestUserInputResponseOptions = {}
    ): Promise<boolean> => {
      if (!currentRuntimeTask) return false

      const message = requestUserInputResponseText(response)
      const requestUserInputKeys = requestUserInputRelatedKeysForPayloads(
        requestUserInputAliasTrackerRef.current.previousPayloads,
        response,
        requestUserInputAliasTrackerRef.current.aliasesByKey
      )
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
      if (requestUserInputKeys.length > 0) {
        updateAnsweredRequestUserInputIds(current => {
          if (requestUserInputKeys.every(key => current.has(key))) return current
          const next = new Set(current)
          for (const key of requestUserInputKeys) next.add(key)
          return next
        })
      }
      applyLocalRequestUserInputResponse(response)
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
      } else {
        if (requestUserInputKeys.length > 0) {
          updateAnsweredRequestUserInputIds(current => {
            if (requestUserInputKeys.every(key => !current.has(key))) return current
            const next = new Set(current)
            for (const key of requestUserInputKeys) next.delete(key)
            return next
          })
        }
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
      const cancellationTargets = messagesRef.current.filter(
        message => message.role === 'assistant' && message.status === 'streaming'
      )
      const requestUserInputKey = requestUserInputPayloadKey(payload)
      if (requestUserInputKey) {
        updateAnsweredRequestUserInputIds(current => {
          if (current.has(requestUserInputKey)) return current
          const next = new Set(current)
          next.add(requestUserInputKey)
          return next
        })
      }

      if (!currentRuntimeTask) {
        return
      }

      const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
      if (!cancelled) {
        if (requestUserInputKey) {
          updateAnsweredRequestUserInputIds(current => {
            if (!current.has(requestUserInputKey)) return current
            const next = new Set(current)
            next.delete(requestUserInputKey)
            return next
          })
        }
        return
      }

      for (const message of cancellationTargets)
        dispatchMessages({
          type: 'assistant_cancelled',
          messageId: message.id,
          subtaskId: message.attemptId ?? message.subtaskId ?? message.turnId,
        })
    },
    [
      cancelRuntimePaneTask,
      currentRuntimeTask,
      dispatchMessages,
      messagesRef,
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
