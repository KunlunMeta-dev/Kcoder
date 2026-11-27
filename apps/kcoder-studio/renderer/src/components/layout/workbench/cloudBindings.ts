import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { type LocalWorkItem } from '@/features/todo/todoModel'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { type PendingTodoBinding } from './types'
import { useCallback, useState } from 'react'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { isSameRuntimeTaskIdentity } from '@/features/workbench/workbenchRuntimeHelpers'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { runtimeThreadId } from '@/lib/runtime-thread-id'

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

export function usePendingCloudContext(address: RuntimeTaskAddress | null,
  api: WorkbenchServices['deliveryApi'], userId: number | undefined) {
  const [binding, setBinding] = useState(() => cloudBindingState.pendingTodoBinding)
  const owned = binding && binding.api === api && binding.userId === userId &&
    (address ? binding.target && isSameRuntimeTaskIdentity(binding.target, address) &&
      runtimeThreadId(binding.target) === runtimeThreadId(address) && binding.accountCurrent(address.deviceId)
      : !binding.target) ? binding : null
  const setPendingCloudContext = useCallback((project: CloudProject | null, item: CloudLoopItem | null) => {
    const next: PendingTodoBinding | null = project ? {
      project, item, target: null, api, userId, accountCurrent: captureAccountContextRevision(),
    } : null
    if (next || owned && cloudBindingState.pendingTodoBinding === owned) cloudBindingState.pendingTodoBinding = next
    setBinding(current => next || current === binding ? next : current)
  }, [api, binding, owned, userId])
  return { pendingCloudBinding: owned, pendingCloudProject: owned?.project ?? null,
    pendingTodoItem: owned?.item ?? null, setPendingCloudContext }
}

/** Retain the original mutation, including an unconfirmed failure; never replay it on remount. */
export function pendingBindingSubmission(binding: PendingTodoBinding, title: string | null | undefined) {
  const { api, target, item, project } = binding
  if (!api || !target) return
  binding.submission ??= Promise.resolve().then(() => {
    if (!binding.accountCurrent(target.deviceId)) throw new DOMException('Binding source changed', 'AbortError')
    return item ? api.bindTask(item.id, target, title) : api.bindProjectTask(project.id, target, title)
  })
  return binding.submission
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
