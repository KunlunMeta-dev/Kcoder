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

export function PaneOverlays({ model }: { model: ReturnType<typeof usePaneChrome> }) {
  const {
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
          await forkCurrentRuntimeTask(target)
        }}
      />
      <ContinueInImDialog
        key={continueInIm.dialog.open ? 'continue-im-open' : 'continue-im-closed'}
        {...continueInIm.dialog}
      />
      <TaskFeedbackDialog
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
