import {
  compareMessageStyles,
  summarizeMessages,
  summarizeRuntimePaneMemory,
  updateRuntimePaneDebugSnapshot,
} from '@/lib/debugPanel'
import { useEffect, useState } from 'react'

import type { usePaneGoal } from './usePaneGoal'

export function usePaneDiagnostics(context: ReturnType<typeof usePaneGoal>) {
  const {
    currentRuntimeTask,
    getRuntimeSessionModes,
    queuedMessages,
    queuedMessagesPaused,
    guidanceMessages,
    codeCommentContexts,
    input,
    transcriptLoading,
    transcriptHasMoreBefore,
    transcriptLoadingMoreBefore,
    transcriptLoadingFullContent,
    transcriptFullContent,
    loadedTranscriptRanges,
    turnNavigation,
    subagentStatuses,
    taskPlan,
    goalDraftActive,
    goalDraftMode,
    messages,
    paneStatus,
    goal,
  } = context
  useEffect(() => {
    updateRuntimePaneDebugSnapshot({
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
    })
  }, [
    codeCommentContexts.length,
    currentRuntimeTask,
    goal,
    taskPlan,
    goalDraftActive,
    goalDraftMode,
    guidanceMessages,
    input.length,
    loadedTranscriptRanges,
    messages,
    paneStatus,
    queuedMessages,
    queuedMessagesPaused,
    subagentStatuses,
    transcriptHasMoreBefore,
    transcriptFullContent,
    transcriptLoading,
    transcriptLoadingFullContent,
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

  useEffect(() => {
    if (!currentRuntimeTask || !getRuntimeSessionModes || transcriptLoading) return
    let cancelled = false
    void getRuntimeSessionModes({ address: currentRuntimeTask })
      .then(result => {
        if (cancelled) return
        setLoadedSessionMode({
          taskId: currentRuntimeTask.taskId,
          mode: result.sessionMode,
          workflowDefinitionId: result.workflowDefinitionId,
        })
        // Read-only: a running session keeps its bound template, so Studio only shows it.
        setLoadedSessionTemplate({
          taskId: currentRuntimeTask.taskId,
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
  }, [currentRuntimeTask, getRuntimeSessionModes, transcriptLoading])
  return {
    ...context,
    loadedSessionMode,
    setLoadedSessionMode,
    loadedSessionTemplate,
    setLoadedSessionTemplate,
  }
}
