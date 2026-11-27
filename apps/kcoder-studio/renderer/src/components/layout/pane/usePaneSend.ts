import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { requestLocalExecutor } from '@/host/localExecutor'
import { getRuntimeConversationQueuedMessagesByKey, runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import { applyInputDelivery, canSubmitInput, isPendingInput, isTerminalInput } from '@/features/workbench/inputDelivery'
import type { RuntimeInputDelivery } from '@/types/api'
import { textMetrics } from '@/components/chat/composer/composerDebug'
import {
  applyRequestUserInputResponseToMessages,
  requestUserInputResponseKey,
} from '@/components/chat/requestUserInputMessages'
import {
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from '@/features/workbench/runtimeModelSelection'
import i18n from '@/i18n'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import {
  markRuntimeTerminalAdditionalContextDelivered,
  readRuntimeTerminalAdditionalContext,
} from '@/lib/runtime-terminal-context'
import type { Attachment, ModelOptions, RequestUserInputResponse, RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneQueuedMessage, WorkbenchMessage } from '@/types/workbench'
import { useCallback, useRef } from 'react'
import {
  debugRuntimePaneMessageFlow,
  runtimeAddressDebug,
  summarizeWorkbenchMessages,
} from './paneDiagnostics'
import { createLocalUserMessage, type CreateLocalUserMessageOptions } from './paneMessageReducer'
import { type SendRuntimeMessageOptions } from './sessionTypes'
import type { usePaneTranscript } from './usePaneTranscript'
import { useRuntimeTaskReadAddress } from './useRuntimeTaskReadAddress'

export function usePaneSend(context: ReturnType<typeof usePaneTranscript>) {
  const {
    currentRuntimeTask,
    currentRuntimeTaskRef,
    runtimeTaskLoadTarget,
    accountScopeInvalidatedRef,
    queuedMessageSendInFlightIdsRef,
    projectChat,
    sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage,
    retryRuntimeFailedMessage,
    setQueuedMessages,
    setError,
    pendingAppliedGuidancesRef,
    interruptedGuidanceIdsRef,
    interruptAndSendInFlightRef,
    retryInFlightRef,
    lastSubmittedRetryMessageRef,
    retrySourceBySubtaskIdRef,
    setMessages,
    messagesRef,
    dispatchMessages,
  } = context
  const canSendWithSelectedModel = useCallback(() => {
    if (!projectChat.isSelectedModelUnavailable?.()) return true
    setError(i18n.t('workbench.model_disabled_unavailable'))
    return false
  }, [projectChat, setError])

  const getRuntimeModelFields = useCallback(
    (modelOptionsOverride?: ModelOptions) => {
      const selectedModel =
        projectChat.getSelectedModel?.() ??
        projectChat.selectedModel ??
        resolveAutomaticModel(projectChat.models)
      const selectedModelOptions =
        projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
      return selectedModelExecutionFields(
        selectedModel,
        {
          ...selectedModelOptions,
          ...modelOptionsOverride,
        },
        projectChat.getModelSelectionMode?.()
      )
    },
    [projectChat]
  )

  const appendLocalUserMessage = useCallback(
    (content: string, attachments?: Attachment[], options?: CreateLocalUserMessageOptions) => {
      dispatchMessages({
        type: 'user_added',
        message: createLocalUserMessage(content, attachments, options),
      })
    },
    [dispatchMessages]
  )

  const applyLocalRequestUserInputResponse = useCallback(
    (response: RequestUserInputResponse) => {
      setMessages(currentMessages => {
        const nextMessages = applyRequestUserInputResponseToMessages(currentMessages, response)
        if (currentRuntimeTask) {
          debugRuntimePaneMessageFlow('request-user-input-response-applied', () => ({
            address: runtimeAddressDebug(currentRuntimeTask),
            requestUserInputKey: requestUserInputResponseKey(response),
            previousCount: currentMessages.length,
            nextCount: nextMessages.length,
            nextMessages: summarizeWorkbenchMessages(nextMessages),
          }))
        }
        return nextMessages
      })
    },
    [currentRuntimeTask, setMessages]
  )

  const receiptAddress = useRuntimeTaskReadAddress(currentRuntimeTask, runtimeTaskLoadTarget?.address)
  const pendingDeliveryReads = useRef(new Map<string, {
    address: RuntimeTaskAddress
    account: ReturnType<typeof captureAccountContextRevision>
    promise: Promise<void>
  }>())
  const refreshQueuedDelivery = useCallback(async function refreshDelivery(id: string, mode: 'observe' | 'pending' | 'reconcile' = 'observe'): Promise<void> {
    if (!receiptAddress || accountScopeInvalidatedRef.current) return
    const row = getRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(receiptAddress)).find(item => item.id === id)
    if (!row || isTerminalInput(row.status) || row.status === 'queued' || row.status === 'failed' ||
        (mode === 'pending' && !isPendingInput(row))) return
    const account = captureAccountContextRevision()
    const key = JSON.stringify([id, row.turnId, row.deliveryMode])
    const reads = pendingDeliveryReads.current
    const pending = reads.get(key)
    if (!row.cancelRequested && pending?.address === receiptAddress && pending.account(receiptAddress.deviceId)) {
      await pending.promise
      if (mode === 'reconcile' && !accountScopeInvalidatedRef.current && account(receiptAddress.deviceId) &&
          currentRuntimeTaskRef.current?.deviceId === receiptAddress.deviceId &&
          currentRuntimeTaskRef.current.taskId === receiptAddress.taskId) return refreshDelivery(id)
      return
    }
    // A cancellation must not join a read or leave it eligible for later reuse.
    reads.delete(key)
    const promise = (async () => {
      try {
        const delivery = await requestLocalExecutor<RuntimeInputDelivery>('runtime.input.delivery', {
          address: receiptAddress, clientMessageId: id, expectedTurnId: row.turnId, action: row.cancelRequested ? 'cancel' : 'read',
          ...(row.deliveryMode ? { deliveryMode: row.deliveryMode } : {}),
        })
        if (!account(receiptAddress.deviceId) || accountScopeInvalidatedRef.current) return
        const guidanceReceived = row.deliveryMode === 'guidance' &&
          (delivery.status === 'running' || isTerminalInput(delivery.status))
        if (guidanceReceived) pendingAppliedGuidancesRef.current.delete(id)
        setQueuedMessages(rows => applyInputDelivery(rows, id, delivery))
        if (guidanceReceived) window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', {
          detail: { taskId: receiptAddress.taskId, deviceId: receiptAddress.deviceId },
        }))
      } catch {
        // A transport failure is not proof of rejection, absence, or cancellation.
      }
    })()
    if (row.cancelRequested) return promise
    const read = { address: receiptAddress, account, promise }
    reads.set(key, read)
    try {
      await promise
    } finally {
      if (reads.get(key) === read) reads.delete(key)
    }
  }, [receiptAddress, currentRuntimeTaskRef, accountScopeInvalidatedRef, pendingAppliedGuidancesRef, setQueuedMessages])

  const sendRuntimeMessage = useCallback(
    async (
      message: RuntimePaneQueuedMessage,
      options: SendRuntimeMessageOptions = {}
    ): Promise<boolean> => {
      if (!currentRuntimeTask) return false

      if (!canSendWithSelectedModel()) {
        setQueuedMessages(rows => rows.map(row => row.id === message.id ? { ...row, status: 'failed' } : row))
        return false
      }
      const existing = getRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(currentRuntimeTask)).find(row => row.id === message.id)
      if (existing && !canSubmitInput(existing)) return false
      const account = captureAccountContextRevision()
      if (accountScopeInvalidatedRef.current || !account(currentRuntimeTask.deviceId)) return false
      queuedMessageSendInFlightIdsRef.current.add(message.id)
      setQueuedMessages(rows => [...rows.filter(row => row.id !== message.id), {
        ...message,
        deliveryMode: undefined,
        directSubmission: existing ? existing.directSubmission : true,
        ownerKey: runtimeConversationKey(currentRuntimeTask), status: 'sending',
      }])
      let rejected = false
      lastSubmittedRetryMessageRef.current = createLocalUserMessage(
        message.content,
        message.attachments,
        {
          id: message.id,
          createdAt: message.createdAt,
          runtimeGoalRequest: message.runtimeGoalRequest,
          codeComments: message.codeComments,
        }
      )
      if (options.appendLocalMessage !== false) {
        appendLocalUserMessage(message.displayContent ?? message.content, message.attachments, {
          id: message.id,
          createdAt: message.createdAt,
          runtimeGoalRequest: message.runtimeGoalRequest,
          codeComments: message.codeComments,
        })
      }
      const messageAttachments = message.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
      const terminalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const additionalContext = { ...message.additionalContext, ...terminalContext }
      const sent = await sendRuntimePaneMessage({
        ...(options.computerUse ? { computerUse: options.computerUse } : {}),
        ...(message.turnMode ? { turnMode: message.turnMode } : {}),
        address: currentRuntimeTask,
        message: message.content,
        clientMessageId: message.id,
        ...(message.modelId
          ? {
              modelId: message.modelId,
              modelType: message.modelType,
            }
          : {}),
        ...(message.modelSelectionMode ? { modelSelectionMode: message.modelSelectionMode } : {}),
        ...(message.modelOptions ? { modelOptions: message.modelOptions } : {}),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {}),
      }, { onError: setError, onRejected: () => { rejected = true } }).catch(error => {
        setError(error instanceof Error ? error.message : String(error))
        return false
      })
      queuedMessageSendInFlightIdsRef.current.delete(message.id)
      if (accountScopeInvalidatedRef.current || !account(currentRuntimeTask.deviceId)) return false
      setQueuedMessages(rows => rows.map(row => row.id === message.id && !row.turnId && !isTerminalInput(row.status)
        ? { ...row, status: rejected ? 'failed' : sent ? 'accepted' : 'unknown' } : row))
      if (!rejected) await refreshQueuedDelivery(message.id)
      if (sent) {
        markRuntimeTerminalAdditionalContextDelivered(terminalContext)
      }
      return sent
    },
    [
      appendLocalUserMessage,
      accountScopeInvalidatedRef,
      queuedMessageSendInFlightIdsRef,
      refreshQueuedDelivery,
      setQueuedMessages,
      canSendWithSelectedModel,
      currentRuntimeTask,
      lastSubmittedRetryMessageRef,
      sendRuntimePaneMessage,
      setError,
    ]
  )

  const interruptAndSendQueuedMessage = useCallback(
    async (message: RuntimePaneQueuedMessage): Promise<boolean> => {
      if (!currentRuntimeTask) return false
      if (interruptAndSendInFlightRef.current) return false
      const account = captureAccountContextRevision()
      setError(null)
      interruptAndSendInFlightRef.current = true
      const interruptedGuidanceIds = new Set<string>()
      pendingAppliedGuidancesRef.current.forEach((_, id) => {
        interruptedGuidanceIdsRef.current.add(id)
        interruptedGuidanceIds.add(id)
      })
      setQueuedMessages(messages => [
        ...messages.filter(item => item.id !== message.id),
        { ...message, ownerKey: runtimeConversationKey(currentRuntimeTask), status: 'sending', notice: '正在打断并发送' },
      ])
      const messageAttachments = message.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
      const terminalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const additionalContext = { ...message.additionalContext, ...terminalContext }
      appendLocalUserMessage(message.displayContent ?? message.content, message.attachments, {
        id: message.id,
        createdAt: message.createdAt,
        runtimeGoalRequest: message.runtimeGoalRequest,
        codeComments: message.codeComments,
      })
      let rejected = false
      const sent = await interruptAndSendRuntimePaneMessage(
        {
          ...(message.turnMode ? { turnMode: message.turnMode } : {}),
          address: currentRuntimeTask,
          message: message.content,
          clientMessageId: message.id,
          ...(message.modelId ? { modelId: message.modelId, modelType: message.modelType } : {}),
          ...(message.modelOptions ? { modelOptions: message.modelOptions } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {}),
        },
        { onError: setError, onRejected: () => { rejected = true } }
      ).catch(() => false)
      interruptAndSendInFlightRef.current = false
      if (accountScopeInvalidatedRef.current || !account(currentRuntimeTask.deviceId)) return false
      if (!sent) {
        interruptedGuidanceIds.forEach(id => {
          if (id !== message.id) interruptedGuidanceIdsRef.current.delete(id)
        })
        setQueuedMessages(messages =>
          messages
            .map(item => item.id === message.id && !item.turnId && !isTerminalInput(item.status) ? { ...item, status: rejected ? 'failed' as const : 'unknown' as const, notice: undefined } : item)
            .map(item =>
              interruptedGuidanceIds.has(item.id) &&
              item.id !== message.id &&
              !pendingAppliedGuidancesRef.current.has(item.id)
                ? { ...item, status: 'queued', notice: undefined }
                : item
            )
        )
        if (rejected) setMessages(messages => messages.filter(item => item.id !== message.id))
        else await refreshQueuedDelivery(message.id)
        return false
      }

      markRuntimeTerminalAdditionalContextDelivered(terminalContext)
      setQueuedMessages(messages =>
        messages.filter(item => item.id === message.id || !interruptedGuidanceIds.has(item.id)).map(item => item.id === message.id && !item.turnId && !isTerminalInput(item.status) ? { ...item, status: 'accepted', notice: undefined } : item)
      )
      await refreshQueuedDelivery(message.id)
      return true
    },
    [
      accountScopeInvalidatedRef,
      appendLocalUserMessage,
      currentRuntimeTask,
      interruptAndSendInFlightRef,
      interruptAndSendRuntimePaneMessage,
      refreshQueuedDelivery,
      interruptedGuidanceIdsRef,
      pendingAppliedGuidancesRef,
      setError,
      setMessages,
      setQueuedMessages,
    ]
  )

  const retryFailedMessageInPane = useCallback(
    async (
      message: WorkbenchMessage,
      retryModelConfiguration: 'snapshot' | 'current' = 'snapshot'
    ): Promise<boolean> => {
      if (!canSendWithSelectedModel()) return false
      if (retryInFlightRef.current) return false

      retryInFlightRef.current = true
      setError(null)
      try {
        const currentMessages = messagesRef.current
        const failedMessageIndex = currentMessages.findIndex(
          currentMessage => currentMessage.id === message.id
        )
        const associatedRetrySource = message.subtaskId
          ? retrySourceBySubtaskIdRef.current.get(message.subtaskId)
          : undefined
        const retrySource = associatedRetrySource ?? lastSubmittedRetryMessageRef.current
        const failedCreatedAt = Date.parse(message.createdAt)
        const retrySourceCreatedAt = retrySource ? Date.parse(retrySource.createdAt) : Number.NaN
        const retrySourcePredatesFailure =
          Number.isNaN(failedCreatedAt) ||
          Number.isNaN(retrySourceCreatedAt) ||
          retrySourceCreatedAt <= failedCreatedAt
        const retryUserMessageOverride =
          associatedRetrySource ??
          (failedMessageIndex >= 0 && retrySourcePredatesFailure ? retrySource : null)
        debugRuntimePaneMessageFlow('retry-failed-message', () => ({
          address: currentRuntimeTask ? runtimeAddressDebug(currentRuntimeTask) : null,
          failedMessageId: message.id,
          failedMessageIndex,
          retrySource: textMetrics(retrySource?.content),
          associatedRetrySource: Boolean(associatedRetrySource),
          retrySourcePredatesFailure,
          usingRetrySourceOverride: Boolean(retryUserMessageOverride),
        }))
        const sent = await retryRuntimeFailedMessage(
          message.id,
          currentMessages,
          retryUserMessageOverride ?? undefined,
          retryModelConfiguration,
          { onError: setError }
        )
        if (sent) {
          // Retain the original failure and partial output. Accepting a continuation
          // does not mean the user cancelled the failed attempt.
          const continued = /^(turn-\d+)(?:-retry-[0-9a-f-]+)?$/.test(
            message.turnId ?? message.subtaskId ?? ''
          )
          setMessages(messages =>
            continued
              ? messages.map(currentMessage =>
                  currentMessage.id === message.id
                    ? {
                        ...currentMessage,
                        continuationAccepted: true,
                        stoppedNotice: false,
                      }
                    : currentMessage
                )
              : messages.filter(currentMessage => currentMessage.id !== message.id)
          )
        }
        return sent
      } catch (error) {
        console.error('[KCoder Studio] Runtime failed message retry failed', {
          address: currentRuntimeTask ? runtimeAddressDebug(currentRuntimeTask) : null,
          messageId: message.id,
          error,
        })
        setError(error instanceof Error ? error.message : '重试失败')
        return false
      } finally {
        retryInFlightRef.current = false
      }
    },
    [
      canSendWithSelectedModel,
      currentRuntimeTask,
      lastSubmittedRetryMessageRef,
      messagesRef,
      retryInFlightRef,
      retryRuntimeFailedMessage,
      retrySourceBySubtaskIdRef,
      setError,
      setMessages,
    ]
  )
  return {
    ...context,
    canSendWithSelectedModel,
    getRuntimeModelFields,
    appendLocalUserMessage,
    applyLocalRequestUserInputResponse,
    sendRuntimeMessage,
    refreshQueuedDelivery,
    interruptAndSendQueuedMessage,
    retryFailedMessageInPane,
  }
}
