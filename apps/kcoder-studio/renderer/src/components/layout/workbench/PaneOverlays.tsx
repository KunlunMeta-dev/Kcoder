import { useMemo } from 'react'
import {
  RequestUserInputCard,
  type RequestUserInputPayload,
} from '@/components/chat/RequestUserInputCard'
import {
  isPendingRequestUserInputBlock,
  requestUserInputPayloadKey,
} from '@/components/chat/requestUserInputMessages'
import { SubagentWorkspace } from '@/features/subagents/SubagentWorkspace'
import { ContinueInImDialog } from '@/components/chat/ContinueInImDialog'
import { SubagentArtifactDrawer } from '@/components/chat/SubagentArtifactDrawer'
import { TransientNotice } from '@/components/common/TransientNotice'
import { DeliveryDialog } from '@/features/delivery/DeliveryDialog'
import { TaskFeedbackDialog } from '@/features/feedback/TaskFeedbackDialog'
import { TodoBindingPicker } from '@/features/todo/TodoBindingPicker'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'
import { TaskForkDialog } from '../TaskForkDialog'
import { cloudItemAsLocalWorkItem } from './cloudBindings'
import type { usePaneChrome } from './usePaneChrome'

const NO_INTERACTIONS: React.ReactNode[] = []

export function PaneOverlays({ model }: { model: ReturnType<typeof usePaneChrome> }) {
  const {
    subagentWorkspaceHost,
    paneMessages,
    forkCurrentRuntimeTask,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
    services,
    currentRuntimeTask,
    currentProject,
    paneSession,
    subagentArtifact,
    setSubagentArtifact,
    setDeliveryItem,
    boundCloudProject,
    setBoundCloudProject,
    boundCloudItem,
    setBoundCloudItem,
    deliveryDialogOpen,
    setDeliveryDialogOpen,
    todoBindingPickerOpen,
    setTodoBindingPickerOpen,
    deliverAfterBinding,
    setDeliverAfterBinding,
    pendingTodoItem,
    pendingCloudProject,
    todoBindingError,
    setTodoBindingError,
    cloudActionNotice,
    setCloudActionNotice,
    runtimeWork,
    runtimeTaskTitle,
    setPendingCloudContext,
    activeDeliveryItem,
    finishLocalDelivery,
    devices,
    forkDialogOpen,
    setForkDialogOpen,
    feedbackDialogOpen,
    setFeedbackDialogOpen,
    continueInIm,
    paneIsBusy,
  } = model
  const { sourceMatches } = subagentWorkspaceHost
  const { answeredRequestUserInputIds, sendRequestUserInputResponse, ignoreRequestUserInput } =
    paneSession
  const workspaceOpen = subagentWorkspaceHost.workspace !== null
  // A stable value keeps the memoized subagent workspace from re-rendering for every
  // parent-pane update; an empty list keeps the host-owned interaction mode.
  const subagentInteractions = useMemo(() => {
    if (!workspaceOpen) return NO_INTERACTIONS
    const cards = paneMessages.flatMap(message =>
      (message.blocks ?? []).flatMap(block => {
        if (!isPendingRequestUserInputBlock(block, answeredRequestUserInputIds)) return []
        const payload = block.renderPayload as RequestUserInputPayload
        if (!sourceMatches(payload.sourceAgent)) return []
        return [
          <RequestUserInputCard
            key={requestUserInputPayloadKey(payload) ?? block.id}
            payload={payload}
            onSubmit={response => sendRequestUserInputResponse(response)}
            onIgnore={() => ignoreRequestUserInput(payload)}
          />,
        ]
      })
    )
    return cards.length > 0 ? cards : NO_INTERACTIONS
  }, [
    workspaceOpen,
    paneMessages,
    answeredRequestUserInputIds,
    sourceMatches,
    sendRequestUserInputResponse,
    ignoreRequestUserInput,
  ])
  return (
    <>
      <TaskForkDialog
        key={forkDialogOpen ? `open-${currentRuntimeTask?.taskId ?? 'none'}` : 'closed'}
        open={forkDialogOpen}
        source={currentRuntimeTask}
        runtimeWork={runtimeWork}
        currentProject={currentProject}
        devices={devices}
        requiresStop={paneIsBusy}
        onOpenChange={setForkDialogOpen}
        onStopCurrentResponse={() => paneSession.pauseCurrentResponse()}
        onPrepareDeviceWorkspace={prepareDeviceWorkspace}
        onDeleteDeviceWorkspace={deleteDeviceWorkspace}
        onGetDeviceHomeDirectory={getDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={getProjectWorkspaceRoot}
        onListDeviceDirectories={listDeviceDirectories}
        onCreateDeviceDirectory={createDeviceDirectory}
        onFork={async target => {
          await forkCurrentRuntimeTask(target, { onError: paneSession.reportError })
        }}
      />
      <ContinueInImDialog
        key={continueInIm.dialog.open ? 'continue-im-open' : 'continue-im-closed'}
        {...continueInIm.dialog}
      />
      <TaskFeedbackDialog
        target={currentRuntimeTask ?? undefined}
        open={feedbackDialogOpen}
        onClose={() => setFeedbackDialogOpen(false)}
        getTaskContext={async () => {
          const messages = await paneSession.loadFullTranscriptForExport()
          return {
            task: {
              taskId: currentRuntimeTask?.taskId ?? null,
              deviceId: currentRuntimeTask?.deviceId ?? null,
              threadId: currentRuntimeTask?.threadId ?? null,
              workspacePath: currentRuntimeTask?.workspacePath ?? null,
              title: runtimeTaskTitle ?? messages.find(message => message.role === 'user')?.content,
              status: findRuntimeTask(runtimeWork, currentRuntimeTask)?.status ?? null,
            },
            conversation: {
              messages,
              queuedMessages: paneSession.queuedMessages,
              guidanceMessages: paneSession.guidanceMessages,
              turnNavigation: paneSession.turnNavigation,
            },
            runtime: {
              status: paneSession.status,
              goal: paneSession.goal,
              taskPlan: paneSession.taskPlan,
              subagentStatuses: paneSession.subagentStatuses,
            },
          }
        }}
      />
      <TransientNotice
        message={continueInIm.notice?.message ?? null}
        tone={continueInIm.notice?.tone}
        onClear={continueInIm.clearNotice}
      />
      <TransientNotice
        message={todoBindingError}
        tone="error"
        onClear={() => setTodoBindingError(null)}
      />
      <TransientNotice message={cloudActionNotice} onClear={() => setCloudActionNotice(null)} />
      {deliveryDialogOpen && activeDeliveryItem && currentRuntimeTask && services?.deliveryApi && (
        <DeliveryDialog
          item={activeDeliveryItem}
          runtimeTask={currentRuntimeTask}
          runtimeTaskTitle={runtimeTaskTitle}
          messages={paneSession.messages}
          deliveryApi={services.deliveryApi}
          onCancel={() => setDeliveryDialogOpen(false)}
          onDelivered={() => void finishLocalDelivery()}
        />
      )}
      {subagentWorkspaceHost.workspace && (
        <SubagentWorkspace
          key={`${currentRuntimeTask?.deviceId}:${currentRuntimeTask?.taskId}:${subagentWorkspaceHost.workspace.agent.agentId}`}
          {...subagentWorkspaceHost.workspace}
          className={model.showPageTopBar ? 'top-11' : undefined}
          interactions={subagentInteractions}
        />
      )}
      <SubagentArtifactDrawer
        open={subagentArtifact !== null}
        title={subagentArtifact?.title ?? ''}
        content={subagentArtifact?.content ?? ''}
        truncated={subagentArtifact?.truncated ?? false}
        loading={false}
        error={null}
        onClose={() => setSubagentArtifact(null)}
      />
      {todoBindingPickerOpen && services?.deliveryApi && (
        <TodoBindingPicker
          api={services.deliveryApi}
          runtimeTask={currentRuntimeTask ?? undefined}
          runtimeTaskTitle={runtimeTaskTitle}
          currentProject={currentRuntimeTask ? boundCloudProject : pendingCloudProject}
          currentItem={currentRuntimeTask ? boundCloudItem : pendingTodoItem}
          onClose={() => {
            setTodoBindingPickerOpen(false)
            setDeliverAfterBinding(false)
          }}
          onBound={(project, item) => {
            if (!currentRuntimeTask) {
              setPendingCloudContext(project, item)
              setTodoBindingPickerOpen(false)
              return
            }
            setBoundCloudProject(project)
            setBoundCloudItem(item)
            setDeliveryItem(item ? cloudItemAsLocalWorkItem(item, currentRuntimeTask) : null)
            setTodoBindingPickerOpen(false)
            if (item && deliverAfterBinding) setDeliveryDialogOpen(true)
            setDeliverAfterBinding(false)
          }}
        />
      )}
    </>
  )
}
