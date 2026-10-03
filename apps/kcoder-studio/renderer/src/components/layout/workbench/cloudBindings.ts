import type { CloudLoopItem } from '@/api/deliveries'
import { type LocalWorkItem } from '@/features/todo/todoModel'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { type PendingTodoBinding } from './types'

export function cloudItemAsLocalWorkItem(
  item: CloudLoopItem,
  runtimeTask: RuntimeTaskAddress
): Omit<LocalWorkItem, 'projectId'> {
  return {
    id: item.id,
    title: item.title,
    objective: '',
    description: item.description,
    state:
      item.status === 'completed'
        ? 'completed'
        : item.status === 'in_review'
          ? 'review'
          : item.status === 'in_progress'
            ? 'started'
            : 'backlog',
    assignee: item.assignee_user_id
      ? { type: 'human', id: String(item.assignee_user_id) }
      : { type: 'unassigned' },
    collaborators: [],
    blocker: '',
    nextAction: '',
    priority: item.priority === 'medium' ? 'normal' : item.priority,
    attachments: [],
    runtimeRefs: [runtimeTask],
    events: [],
    sortOrder: item.sort_order,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }
}

export const cloudBindingState = { pendingTodoBinding: null as PendingTodoBinding | null }

export function pendingTodoForTask(address: RuntimeTaskAddress | null) {
  if (!cloudBindingState.pendingTodoBinding) return null
  if (!address)
    return cloudBindingState.pendingTodoBinding.target
      ? null
      : cloudBindingState.pendingTodoBinding.item
  const target = cloudBindingState.pendingTodoBinding.target
  return target?.deviceId === address.deviceId && target.taskId === address.taskId
    ? cloudBindingState.pendingTodoBinding.item
    : null
}

export function pendingProjectForTask(address: RuntimeTaskAddress | null) {
  if (!cloudBindingState.pendingTodoBinding) return null
  if (!address)
    return cloudBindingState.pendingTodoBinding.target
      ? null
      : cloudBindingState.pendingTodoBinding.project
  const target = cloudBindingState.pendingTodoBinding.target
  return target?.deviceId === address.deviceId && target.taskId === address.taskId
    ? cloudBindingState.pendingTodoBinding.project
    : null
}

export function cloudLoopItemStatusLabel(
  status: CloudLoopItem['status'],
  t: ReturnType<typeof useTranslation>['t']
): string {
  switch (status) {
    case 'inbox':
      return t('workbench.cloud_todo_status_inbox', '收集箱')
    case 'pending':
      return t('workbench.cloud_todo_status_pending', '待处理')
    case 'in_progress':
      return t('workbench.cloud_todo_status_in_progress', '进行中')
    case 'in_review':
      return t('workbench.cloud_todo_status_in_review', '待评审')
    case 'completed':
      return t('workbench.cloud_todo_status_completed', '已完成')
  }
}
