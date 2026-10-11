import type { EnvironmentDiffMode } from '@/api/environment'
import type { AssistantPlanOpenRequest } from '@/components/chat/AssistantPlanCard'
import { subscribeDesktopFileAction } from '@/kcoder/desktopFileActions'
import {
  DEFAULT_EMBEDDED_BROWSER_LABEL,
  listenEmbeddedBrowserOpenRequests,
} from '@/lib/embedded-browser'
import { KCODER_STUDIO_OPEN_TERMINAL_EVENT } from '@/lib/keybindings'
import { getLocalPathKind } from '@/lib/local-terminal'
import { subagentArtifactKindFromPath } from '@/lib/subagent-artifact'
import { normalizeAbsoluteWorkspacePath } from '@/lib/workspace-file-path'
import {
  createLocalAttachmentWorkspaceTarget,
  createLocalFileWorkspaceTarget,
} from '@/lib/workspace-target'
import type { RuntimeGoal } from '@/types/api'
import type { WorkspaceFileOpenOptions, WorkspaceTarget } from '@/types/workspace-files'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  formatEnvironmentReviewErrorMessage,
  type DesktopReviewMetadata,
} from '../desktopWorkbenchPaneTypes'
import {
  type RightWorkspaceChatTab,
  type RightWorkspacePanelTab,
} from '../workspace-panels/RightWorkspacePanel'

import type { usePaneWorkspaceResources } from './usePaneWorkspaceResources'

export function usePanePanelActions(context: ReturnType<typeof usePaneWorkspaceResources>) {
  const {
    onTerminalPanePinChange,
    paneActive,
    loadTurnFileChangesDiff,
    t,
    tChat,
    currentRuntimeTask,
    paneKey,
    paneSession,
    setSubagentArtifact,
    workspaceTarget,
    environmentInfo,
    loadEnvironmentDiff,
    devices,
    rightPanelOpen,
    setRightPanelOpen,
    rightPanelView,
    setRightPanelView,
    setRightPanelTabs,
    setEmbeddedBrowserUrl,
    setMigratedEmbeddedBrowserLabel,
    temporaryChatTabSequenceRef,
    setEmbeddedBrowserOpenRequest,
    setConversationSelectionInsertion,
    temporaryChatInitialInputsRef,
    setSelectedAssistantPlan,
    setBottomPanelOpenByKey,
    setOpenFileRequest,
    beginFileOpenRequest,
    setSelectedFileWorkspaceTargetKey,
    hasPreviousTurnReview,
    reviewState,
    setReviewState,
    embeddedBrowserLabel,
    canOpenRuntimeBrowser,
    effectiveWorkspaceTarget,
    canBrowseFiles,
    effectiveRightPanelTabs,
    setCurrentBottomPanelOpen,
    reviewRequestSequenceRef,
    previousTurnReviewRef,
    paneMessagesRef,
    paneIsBusy,
    latestPreviousTurnSubtaskId,
    openRightPanelTab,
  } = context
  const selectRightPanelTab = useCallback(
    (tab: RightWorkspacePanelTab) => {
      setRightPanelOpen(true)
      setRightPanelView(tab)
    },
    [setRightPanelOpen, setRightPanelView]
  )

  const openTemporaryChatTab = useCallback(
    (initialInput?: string) => {
      temporaryChatTabSequenceRef.current += 1
      const tab: RightWorkspaceChatTab = `chat:${Date.now()}-${temporaryChatTabSequenceRef.current}`
      if (initialInput) temporaryChatInitialInputsRef.current.set(tab, initialInput)
      openRightPanelTab(tab)
    },
    [openRightPanelTab, temporaryChatInitialInputsRef, temporaryChatTabSequenceRef]
  )

  useLayoutEffect(
    () =>
      paneActive
        ? subscribeDesktopFileAction('new-temporary-chat', () => openTemporaryChatTab())
        : undefined,
    [openTemporaryChatTab, paneActive]
  )

  const addSelectionToConversation = useCallback(
    (selectedText: string) => {
      setConversationSelectionInsertion(current => ({
        id: (current?.id ?? 0) + 1,
        text: selectedText,
      }))
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(
              '[data-testid="desktop-floating-composer-card"] [data-testid="chat-message-input"]'
            )
            ?.focus()
        })
      })
    },
    [setConversationSelectionInsertion]
  )

  const askSelectionInSidebar = useCallback(
    (selectedText: string) => openTemporaryChatTab(selectedText),
    [openTemporaryChatTab]
  )

  const embeddedBrowserListenerStateRef = useRef({
    embeddedBrowserLabel,
    openRightPanelTab,
  })

  useEffect(() => {
    embeddedBrowserListenerStateRef.current = {
      embeddedBrowserLabel,
      openRightPanelTab,
    }
  }, [embeddedBrowserLabel, openRightPanelTab])

  useEffect(() => {
    if (!paneActive) return
    const listener = listenEmbeddedBrowserOpenRequests(request => {
      const current = embeddedBrowserListenerStateRef.current
      if (request.label && request.label !== current.embeddedBrowserLabel) {
        if (request.label !== DEFAULT_EMBEDDED_BROWSER_LABEL) return
        setMigratedEmbeddedBrowserLabel(request.label)
      }
      setEmbeddedBrowserOpenRequest(previous => ({
        ...request,
        id: (previous?.id ?? 0) + 1,
      }))
      current.openRightPanelTab('browser')
    })

    return () => {
      void listener?.then(unlisten => unlisten())
    }
  }, [paneActive, setEmbeddedBrowserOpenRequest, setMigratedEmbeddedBrowserLabel])

  const openAssistantPlan = useCallback(
    (request: AssistantPlanOpenRequest) => {
      setSelectedAssistantPlan({
        blockId: request.blockId,
        subtaskId: request.subtaskId,
        fallbackContent: request.content,
      })
      openRightPanelTab('plan')
    },
    [openRightPanelTab, setSelectedAssistantPlan]
  )

  const closeRightPanelTab = useCallback(
    (tab: RightWorkspacePanelTab) => {
      if (tab.startsWith('chat:')) {
        temporaryChatInitialInputsRef.current.delete(tab as RightWorkspaceChatTab)
      }
      if (tab === 'files') {
        setOpenFileRequest(null)
      }
      if (tab === 'browser') {
        setEmbeddedBrowserUrl(null)
      }
      setRightPanelTabs(current => {
        const currentTabs = current.includes(tab) ? current : [...current, tab]
        const next = currentTabs.filter(openTab => openTab !== tab)
        if (next.length === 0) {
          setRightPanelOpen(false)
          setRightPanelView('launcher')
          return next
        }
        if (rightPanelView === tab) {
          setRightPanelView(next[next.length - 1])
        }
        return next
      })
    },
    [
      rightPanelView,
      setEmbeddedBrowserUrl,
      setOpenFileRequest,
      setRightPanelOpen,
      setRightPanelTabs,
      setRightPanelView,
      temporaryChatInitialInputsRef,
    ]
  )

  const openReviewFromDiffLoader = useCallback(
    async (
      loadDiff: () => Promise<{ diff: string; truncated: boolean }>,
      metadata: DesktopReviewMetadata = {}
    ) => {
      const requestId = reviewRequestSequenceRef.current + 1
      reviewRequestSequenceRef.current = requestId
      openRightPanelTab('review')
      setReviewState({
        loading: true,
        diff: '',
        diffTruncated: undefined,
        error: undefined,
        reviewTitle: metadata.reviewTitle,
        reviewMode: metadata.reviewMode,
        defaultFileTreeVisible: metadata.defaultFileTreeVisible,
        branchName: metadata.branchName,
        targetBranchName: metadata.targetBranchName,
        focusFilePath: metadata.focusFilePath,
        sourceSubtaskId: metadata.sourceSubtaskId,
        reloadDiff: loadDiff,
      })
      try {
        const { diff, truncated } = await loadDiff()
        if (reviewRequestSequenceRef.current === requestId) {
          setReviewState({
            loading: false,
            diff,
            diffTruncated: truncated,
            error: undefined,
            reviewTitle: metadata.reviewTitle,
            reviewMode: metadata.reviewMode,
            defaultFileTreeVisible: metadata.defaultFileTreeVisible,
            branchName: metadata.branchName,
            targetBranchName: metadata.targetBranchName,
            focusFilePath: metadata.focusFilePath,
            sourceSubtaskId: metadata.sourceSubtaskId,
            reloadDiff: loadDiff,
          })
        }
      } catch (error) {
        if (reviewRequestSequenceRef.current === requestId) {
          setReviewState({
            loading: false,
            diff: '',
            diffTruncated: undefined,
            error: formatEnvironmentReviewErrorMessage({
              error,
              fallbackMessage: t('workbench.environment_review_failed'),
              deviceUnavailableMessage: t('workbench.environment_review_device_unavailable'),
            }),
            reviewTitle: metadata.reviewTitle,
            reviewMode: metadata.reviewMode,
            defaultFileTreeVisible: metadata.defaultFileTreeVisible,
            branchName: metadata.branchName,
            targetBranchName: metadata.targetBranchName,
            focusFilePath: metadata.focusFilePath,
            sourceSubtaskId: metadata.sourceSubtaskId,
            reloadDiff: loadDiff,
          })
        }
      }
    },
    [openRightPanelTab, reviewRequestSequenceRef, setReviewState, t]
  )

  const openEnvironmentChangesReview = useCallback(
    async (mode: EnvironmentDiffMode = 'branch') => {
      await openReviewFromDiffLoader(
        async () => {
          if (!loadEnvironmentDiff || !workspaceTarget) {
            throw new Error(t('workbench.environment_review_unavailable'))
          }
          return { diff: await loadEnvironmentDiff(workspaceTarget, mode), truncated: false }
        },
        {
          reviewTitle: tChat(`file_changes.${mode}_label`),
          reviewMode: mode,
          branchName: environmentInfo.branchName,
        }
      )
    },
    [
      environmentInfo.branchName,
      loadEnvironmentDiff,
      openReviewFromDiffLoader,
      t,
      tChat,
      workspaceTarget,
    ]
  )

  const openDefaultEnvironmentChangesReview = useCallback(() => {
    void openEnvironmentChangesReview()
  }, [openEnvironmentChangesReview])

  const selectReviewView = useCallback(() => {
    if (reviewState.diff || reviewState.loading) {
      openRightPanelTab('review')
      return
    }

    void openEnvironmentChangesReview()
  }, [openEnvironmentChangesReview, openRightPanelTab, reviewState.diff, reviewState.loading])

  const selectFilesView = useCallback(() => {
    if (!canBrowseFiles) return
    openRightPanelTab('files')
  }, [canBrowseFiles, openRightPanelTab])

  const selectFileWorkspaceTarget = useCallback(
    (target: WorkspaceTarget) => {
      setSelectedFileWorkspaceTargetKey(`${target.deviceId}:${target.path}`)
      setOpenFileRequest(null)
    },
    [setOpenFileRequest, setSelectedFileWorkspaceTargetKey]
  )

  const selectBrowserView = useCallback(() => {
    if (!canOpenRuntimeBrowser) return
    openRightPanelTab('browser')
  }, [canOpenRuntimeBrowser, openRightPanelTab])

  const selectTerminalView = useCallback(() => {
    openRightPanelTab('terminal')
  }, [openRightPanelTab])

  const selectChatView = useCallback(() => {
    openTemporaryChatTab()
  }, [openTemporaryChatTab])

  const selectPlanView = useCallback(() => {
    openRightPanelTab('plan')
  }, [openRightPanelTab])

  const readSubagentArtifact = paneSession.readSubagentArtifact
  const openWorkspaceFileFromMessage = useCallback(
    async (path: string, options?: WorkspaceFileOpenOptions) => {
      const trimmedPath = path.trim()
      if (!trimmedPath) return
      const token = beginFileOpenRequest()
      // Sub-agent reports live inside the client storage tree, which is not a workspace root the
      // gateway can open a connection on; read them through the whitelisted artifact RPC instead.
      // Any miss (not a report, missing capability, unknown agent) falls through to the file panel.
      if (subagentArtifactKindFromPath(trimmedPath)) {
        const artifact = await readSubagentArtifact(trimmedPath)
        if (!token.isCurrent(effectiveWorkspaceTarget?.deviceId)) return
        if (artifact) {
          setSubagentArtifact({
            title: artifact.name || trimmedPath,
            content: artifact.content,
            truncated: artifact.truncated,
          })
          return
        }
      }
      const attachmentTarget = createLocalAttachmentWorkspaceTarget(trimmedPath, devices)
      const absoluteLocalTarget = createLocalFileWorkspaceTarget(trimmedPath, devices)
      let localTarget =
        attachmentTarget ??
        (absoluteLocalTarget &&
        (!effectiveWorkspaceTarget ||
          effectiveWorkspaceTarget.workspaceSource === 'local' ||
          effectiveWorkspaceTarget.deviceId === absoluteLocalTarget.deviceId)
          ? absoluteLocalTarget
          : null)
      let isDirectory = options?.isDirectory
      if (localTarget && isDirectory === undefined) {
        isDirectory = (await getLocalPathKind(trimmedPath)) === 'directory'
      }
      if (localTarget && isDirectory) {
        let directoryPath = trimmedPath.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
        try {
          directoryPath = normalizeAbsoluteWorkspacePath(trimmedPath, 'invalid directory path')
        } catch {
          // Keep the slash-normalized spelling for inputs that are not absolute.
        }
        localTarget = {
          ...localTarget,
          path: directoryPath,
        }
      }
      const resolvedTargetId = localTarget?.deviceId ?? effectiveWorkspaceTarget?.deviceId
      if (!token.isCurrent(resolvedTargetId)) return
      setOpenFileRequest({
        id: token.id,
        isCurrent: () => token.isCurrent(resolvedTargetId),
        path: trimmedPath,
        lineStart: options?.lineStart,
        lineEnd: options?.lineEnd,
        isDirectory,
        target: localTarget ?? undefined,
      })
      openRightPanelTab('files')
    },
    [
      devices,
      effectiveWorkspaceTarget,
      openRightPanelTab,
      readSubagentArtifact,
      beginFileOpenRequest,
      setOpenFileRequest,
      setSubagentArtifact,
    ]
  )

  const openLocalSkillFile = useCallback(
    (path: string) => {
      const trimmedPath = path.trim()
      if (!trimmedPath) return
      const target = createLocalFileWorkspaceTarget(trimmedPath, devices)
      if (!target) return
      const token = beginFileOpenRequest()
      setOpenFileRequest({
        id: token.id,
        isCurrent: () => token.isCurrent(target.deviceId),
        path: trimmedPath,
        target,
      })
      openRightPanelTab('files')
    },
    [beginFileOpenRequest, devices, openRightPanelTab, setOpenFileRequest]
  )

  const refreshReview = useCallback(() => {
    if (!reviewState.reloadDiff) return

    void openReviewFromDiffLoader(reviewState.reloadDiff, {
      reviewTitle: reviewState.reviewTitle,
      reviewMode: reviewState.reviewMode,
      defaultFileTreeVisible: reviewState.defaultFileTreeVisible,
      branchName: reviewState.branchName,
      targetBranchName: reviewState.targetBranchName,
      focusFilePath: reviewState.focusFilePath,
      sourceSubtaskId: reviewState.sourceSubtaskId,
    })
  }, [
    openReviewFromDiffLoader,
    reviewState.branchName,
    reviewState.defaultFileTreeVisible,
    reviewState.focusFilePath,
    reviewState.reloadDiff,
    reviewState.reviewMode,
    reviewState.reviewTitle,
    reviewState.sourceSubtaskId,
    reviewState.targetBranchName,
  ])

  const reviewViewOptions = useMemo(
    () => [
      {
        id: 'unstaged',
        label: tChat('file_changes.unstaged_label'),
        active: reviewState.reviewMode === 'unstaged',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('unstaged'),
      },
      {
        id: 'staged',
        label: tChat('file_changes.staged_label'),
        active: reviewState.reviewMode === 'staged',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('staged'),
      },
      {
        id: 'commit',
        label: tChat('file_changes.commit_label'),
        active: reviewState.reviewMode === 'commit',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('commit'),
      },
      {
        id: 'branch',
        label: tChat('file_changes.branch_label'),
        active: reviewState.reviewMode === 'branch',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('branch'),
      },
      {
        id: 'previous-turn',
        label: tChat('file_changes.previous_turn_label'),
        active: reviewState.reviewMode === 'previous-turn',
        disabled: latestPreviousTurnSubtaskId === null && !hasPreviousTurnReview,
        onSelect: () => {
          const previousTurn =
            latestPreviousTurnSubtaskId !== null
              ? {
                  loadDiff: () =>
                    loadTurnFileChangesDiff(
                      latestPreviousTurnSubtaskId,
                      paneMessagesRef.current,
                      undefined,
                      currentRuntimeTask
                    ),
                  defaultFileTreeVisible: false,
                  sourceSubtaskId: latestPreviousTurnSubtaskId,
                }
              : previousTurnReviewRef.current
          if (!previousTurn) return
          void openReviewFromDiffLoader(previousTurn.loadDiff, {
            reviewTitle: tChat('file_changes.previous_turn_label'),
            reviewMode: 'previous-turn',
            defaultFileTreeVisible: previousTurn.defaultFileTreeVisible,
            sourceSubtaskId: previousTurn.sourceSubtaskId,
          })
        },
      },
    ],
    [
      currentRuntimeTask,
      hasPreviousTurnReview,
      latestPreviousTurnSubtaskId,
      loadEnvironmentDiff,
      loadTurnFileChangesDiff,
      openEnvironmentChangesReview,
      openReviewFromDiffLoader,
      paneMessagesRef,
      previousTurnReviewRef,
      reviewState.reviewMode,
      tChat,
      workspaceTarget,
    ]
  )

  const fileChangesDiffPreviewDisabledSubtaskId =
    rightPanelOpen &&
    rightPanelView === 'review' &&
    reviewState.reviewMode === 'previous-turn' &&
    reviewState.sourceSubtaskId &&
    (reviewState.loading || Boolean(reviewState.diff))
      ? reviewState.sourceSubtaskId
      : null

  const toggleRightPanel = useCallback(() => {
    setRightPanelOpen(open => {
      const nextOpen = !open
      if (nextOpen) {
        setRightPanelView(current =>
          effectiveRightPanelTabs.includes(current as RightWorkspacePanelTab) ? current : 'launcher'
        )
      }
      return nextOpen
    })
  }, [effectiveRightPanelTabs, setRightPanelOpen, setRightPanelView])

  const toggleBottomPanel = useCallback(
    () => setCurrentBottomPanelOpen(open => !open),
    [setCurrentBottomPanelOpen]
  )

  const {
    pauseCurrentResponse: pauseCurrentResponseAction,
    compactContext: compactContextAction,
    setCurrentGoal: setCurrentGoalAction,
    pauseCurrentGoal: pauseCurrentGoalAction,
    resumeCurrentGoal: resumeCurrentGoalAction,
    clearCurrentGoal: clearCurrentGoalAction,
  } = paneSession

  const pauseCurrentResponse = useCallback(
    () => void pauseCurrentResponseAction(),
    [pauseCurrentResponseAction]
  )

  const shortenCurrentWait = useCallback(() => void paneSession.shortenCurrentWait(), [paneSession])

  const shortenWaitAvailable = paneIsBusy && paneSession.status.hasRunningShortenableTool

  const compactCurrentContext = useCallback(
    () => void compactContextAction(),
    [compactContextAction]
  )

  const setCurrentGoal = useCallback(
    (mode?: RuntimeGoal['mode']) => void setCurrentGoalAction(mode),
    [setCurrentGoalAction]
  )

  const pauseCurrentGoal = useCallback(
    () => void pauseCurrentGoalAction(),
    [pauseCurrentGoalAction]
  )

  const resumeCurrentGoal = useCallback(
    () => void resumeCurrentGoalAction(),
    [resumeCurrentGoalAction]
  )

  const clearCurrentGoal = useCallback(
    () => void clearCurrentGoalAction(),
    [clearCurrentGoalAction]
  )

  const closeBottomPanelContext = useCallback(
    (key: string) => {
      setBottomPanelOpenByKey(current => ({ ...current, [key]: false }))
    },
    [setBottomPanelOpenByKey]
  )

  const handleTerminalTabsEmpty = useCallback(() => {
    onTerminalPanePinChange(paneKey, 'bottom-panel', false)
  }, [onTerminalPanePinChange, paneKey])

  useEffect(() => {
    if (!paneActive) return
    const handleOpenTerminal = () => {
      toggleBottomPanel()
    }

    window.addEventListener(KCODER_STUDIO_OPEN_TERMINAL_EVENT, handleOpenTerminal)
    return () => window.removeEventListener(KCODER_STUDIO_OPEN_TERMINAL_EVENT, handleOpenTerminal)
  }, [paneActive, toggleBottomPanel])
  return {
    ...context,
    selectRightPanelTab,
    openTemporaryChatTab,
    addSelectionToConversation,
    askSelectionInSidebar,
    embeddedBrowserListenerStateRef,
    openAssistantPlan,
    closeRightPanelTab,
    openReviewFromDiffLoader,
    openEnvironmentChangesReview,
    openDefaultEnvironmentChangesReview,
    selectReviewView,
    selectFilesView,
    selectFileWorkspaceTarget,
    selectBrowserView,
    selectTerminalView,
    selectChatView,
    selectPlanView,
    openWorkspaceFileFromMessage,
    openLocalSkillFile,
    refreshReview,
    reviewViewOptions,
    fileChangesDiffPreviewDisabledSubtaskId,
    toggleRightPanel,
    toggleBottomPanel,
    pauseCurrentResponseAction,
    compactContextAction,
    setCurrentGoalAction,
    pauseCurrentGoalAction,
    resumeCurrentGoalAction,
    clearCurrentGoalAction,
    pauseCurrentResponse,
    shortenCurrentWait,
    shortenWaitAvailable,
    compactCurrentContext,
    setCurrentGoal,
    pauseCurrentGoal,
    resumeCurrentGoal,
    clearCurrentGoal,
    closeBottomPanelContext,
    handleTerminalTabsEmpty,
  }
}
