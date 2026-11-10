import { Suspense, lazy, type ReactNode } from 'react'
import { PageLoadingState } from './PageLoadingState'

// Feature modules load only when opened; the conversation remains resident.
export const DeferredExpertsPage = lazy(() =>
  import('@/features/experts/ExpertsPage').then(module => ({ default: module.ExpertsPage }))
)
export const DeferredChannelsPage = lazy(() =>
  import('@/features/connectivity/ChannelsPage').then(module => ({ default: module.ChannelsPage }))
)
export const DeferredPersonalizationPage = lazy(() =>
  import('@/features/experts/PersonalizationPage').then(module => ({
    default: module.PersonalizationPage,
  }))
)
export const DeferredSettingsPage = lazy(() =>
  import('@/components/settings/ConnectionsSettingsPage').then(module => ({
    default: module.ConnectionsSettingsPage,
  }))
)
export const DeferredMobileSettingsPage = lazy(() =>
  import('@/components/settings/MobileSettingsPage').then(module => ({
    default: module.MobileSettingsPage,
  }))
)
export const DeferredKnowledgeWorkspace = lazy(() =>
  import('@/features/knowledge/KnowledgeWorkspace').then(module => ({
    default: module.KnowledgeWorkspace,
  }))
)
export const DeferredMemoryWorkspace = lazy(() =>
  import('@/features/runtime-governance/MemoryWorkspace').then(module => ({
    default: module.MemoryWorkspace,
  }))
)
export const DeferredTaskWorkspace = lazy(() =>
  import('@/features/task-workspace/TaskWorkspacePage').then(module => ({
    default: module.TaskWorkspacePage,
  }))
)
export const DeferredWorkflowWorkspace = lazy(() =>
  import('@/features/workflows/WorkflowWorkspace').then(module => ({
    default: module.WorkflowWorkspace,
  }))
)
export const DeferredScheduledTasks = lazy(() =>
  import('@/components/chat/ScheduledTasksPanel').then(module => ({
    default: module.ScheduledTasksPanel,
  }))
)
export const DeferredCloudTodoWorkspace = lazy(() =>
  import('@/features/todo/CloudTodoWorkspace').then(module => ({
    default: module.CloudTodoWorkspace,
  }))
)

export function DeferredWorkbenchPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageLoadingState />}>{children}</Suspense>
}
