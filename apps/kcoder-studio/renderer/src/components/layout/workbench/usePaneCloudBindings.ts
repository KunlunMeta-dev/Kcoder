import type { CloudProject } from '@/api/deliveries'
import type { ChatSubmitOptions } from '@/components/chat/ChatInput'
import type { ComposerCloudMentionCandidate } from '@/components/chat/composer/composerMentionCandidates'
import {
  hydrateLocalWorkItems,
  loadLocalWorkItems,
  saveLocalWorkItems,
} from '@/features/todo/todoModel'
import { navigateTo } from '@/lib/navigation'
import { useCallback, useEffect, useMemo } from 'react'
import {
  cloudBindingState,
  cloudItemAsLocalWorkItem,
  cloudLoopItemStatusLabel,
} from './cloudBindings'
import type { usePaneIdentity } from './usePaneIdentity'

export function usePaneCloudBindings(context: ReturnType<typeof usePaneIdentity>) {
  const {
    state,
    services,
    t,
    currentRuntimeTask,
    sendPaneInput,
    deliveryItem,
    setDeliveryItem,
    setBoundCloudProject,
    setBoundCloudItem,
    setDeliveryDialogOpen,
    pendingTodoItem,
    pendingCloudProject,
    setTodoBindingError,
    cloudProjects,
    setCloudProjects,
    setCloudActionNotice,
    cloudMentionState,
    setCloudMentionState,
    runtimeTaskTitle,
    composerCloudProject,
    composerTodoItem,
    cloudAdditionalContext,
    setPendingCloudContext,
  } = context
  const submitPaneInput = useCallback(
    (value?: string, options?: ChatSubmitOptions) =>
      sendPaneInput(value, {
        ...options,
        additionalContext: cloudAdditionalContext,
        onRuntimeTaskCreated: address => {
          if (!cloudBindingState.pendingTodoBinding) return
          cloudBindingState.pendingTodoBinding = {
            ...cloudBindingState.pendingTodoBinding,
            target: address,
          }
        },
      }),
    [cloudAdditionalContext, sendPaneInput]
  )

  // Cloud services are optional in local-only workbench contexts.
  const deliveryApi = services?.deliveryApi

  useEffect(() => {
    let active = true
    if (!currentRuntimeTask) {
      queueMicrotask(() => {
        if (!active) return
        setBoundCloudItem(null)
        setBoundCloudProject(null)
        setDeliveryItem(null)
      })
      return () => {
        active = false
      }
    }
    if (deliveryApi) {
      void deliveryApi
        .findCloudContextForTask(currentRuntimeTask)
        .then(context => {
          if (!active) return
          setBoundCloudProject(context.project)
          setBoundCloudItem(context.loop_item)
          setDeliveryItem(
            context.loop_item
              ? cloudItemAsLocalWorkItem(context.loop_item, currentRuntimeTask)
              : null
          )
        })
        .catch(() => {
          if (active) {
            setBoundCloudItem(null)
            setBoundCloudProject(null)
            setDeliveryItem(null)
          }
        })
      return () => {
        active = false
      }
    }
    void hydrateLocalWorkItems(state.user?.id).then(items => {
      if (!active) return
      setBoundCloudItem(null)
      setDeliveryItem(
        items.find(item =>
          item.runtimeRefs.some(
            reference =>
              reference.taskId === currentRuntimeTask.taskId &&
              reference.deviceId === currentRuntimeTask.deviceId
          )
        ) ?? null
      )
    })
    return () => {
      active = false
    }
  }, [
    currentRuntimeTask,
    deliveryApi,
    setBoundCloudItem,
    setBoundCloudProject,
    setDeliveryItem,
    state.user?.id,
  ])

  useEffect(() => {
    if (!currentRuntimeTask || !pendingCloudProject || !deliveryApi) return
    let active = true
    const bindingRequest = pendingTodoItem
      ? deliveryApi.bindTask(pendingTodoItem.id, currentRuntimeTask, runtimeTaskTitle)
      : deliveryApi.bindProjectTask(pendingCloudProject.id, currentRuntimeTask, runtimeTaskTitle)
    void bindingRequest
      .then(() => {
        if (!active) return
        setBoundCloudProject(pendingCloudProject)
        setBoundCloudItem(pendingTodoItem)
        setDeliveryItem(
          pendingTodoItem ? cloudItemAsLocalWorkItem(pendingTodoItem, currentRuntimeTask) : null
        )
        cloudBindingState.pendingTodoBinding = null
        setPendingCloudContext(null, null)
      })
      .catch(cause => {
        if (!active) return
        setTodoBindingError(cause instanceof Error ? cause.message : '关联项目空间失败')
      })
    return () => {
      active = false
    }
  }, [
    currentRuntimeTask,
    pendingCloudProject,
    pendingTodoItem,
    runtimeTaskTitle,
    deliveryApi,
    setBoundCloudItem,
    setBoundCloudProject,
    setDeliveryItem,
    setPendingCloudContext,
    setTodoBindingError,
  ])

  useEffect(() => {
    let active = true
    const api = deliveryApi
    if (!api || !composerCloudProject) {
      return () => {
        active = false
      }
    }
    const projectId = composerCloudProject.id
    void Promise.all([
      api.listCloudFiles(projectId),
      api.listLoopItems(projectId),
      composerTodoItem ? api.listDeliveries(composerTodoItem.id) : Promise.resolve({ items: [] }),
    ])
      .then(([files, items, deliveries]) => {
        if (!active) return
        const candidate = (
          key: string,
          title: string,
          description: string,
          reference: string,
          aliases: string[],
          statusLabel?: string
        ): ComposerCloudMentionCandidate => ({
          kind: 'cloud',
          key,
          title,
          description,
          metaLabel: t('workbench.mention_cloud_space', '云空间'),
          testId: key.replace(/[^a-zA-Z0-9_-]/g, '-'),
          enabled: true,
          reference,
          searchAliases: aliases,
          statusLabel,
        })
        setCloudMentionState({
          todoId: composerTodoItem?.id ?? `project:${projectId}`,
          candidates: [
            candidate(
              `cloud-project:${projectId}`,
              t('workbench.mention_cloud_whole_space', '整个空间'),
              t('workbench.mention_cloud_whole_space_description', '共享文件 + 看板全部内容'),
              `[$${t('workbench.mention_cloud_whole_space', '整个空间')}](cloud://projects/${projectId})`,
              ['云项目', 'cloud', 'workspace']
            ),
            ...items.items.map(item =>
              candidate(
                `cloud-todo:${item.id}`,
                item.id,
                item.title,
                `[$${t('workbench.mention_cloud_todo_chip', '任务')}:${item.id}](cloud://projects/${projectId}/todos/${item.id})`,
                [item.title, item.status, 'TODO', '任务'],
                cloudLoopItemStatusLabel(item.status, t)
              )
            ),
            ...files.items.map(file =>
              candidate(
                `cloud-file:${file.id}`,
                file.name,
                file.path,
                `[$${file.name}](cloud://projects/${projectId}/files/${file.id})`,
                [file.path, file.kind, '文件', '目录']
              )
            ),
            ...deliveries.items.map(delivery =>
              candidate(
                `cloud-delivery:${delivery.id}`,
                `交付 ${delivery.id.slice(0, 8)}`,
                delivery.delivered_at ?? delivery.created_at,
                `[$交付 ${delivery.id.slice(0, 8)}](cloud://projects/${projectId}/deliveries/${delivery.id})`,
                ['交付', 'delivery', delivery.id]
              )
            ),
          ],
        })
      })
      .catch(() => {
        if (active) setCloudMentionState(null)
      })
    return () => {
      active = false
    }
  }, [composerCloudProject, composerTodoItem, deliveryApi, setCloudMentionState, t])

  const visibleCloudMentionCandidates =
    composerCloudProject &&
    cloudMentionState?.todoId === (composerTodoItem?.id ?? `project:${composerCloudProject.id}`)
      ? cloudMentionState.candidates
      : []

  useEffect(() => {
    let active = true
    const api = deliveryApi
    if (!api) {
      queueMicrotask(() => {
        if (active) setCloudProjects([])
      })
      return () => {
        active = false
      }
    }
    void api
      .listCloudProjects()
      .then(result => {
        if (active) setCloudProjects(result.items)
      })
      .catch(() => {
        if (active) setCloudProjects([])
      })
    return () => {
      active = false
    }
  }, [deliveryApi, setCloudProjects])

  const cloudProjectMentionCandidates = useMemo<ComposerCloudMentionCandidate[]>(
    () =>
      cloudProjects.map(project => {
        const spaceLabel = t('workbench.mention_cloud_project_space', '项目空间')
        return {
          kind: 'cloud',
          key: `cloud-project-space:${project.id}`,
          title: project.name,
          description: project.description || project.project_key || undefined,
          metaLabel: t('workbench.mention_cloud_space', '云空间'),
          testId: `cloud-project-space-${String(project.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`,
          enabled: true,
          reference: `[$${spaceLabel}:${project.name}](cloud://projects/${project.id})`,
          searchAliases: [
            project.name,
            project.project_key,
            project.description,
            spaceLabel,
            'project space',
            'project-space',
            'cloud',
          ].filter(alias => Boolean(alias)),
          project,
        }
      }),
    [cloudProjects, t]
  )

  const bindComposerCloudProject = useCallback(
    (project: CloudProject, notice: string) => {
      setCloudActionNotice(notice)
      if (!currentRuntimeTask) {
        setPendingCloudContext(project, null)
        return
      }
      const api = deliveryApi
      if (!api) return
      void api
        .bindProjectTask(project.id, currentRuntimeTask, runtimeTaskTitle)
        .then(() => {
          setBoundCloudProject(project)
          setBoundCloudItem(null)
          setDeliveryItem(null)
        })
        .catch(cause => {
          setTodoBindingError(
            cause instanceof Error
              ? cause.message
              : t('workbench.cloud_project_bind_failed', '关联项目空间失败')
          )
        })
    },
    [
      currentRuntimeTask,
      runtimeTaskTitle,
      deliveryApi,
      setBoundCloudItem,
      setBoundCloudProject,
      setCloudActionNotice,
      setDeliveryItem,
      setPendingCloudContext,
      setTodoBindingError,
      t,
    ]
  )

  const handleSelectCloudProject = useCallback(
    (project: CloudProject) => {
      bindComposerCloudProject(
        project,
        t('workbench.cloud_project_bound_notice', { name: project.name })
      )
    },
    [bindComposerCloudProject, t]
  )

  const activeDeliveryItem =
    currentRuntimeTask &&
    deliveryItem?.runtimeRefs.some(
      reference =>
        reference.taskId === currentRuntimeTask.taskId &&
        reference.deviceId === currentRuntimeTask.deviceId
    )
      ? deliveryItem
      : null

  const finishLocalDelivery = useCallback(async () => {
    if (!activeDeliveryItem) return
    const items = await loadLocalWorkItems(state.user?.id)
    const now = new Date().toISOString()
    await saveLocalWorkItems(
      state.user?.id,
      items.map(item =>
        item.id === activeDeliveryItem.id
          ? {
              ...item,
              state: 'completed',
              updatedAt: now,
              events: [
                ...item.events,
                {
                  id: `delivery-${now}`,
                  type: 'confirmed' as const,
                  summary: t('delivery.completed_activity', '任务已交付并完成'),
                  createdAt: now,
                },
              ],
            }
          : item
      )
    )
    setDeliveryDialogOpen(false)
    navigateTo('/todo')
  }, [activeDeliveryItem, setDeliveryDialogOpen, state.user?.id, t])
  return {
    ...context,
    submitPaneInput,
    visibleCloudMentionCandidates,
    cloudProjectMentionCandidates,
    bindComposerCloudProject,
    handleSelectCloudProject,
    activeDeliveryItem,
    finishLocalDelivery,
  }
}
