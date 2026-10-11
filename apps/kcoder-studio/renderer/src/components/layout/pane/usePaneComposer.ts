import { debugComposerEvent, textMetrics } from '@/components/chat/composer/composerDebug'
import { cacheRuntimeConversationMessages } from '@/features/workbench/runtimeConversationCache'
import i18n from '@/i18n'
import { persistAttachmentReferences } from '@/lib/attachments'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import { appendConversationMentionContext } from '@/lib/conversation-mentions'
import type { RuntimeAdditionalContext, RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import { useCallback } from 'react'
import {
  clearRuntimePaneGoalSeed,
  confirmRuntimePaneGoalSeed,
  createPendingRuntimeGoal,
  runtimeGoalCreateInput,
  seedRuntimePaneGoal,
} from './goalSeeds'
import {
  debugRuntimePaneMessageFlow,
  runtimeAddressDebug,
  summarizeWorkbenchMessages,
} from './paneDiagnostics'
import { createLocalUserMessage } from './paneMessageReducer'
import {
  isUnboundPendingGoalState,
  runtimeTranscriptPaneIdentityKey,
  runtimeTranscriptPaneKey,
} from './sessionIdentity'
import { type RuntimePaneSendOptions } from './sessionTypes'
import { isRuntimeTaskAddress } from './subagentState'
import type { usePaneQueueDispatch } from './usePaneQueueDispatch'

export function usePaneComposer(context: ReturnType<typeof usePaneQueueDispatch>) {
  const {
    currentRuntimeTask,
    projectChat,
    loadRuntimeTranscriptForPane,
    setRuntimeGoal,
    compactRuntimePaneTask,
    sendCurrentInput,
    lifecycleStore,
    queuedMessages,
    setQueuedMessages,
    codeCommentContexts,
    setCodeCommentContexts,
    input,
    scopedSetInput,
    setError,
    setInput,
    pendingGoalState,
    setPendingGoalState,
    goalDraftActive,
    setGoalDraftActive,
    goalDraftMode,
    commitThreadGoal,
    dispatchMessages,
    paneStatus,
    canSendWithSelectedModel,
    getRuntimeModelFields,
    appendLocalUserMessage,
    sendRuntimeMessage,
    interruptAndSendQueuedMessage,
    sendQueuedMessageAsGuidance,
  } = context
  const send: (inputOverride?: string, options?: RuntimePaneSendOptions) => Promise<void> =
    useCallback(
      async (inputOverride, options = {}) => {
        if (!canSendWithSelectedModel()) return
        if (
          options.computerUse &&
          (paneStatus.isBusy || queuedMessages.length > 0 || goalDraftActive)
        ) {
          setError(i18n.t('common:computerUse.immediateOnly'))
          return
        }
        const submittedInput = (inputOverride ?? input).trim()
        const currentAttachments = projectChat.attachments
        const hasCodeComments = codeCommentContexts.length > 0
        debugComposerEvent('pane-send-called', {
          hasSubmittedValue: inputOverride !== undefined,
          submittedValue: textMetrics(inputOverride),
          stateInput: textMetrics(input),
          submittedInput: textMetrics(submittedInput),
          attachmentsCount: currentAttachments.length,
          codeCommentsCount: codeCommentContexts.length,
          hasCodeComments,
          goalDraftActive,
          guideWhenBusy: options.guideWhenBusy === true,
          interruptWhenBusy: options.interruptWhenBusy === true,
          hasCurrentRuntimeTask: Boolean(currentRuntimeTask),
          paneBusy: paneStatus.isBusy,
        })

        if (goalDraftActive) {
          if (!submittedInput) {
            setError(i18n.t('workbench.goal_objective_required'))
            return
          }
          if (hasCodeComments) {
            setError(i18n.t('workbench.runtime_task_code_comments_not_supported'))
            return
          }

          // Errors belong to the previous action; a new goal submission starts fresh.
          setError(null)
          setInput('')
          if (currentRuntimeTask) {
            const response = await setRuntimeGoal({
              address: currentRuntimeTask,
              objective: submittedInput,
              mode: goalDraftMode,
              status: 'active',
            })
            if (!response.accepted) {
              setInput(submittedInput)
              setError(response.error || i18n.t('workbench.goal_set_failed'))
              return
            }
            commitThreadGoal(response.goal)
            lifecycleStore.goalStatusReceived(currentRuntimeTask, response.goal.status)
            setGoalDraftActive(false)
            const queuedMessage: RuntimePaneQueuedMessage = {
              turnMode: options.turnMode,
              id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
              content: submittedInput,
              status: 'queued',
              createdAt: new Date().toISOString(),
              attachments: persistAttachmentReferences(currentAttachments),
              runtimeGoalRequest: true,
              additionalContext: options.additionalContext,
              ...getRuntimeModelFields(),
            }

            projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
            if (paneStatus.isBusy) {
              setQueuedMessages(messages => [...messages, queuedMessage])
              options.onExecutionModeAccepted?.()
              if (options.guideWhenBusy) {
                await sendQueuedMessageAsGuidance(queuedMessage)
              }
              return
            }

            const sent = await sendRuntimeMessage(queuedMessage, {
              computerUse: options.computerUse,
            })
            if (sent) {
              options.onExecutionModeAccepted?.()
              setCodeCommentContexts([])
            } else {
              setError('目标已更新，但指令发送失败')
              setInput(submittedInput)
            }
            return
          }

          const draftGoal = createPendingRuntimeGoal(submittedInput, goalDraftMode)
          const initialGoal = runtimeGoalCreateInput(draftGoal)
          setPendingGoalState({ goal: draftGoal, targetKey: null, targetIdentityKey: null })
          setGoalDraftActive(false)
          const optimisticMessage = createLocalUserMessage(submittedInput, currentAttachments, {
            runtimeGoalRequest: true,
          })
          let seededGoalAddress: RuntimeTaskAddress | null = null
          const sent = await sendCurrentInput(submittedInput, {
            computerUse: options.computerUse,
            sessionMode: options.sessionMode,
            workflowDefinitionId: options.workflowDefinitionId,
            turnMode: options.turnMode,
            clientMessageId: optimisticMessage.id,
            initialGoal,
            additionalContext: options.additionalContext,
            onRuntimeTaskOptimisticOpen: (address, context) => {
              options.onRuntimeTaskCreated?.(address)
              setPendingGoalState(current =>
                current
                  ? {
                      ...current,
                      targetKey: runtimeTranscriptPaneKey(address),
                      targetIdentityKey: runtimeTranscriptPaneIdentityKey(address),
                    }
                  : current
              )
              seedRuntimePaneGoal(address, draftGoal)
              seededGoalAddress = address
              const seededMessages = [optimisticMessage]
              debugRuntimePaneMessageFlow('seed-goal-first-open', {
                address: runtimeAddressDebug(address),
                previousAddress: context?.previousAddress
                  ? runtimeAddressDebug(context.previousAddress)
                  : null,
                previousCount: 0,
                seededCount: seededMessages.length,
                seededMessages: summarizeWorkbenchMessages(seededMessages),
              })
              cacheRuntimeConversationMessages(address, seededMessages)
            },
          })
          if (sent) {
            if (isRuntimeTaskAddress(sent)) confirmRuntimePaneGoalSeed(sent)
            options.onExecutionModeAccepted?.()
            if (!isRuntimeTaskAddress(sent)) {
              appendLocalUserMessage(submittedInput, currentAttachments, {
                runtimeGoalRequest: true,
              })
            } else {
              setPendingGoalState(current =>
                current
                  ? {
                      ...current,
                      targetKey: runtimeTranscriptPaneKey(sent),
                      targetIdentityKey: runtimeTranscriptPaneIdentityKey(sent),
                    }
                  : current
              )
            }
          } else {
            if (seededGoalAddress) {
              clearRuntimePaneGoalSeed(seededGoalAddress)
            }
            setGoalDraftActive(true)
            setPendingGoalState(null)
          }
          return
        }

        if (submittedInput === '/compact') {
          if (!currentRuntimeTask) {
            setError('当前对话还没有可压缩的运行时线程')
            return
          }
          if (paneStatus.isBusy) {
            setError('当前回复进行中，完成后再压缩上下文')
            return
          }
          if (currentAttachments.length > 0 || hasCodeComments) {
            setError('/compact cannot be sent with attachments or code comments')
            return
          }
          setInput('')
          await compactRuntimePaneTask(currentRuntimeTask, { onError: setError })
          return
        }

        const pendingInitialGoal =
          !currentRuntimeTask && pendingGoalState && isUnboundPendingGoalState(pendingGoalState)
            ? runtimeGoalCreateInput(pendingGoalState.goal)
            : null
        const effectiveSubmittedInput = submittedInput || pendingInitialGoal?.objective.trim() || ''
        if (!effectiveSubmittedInput && currentAttachments.length === 0 && !hasCodeComments) {
          void sendCurrentInput('', {
            codeCommentContexts,
            additionalContext: options.additionalContext,
          })
          return
        }

        let resolvedAdditionalContext: RuntimeAdditionalContext | undefined
        try {
          resolvedAdditionalContext = await appendConversationMentionContext(
            effectiveSubmittedInput,
            options.additionalContext,
            loadRuntimeTranscriptForPane
          )
        } catch (cause) {
          console.warn('[KCoder Studio composer] failed to load referenced conversation', cause)
          setError(i18n.t('workbench.mention_conversation_load_failed'))
          return
        }

        // Do not keep an earlier action error visible once the user sends a new message.
        setError(null)
        setInput('')
        const visibleSubmittedInput =
          effectiveSubmittedInput ||
          (hasCodeComments ? i18n.t('workbench.code_comment_fallback') : '')
        if (!currentRuntimeTask) {
          const optimisticMessage = createLocalUserMessage(
            visibleSubmittedInput,
            currentAttachments,
            {
              runtimeGoalRequest: Boolean(pendingInitialGoal),
              codeComments: codeCommentContexts,
            }
          )
          const sent = await sendCurrentInput(visibleSubmittedInput, {
            computerUse: options.computerUse,
            sessionMode: options.sessionMode,
            workflowDefinitionId: options.workflowDefinitionId,
            turnMode: options.turnMode,
            clientMessageId: optimisticMessage.id,
            codeCommentContexts,
            initialGoal: pendingInitialGoal,
            additionalContext: resolvedAdditionalContext,
            onError: setError,
            onRuntimeTaskOptimisticOpen: (address, context) => {
              options.onRuntimeTaskCreated?.(address)
              if (pendingInitialGoal) {
                setPendingGoalState(current =>
                  current
                    ? {
                        ...current,
                        targetKey: runtimeTranscriptPaneKey(address),
                        targetIdentityKey: runtimeTranscriptPaneIdentityKey(address),
                      }
                    : current
                )
              }
              if (pendingInitialGoal && pendingGoalState) {
                seedRuntimePaneGoal(address, pendingGoalState.goal)
              }
              const seededMessages = [optimisticMessage]
              debugRuntimePaneMessageFlow('seed-optimistic-open', {
                address: runtimeAddressDebug(address),
                previousAddress: context?.previousAddress
                  ? runtimeAddressDebug(context.previousAddress)
                  : null,
                previousCount: 0,
                seededCount: seededMessages.length,
                seededMessages: summarizeWorkbenchMessages(seededMessages),
              })
              cacheRuntimeConversationMessages(address, seededMessages)
            },
          })
          if (sent) {
            if (isRuntimeTaskAddress(sent)) confirmRuntimePaneGoalSeed(sent)
            options.onExecutionModeAccepted?.()
            if (!isRuntimeTaskAddress(sent)) {
              appendLocalUserMessage(visibleSubmittedInput, currentAttachments, {
                runtimeGoalRequest: Boolean(pendingInitialGoal),
                codeComments: codeCommentContexts,
              })
            } else {
              if (pendingInitialGoal) {
                setPendingGoalState(current =>
                  current
                    ? {
                        ...current,
                        targetKey: runtimeTranscriptPaneKey(sent),
                        targetIdentityKey: runtimeTranscriptPaneIdentityKey(sent),
                      }
                    : current
                )
              }
            }
            if (isRuntimeTaskAddress(sent)) {
              dispatchMessages({ type: 'reset', messages: [] })
            }
            projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
            setCodeCommentContexts([])
          } else {
            // Restore the draft when send is blocked so the user can retry.
            // Use scoped setter so we do not clear the pane error reported via onError.
            scopedSetInput(visibleSubmittedInput)
          }
          return
        }

        if (hasCodeComments) {
          const queuedMessage: RuntimePaneQueuedMessage = {
            turnMode: options.turnMode,
            id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
            content: appendCodeCommentContexts(visibleSubmittedInput, codeCommentContexts),
            displayContent: visibleSubmittedInput,
            codeComments: codeCommentContexts,
            status: 'queued',
            createdAt: new Date().toISOString(),
            attachments: persistAttachmentReferences(currentAttachments),
            additionalContext: resolvedAdditionalContext,
            ...getRuntimeModelFields(),
          }

          if (paneStatus.isBusy) {
            projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
            setCodeCommentContexts([])
            if (options.interruptWhenBusy) {
              const sent = await interruptAndSendQueuedMessage(queuedMessage)
              if (sent) options.onExecutionModeAccepted?.()
              if (!sent) {
                scopedSetInput(visibleSubmittedInput)
                currentAttachments.forEach(projectChat.addExistingAttachment)
                setCodeCommentContexts(codeCommentContexts)
              }
              return
            }
            setQueuedMessages(messages => [...messages, queuedMessage])
            options.onExecutionModeAccepted?.()
            return
          }

          const sent = await sendRuntimeMessage(queuedMessage, { computerUse: options.computerUse })
          if (sent) {
            options.onExecutionModeAccepted?.()
            projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
            setCodeCommentContexts([])
          }
          return
        }

        const queuedMessage: RuntimePaneQueuedMessage = {
          turnMode: options.turnMode,
          id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
          content: submittedInput,
          status: 'queued',
          createdAt: new Date().toISOString(),
          attachments: persistAttachmentReferences(currentAttachments),
          additionalContext: resolvedAdditionalContext,
          ...getRuntimeModelFields(),
        }

        projectChat.resetAttachments(currentAttachments.map(attachment => attachment.id))
        if (paneStatus.isBusy) {
          if (options.interruptWhenBusy) {
            const sent = await interruptAndSendQueuedMessage(queuedMessage)
            if (sent) options.onExecutionModeAccepted?.()
            if (!sent) {
              scopedSetInput(submittedInput)
              currentAttachments.forEach(projectChat.addExistingAttachment)
            }
            return
          }
          setQueuedMessages(messages => [...messages, queuedMessage])
          options.onExecutionModeAccepted?.()
          if (options.guideWhenBusy) {
            await sendQueuedMessageAsGuidance(queuedMessage)
          }
          return
        }

        const sent = await sendRuntimeMessage(queuedMessage, { computerUse: options.computerUse })
        if (sent) {
          options.onExecutionModeAccepted?.()
          setCodeCommentContexts([])
        }
      },
      [
        canSendWithSelectedModel,
        input,
        projectChat,
        codeCommentContexts,
        goalDraftActive,
        currentRuntimeTask,
        paneStatus.isBusy,
        pendingGoalState,
        setError,
        setInput,
        queuedMessages.length,
        getRuntimeModelFields,
        sendRuntimeMessage,
        goalDraftMode,
        setPendingGoalState,
        setGoalDraftActive,
        sendCurrentInput,
        setRuntimeGoal,
        commitThreadGoal,
        lifecycleStore,
        setQueuedMessages,
        sendQueuedMessageAsGuidance,
        setCodeCommentContexts,
        appendLocalUserMessage,
        compactRuntimePaneTask,
        loadRuntimeTranscriptForPane,
        dispatchMessages,
        scopedSetInput,
        interruptAndSendQueuedMessage,
      ]
    )
  return { ...context, send }
}
