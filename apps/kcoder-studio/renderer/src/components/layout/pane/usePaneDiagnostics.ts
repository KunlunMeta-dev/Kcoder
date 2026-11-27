import {
  compareMessageStyles,
  summarizeMessages,
  summarizeRuntimePaneMemory,
  updateRuntimePaneDebugSnapshot,
} from '@/lib/debugPanel'
import { useEffect, useState } from 'react'

import type { usePaneGoal } from './usePaneGoal'
import { useRuntimeTaskReadAddress } from './useRuntimeTaskReadAddress'
import { useWorkbenchPaneActive } from '../workbenchPaneStack'

export function usePaneDiagnostics(context: ReturnType<typeof usePaneGoal>) {
  const paneActive = useWorkbenchPaneActive()
  const {
    currentRuntimeTask,
    runtimeTaskLoadTarget,
    getRuntimeSessionModes,
    queuedMessages,
    guidanceMessages,
    codeCommentContexts,
    input,
    transcriptLoading,
    transcriptHasMoreBefore,
    transcriptLoadingMoreBefore,
    loadedTranscriptRanges,
    turnNavigation,
    subagentStatuses,
    goalDraftActive,
    messages,
    paneStatus,
    goal,
  } = context
  useEffect(() => {
    if (!paneActive) return
    return updateRuntimePaneDebugSnapshot(() => ({
      currentRuntimeTask,
      status: paneStatus,
      messageSummary: summarizeMessages(messages),
      messageStyleComparison: compareMessageStyles(messages),
      memory: summarizeRuntimePaneMemory({
        messages,
        currentRuntimeTask,
        loadedRanges: loadedTranscriptRanges,
      }),
      queuedMessages,
      guidanceMessages,
      codeCommentContextCount: codeCommentContexts.length,
      inputLength: input.length,
      transcript: {
        loading: transcriptLoading,
        hasMoreBefore: transcriptHasMoreBefore,
        loadingMoreBefore: transcriptLoadingMoreBefore,
        turnNavigationCount: turnNavigation.length,
        loadedRanges: loadedTranscriptRanges,
      },
      subagentStatuses,
      goal,
      goalDraftActive,
    }))
  }, [
    paneActive,
    codeCommentContexts.length,
    currentRuntimeTask,
    goal,
    goalDraftActive,
    guidanceMessages,
    input.length,
    loadedTranscriptRanges,
    messages,
    paneStatus,
    queuedMessages,
    subagentStatuses,
    transcriptHasMoreBefore,
    transcriptLoading,
    transcriptLoadingMoreBefore,
    turnNavigation.length,
  ])

  const [loadedSessionMode, setLoadedSessionMode] = useState<{
    taskId: string
    mode: import('@/types/api').RuntimeSessionMode
    workflowDefinitionId?: string | null
  } | null>(null)

  const [loadedSessionTemplate, setLoadedSessionTemplate] = useState<{
    taskId: string
    binding: { id: string; revisionSha256: string } | null
  } | null>(null)

  const sessionModesAddress = useRuntimeTaskReadAddress(currentRuntimeTask, runtimeTaskLoadTarget?.address)

  useEffect(() => {
    if (!sessionModesAddress || !getRuntimeSessionModes || transcriptLoading) return
    let cancelled = false
    void getRuntimeSessionModes({ address: sessionModesAddress })
      .then(result => {
        if (cancelled) return
        setLoadedSessionMode({
          taskId: sessionModesAddress.taskId,
          mode: result.sessionMode,
          workflowDefinitionId: result.workflowDefinitionId,
        })
        // Read-only: a running session keeps its bound template, so Studio only shows it.
        setLoadedSessionTemplate({
          taskId: sessionModesAddress.taskId,
          binding: result.settingsTemplate ?? null,
        })
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedSessionMode(null)
          setLoadedSessionTemplate(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [sessionModesAddress, getRuntimeSessionModes, transcriptLoading])
  return {
    ...context,
    loadedSessionMode,
    setLoadedSessionMode,
    loadedSessionTemplate,
    setLoadedSessionTemplate,
  }
}
