import type { RuntimeInputRecovery } from '@/kcoder/runtimeTaskCreationError'
import { EvolutionConversationProvider } from '@/kcoder/evolution/EvolutionConversationProvider'
import { composerInputHistoryScope } from '@/components/chat/composer/composerInputHistory'
import { ComposerStatusRegion } from '@/components/chat/composer/ComposerStatusRegion'
import { AsyncQuestionPanel } from '@/components/chat/AsyncQuestionPanel'
import { ConversationWidgetsProvider } from '@/components/chat/widgets/ConversationWidgetsProvider'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useRuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { runtimeThreadId } from '@/features/workbench/useWorkbenchRuntimeMessaging'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { workspacePathKey } from '@/lib/workspace-path-identity'
import { operationFeedback } from '@/lib/operation-feedback'
import { createRandomUuid } from '@/lib/random-id'
import type {
  Attachment,
  ProjectWithTasks,
  RuntimeTaskAddress,
  TurnFileChangesSummary,
} from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { reduceWorkbenchMessages } from '@wegent/chat-core'

const SIDE_CHAT_MESSAGE_LIST_CLASS = 'w-full max-w-none px-5 pb-4 pt-5'

function temporaryChatStatusOwnerKey(instanceId: string, address: RuntimeTaskAddress | null) {
  return JSON.stringify([
    instanceId,
    address?.deviceId ?? null,
    address?.taskId ?? null,
    address ? runtimeThreadId(address) ?? null : null,
    workspacePathKey(address?.workspacePath),
  ])
}

function isBatchableRuntimePaneMessageAction(action: RuntimePaneMessageAction): boolean {
  return action.type === 'assistant_chunk' || action.type === 'block_updated'
}

function createUserMessage(content: string): WorkbenchMessage {
  const createdAt = new Date().toISOString()
  return {
    id: `side-user-${createRandomUuid()}`,
    role: 'user',
    content,
    status: 'done',
    createdAt,
  }
}

interface TemporaryChatPanelProps {
  currentProject: ProjectWithTasks | null
  source: RuntimeTaskAddress | null
  instanceId: string
  testId?: string
  initialInput?: string
  /** Sends `initialInput` once after mount, e.g. for `/btw <question>`. */
  autoSubmitInitialInput?: boolean
  onInitialInputSubmitted?: () => void
}

export function TemporaryChatPanel({
  currentProject,
  source,
  instanceId,
  testId = 'right-workspace-chat-panel',
  initialInput = '',
  autoSubmitInitialInput = false,
  onInitialInputSubmitted,
}: TemporaryChatPanelProps) {
  const {
    services,
    state,
    projectChat,
    createTemporaryRuntimeTask,
    sendRuntimePaneMessage,
    cancelRuntimePaneTask,
    subscribeRuntimeTaskStream,
    loadRuntimeTranscriptForPane,
  } = useWorkbenchPaneContext()
  const attachmentSelection = useWorkbenchAttachments({
    uploadAttachment: services.attachmentApi?.uploadAttachment,
    deleteAttachment: services.attachmentApi?.deleteAttachment,
    scopeKey: instanceId,
  })
  const sideChatProjectChat = useMemo(
    () => ({
      ...projectChat,
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      handleFileSelect: attachmentSelection.handleFileSelect,
      cancelUpload: attachmentSelection.cancelUpload,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
    }),
    [attachmentSelection, projectChat]
  )
  const [address, setAddress] = useState<RuntimeTaskAddress | null>(null)
  const [confirmedQuestionOwnerKey, setConfirmedQuestionOwnerKey] = useState<string | null>(null)
  const questionOwnerKey = temporaryChatStatusOwnerKey(instanceId, address)
  const questionPendingCreation = Boolean(address) && confirmedQuestionOwnerKey !== questionOwnerKey
  const lifecycleStore = useRuntimeTaskLifecycleStore()
  const mountedRef = useRef(true)
  const addressRef = useRef<RuntimeTaskAddress | null>(null)
  const disposeTemporaryTask = services.runtimeWorkApi?.disposeTemporaryRuntimeTask
  const disposeRef = useRef(disposeTemporaryTask)
  useEffect(() => {
    disposeRef.current = disposeTemporaryTask
  }, [disposeTemporaryTask])
  const disposeAddress = useCallback(
    (target: RuntimeTaskAddress) => {
      void disposeRef
        .current?.(target)
        .then(() => {
          // Keep a settled machine so late creation acknowledgments cannot revive it.
          lifecycleStore.executorSettled(target)
          lifecycleStore.turnSettled(target)
        })
        .catch(error => {
          console.warn('Failed to dispose temporary chat:', error)
        })
    },
    [lifecycleStore]
  )
  const adoptAddress = useCallback(
    (target: RuntimeTaskAddress) => {
      addressRef.current = target
      if (mountedRef.current) setAddress(target)
      else disposeAddress(target)
    },
    [disposeAddress]
  )
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (addressRef.current) disposeAddress(addressRef.current)
    }
  }, [disposeAddress])
  const [messages, setMessages] = useState<WorkbenchMessage[]>([])
  const [input, setInput] = useState(initialInput)
  const [inputError, setInputError] = useState<{ message: string; recovery?: RuntimeInputRecovery } | null>(null)
  const error = inputError?.message ?? null
  const setError = useCallback((message: string | null, recovery?: RuntimeInputRecovery) => {
    setInputError(message ? { message, recovery } : null)
  }, [])
  const [sending, setSending] = useState(false)
  const [loadingFullTranscript, setLoadingFullTranscript] = useState(false)
  const pendingMessageActionsRef = useRef<RuntimePaneMessageAction[]>([])
  const messageActionFrameRef = useRef<number | null>(null)

  useEffect(() => {
    if (!initialInput) return
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-testid="${testId}"] [data-testid="chat-message-input"]`)
        ?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [initialInput, testId])

  const applyMessageActions = useCallback((actions: RuntimePaneMessageAction[]) => {
    if (actions.length === 0) return
    setMessages(current => {
      let nextMessages = current
      for (const action of actions) {
        nextMessages = reduceWorkbenchMessages<Attachment, TurnFileChangesSummary>(
          nextMessages,
          action
        )
      }
      return nextMessages
    })
  }, [])

  const flushPendingMessageActions = useCallback(() => {
    if (messageActionFrameRef.current !== null) {
      cancelAnimationFrame(messageActionFrameRef.current)
      messageActionFrameRef.current = null
    }
    const pendingActions = pendingMessageActionsRef.current
    if (pendingActions.length === 0) return
    pendingMessageActionsRef.current = []
    applyMessageActions(pendingActions)
  }, [applyMessageActions])

  const dispatchMessages = useCallback(
    (action: RuntimePaneMessageAction) => {
      if (!isBatchableRuntimePaneMessageAction(action)) {
        flushPendingMessageActions()
        applyMessageActions([action])
        return
      }

      pendingMessageActionsRef.current.push(action)
      if (messageActionFrameRef.current !== null) return
      messageActionFrameRef.current = requestAnimationFrame(() => {
        messageActionFrameRef.current = null
        const pendingActions = pendingMessageActionsRef.current
        if (pendingActions.length === 0) return
        pendingMessageActionsRef.current = []
        applyMessageActions(pendingActions)
      })
    },
    [applyMessageActions, flushPendingMessageActions]
  )

  useEffect(() => {
    return () => {
      if (messageActionFrameRef.current !== null) {
        cancelAnimationFrame(messageActionFrameRef.current)
        messageActionFrameRef.current = null
      }
      pendingMessageActionsRef.current = []
    }
  }, [])

  useEffect(() => {
    if (!address || !runtimeThreadId(address)) return
    let cancelled = false
    void loadRuntimeTranscriptForPane(address)
      .then(transcript => {
        if (!cancelled && transcript.messages.length > 0) {
          setMessages(transcript.messages)
        }
      })
      .catch(caughtError => {
        if (!cancelled) {
          setError(operationFeedback(caughtError, 'read').message)
        }
      })
    return () => {
      cancelled = true
    }
  }, [address, loadRuntimeTranscriptForPane, setError])

  const loadFullTranscript = useCallback(async () => {
    if (!address || loadingFullTranscript) return
    setLoadingFullTranscript(true)
    try {
      const transcript = await loadRuntimeTranscriptForPane(address, {
        includeFullContent: true,
        refresh: true,
      })
      if (transcript.messages.length > 0) {
        setMessages(transcript.messages)
      }
    } catch (caughtError) {
      setError(operationFeedback(caughtError, 'read').message)
    } finally {
      setLoadingFullTranscript(false)
    }
  }, [address, loadRuntimeTranscriptForPane, loadingFullTranscript, setError])

  useEffect(() => {
    if (!address) return
    return subscribeRuntimeTaskStream(address, {
      onMessageAction: dispatchMessages,
      onAssistantStart: () => setSending(true),
      onAssistantSettled: () => setSending(false),
    })
  }, [address, dispatchMessages, subscribeRuntimeTaskStream])

  const selectedModelFields = useMemo(() => {
    const selectedModel = projectChat.getSelectedModel?.() ?? projectChat.selectedModel
    const selectedModelOptions =
      projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
    return selectedModelExecutionFields(selectedModel, selectedModelOptions)
  }, [projectChat])

  const send = useCallback(
    async (valueOverride?: string) => {
      const message = (valueOverride ?? input).trim()
      if (!message) return
      setError(null)
      const pendingUserMessage = createUserMessage(message)
      setMessages(current => [...current, pendingUserMessage])
      setSending(true)

      const currentAttachments = sideChatProjectChat.attachments
      const attachmentIds = remoteAttachmentIds(currentAttachments)
      const attachments = localRuntimeAttachments(currentAttachments)
      const handleError = (message: string, recovery?: RuntimeInputRecovery) => {
        const failure = operationFeedback(message)
        setError(recovery ? message : failure.message, recovery)
        if (failure.outcome === 'rejected' || recovery?.kind === 'creation-rejected')
          setMessages(current => current.filter(item => item.id !== pendingUserMessage.id))
        setSending(false)
      }

      const targetAddress =
        address ??
        (await createTemporaryRuntimeTask(message, {
          project: currentProject,
          source,
          attachments: currentAttachments,
          onError: handleError,
          onRuntimeTaskOptimisticOpen: adoptAddress,
        }))

      if (!targetAddress) {
        addressRef.current = null
        if (mountedRef.current) {
          setAddress(null)
          setConfirmedQuestionOwnerKey(null)
        }
        return
      }
      if (!mountedRef.current) {
        disposeAddress(targetAddress)
        return
      }
      if (!address) {
        adoptAddress(targetAddress)
        setConfirmedQuestionOwnerKey(temporaryChatStatusOwnerKey(instanceId, targetAddress))
        setInput(current => (current === input ? '' : current))
        sideChatProjectChat.resetAttachments()
        return
      }

      const sent = await sendRuntimePaneMessage(
        {
          address: targetAddress,
          message,
          ephemeral: true,
          ...selectedModelFields,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        { onError: handleError }
      )
      if (sent) {
        setInput(current => (current === input ? '' : current))
        sideChatProjectChat.resetAttachments()
      } else {
        setSending(false)
      }
    },
    [
      address,
      createTemporaryRuntimeTask,
      currentProject,
      input,
      sideChatProjectChat,
      selectedModelFields,
      sendRuntimePaneMessage,
      source,
      adoptAddress,
      disposeAddress,
      instanceId,
      setError,
    ]
  )

  // The ref survives StrictMode effect replays, so the question is sent at most once.
  const autoSubmitPendingRef = useRef(autoSubmitInitialInput && Boolean(initialInput.trim()))
  const sendRef = useRef(send)
  const initialInputSubmittedRef = useRef(onInitialInputSubmitted)
  useLayoutEffect(() => {
    sendRef.current = send
    initialInputSubmittedRef.current = onInitialInputSubmitted
  })
  useEffect(() => {
    if (!autoSubmitPendingRef.current) return
    autoSubmitPendingRef.current = false
    initialInputSubmittedRef.current?.()
    void sendRef.current(initialInput)
  }, [initialInput])

  const pause = useCallback(() => {
    if (!address) return
    void cancelRuntimePaneTask(address, {
      onError: message => setError(message),
    }).finally(() => setSending(false))
  }, [address, cancelRuntimePaneTask, setError])

  return (
    <EvolutionConversationProvider address={address} promotionNotice={false}>
    <ConversationWidgetsProvider address={address} messages={messages} onSendPrompt={text => setInput(value => value ? `${value}\n\n${text}` : text)}>
    <section data-testid={testId} className="flex min-h-0 flex-1 flex-col">
      {messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-sm text-text-muted">
          <MessageCircle className="h-5 w-5 text-text-secondary" />
          <p>临时聊天不会出现在左侧任务列表。</p>
        </div>
      ) : (
        <ScrollableMessageArea
          messages={messages}
          isWaitingForAssistant={sending}
          devices={state.devices}
          toolsCatalogTaskId={address?.taskId}
          toolsCatalogServerId={address?.deviceId}
          conversationKey={address?.taskId ?? instanceId}
          className="min-h-0 flex-1"
          scrollerClassName="min-w-0 lg:ml-14"
          messageListClassName={SIDE_CHAT_MESSAGE_LIST_CLASS}
          scrollTestId="right-workspace-chat-scroll-area"
          onLoadFullTranscript={loadFullTranscript}
          loadingFullTranscript={loadingFullTranscript}
        />
      )}
      <ComposerStatusRegion ownerKey={questionOwnerKey}>
        {address ? (
          <AsyncQuestionPanel
            key={questionOwnerKey}
            address={address}
            pendingCreation={questionPendingCreation}
          />
        ) : null}
        <div className="shrink-0 bg-background px-4 py-3">
          <BufferedChatInput
            historyMessages={messages}
            inputHistoryScope={composerInputHistoryScope(address, instanceId)}
            value={input}
            onChange={setInput}
            onSubmit={send}
            disabled={false}
            error={error}
            errorRecovery={inputError?.recovery}
            placeholder="要求后续变更"
            variant="desktop"
            projectChat={sideChatProjectChat}
            showProjectWorkBar={false}
            isStreaming={sending}
            onPause={pause}
          />
        </div>
      </ComposerStatusRegion>
    </section>
    </ConversationWidgetsProvider>
    </EvolutionConversationProvider>
  )
}
