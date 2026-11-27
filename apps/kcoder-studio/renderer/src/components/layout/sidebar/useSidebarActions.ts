import type { ArchiveRuntimeTaskOptions } from '@/features/workbench/workbenchContextTypes'
import type { RuntimeTaskAddress, RuntimeTaskPinRequest } from '@/types/api'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { getRuntimeSidebarTaskItems } from '../runtimeTaskSidebarHelpers'
import { getRuntimeTaskThreadId } from './sidebarSelectors'
import type { DesktopSidebarProps, RuntimeTaskPinOverride } from './types'
import { getRuntimeTaskPinOverrideKey } from './types'

interface PinActionContext {
  onSetRuntimeTaskPinned: DesktopSidebarProps['onSetRuntimeTaskPinned']
  chatTaskItems: ReturnType<typeof getRuntimeSidebarTaskItems>
  chatTaskPinRequestIdRef: RefObject<number>
  setChatTaskPinOverrides: Dispatch<SetStateAction<Map<string, RuntimeTaskPinOverride>>>
  runtimeWork: DesktopSidebarProps['runtimeWork']
}
interface ArchiveActionContext {
  onArchiveProjectsConversations: DesktopSidebarProps['onArchiveProjectsConversations']
  onArchiveChatConversations: DesktopSidebarProps['onArchiveChatConversations']
  projectSectionArchiveKeys: string[]
  chatSectionArchiveAddresses: RuntimeTaskAddress[]
  setIsArchivingProjectSection: Dispatch<SetStateAction<boolean>>
  setIsArchivingChatSection: Dispatch<SetStateAction<boolean>>
  setArchiveSectionMode: Dispatch<SetStateAction<'projects' | 'chats' | null>>
  setForceArchiveSectionMode: Dispatch<SetStateAction<'projects' | 'chats' | null>>
}

// These callbacks deliberately retain each render's values, as in the original
// component. State and request IDs remain owned by useSidebarModel.
export function useSidebarTaskPinAction({
  onSetRuntimeTaskPinned,
  chatTaskItems,
  chatTaskPinRequestIdRef,
  setChatTaskPinOverrides,
  runtimeWork,
}: PinActionContext) {
  const setChatTaskPinned = async (data: RuntimeTaskPinRequest) => {
    if (!onSetRuntimeTaskPinned) return
    const chatTask = chatTaskItems.find(
      ({ workspace, task }) =>
        workspace.deviceId === data.deviceId && getRuntimeTaskThreadId(task) === data.threadId
    )
    if (!chatTask) {
      await onSetRuntimeTaskPinned(data)
      return
    }

    const key = getRuntimeTaskPinOverrideKey(data.deviceId, data.threadId)
    const requestId = ++chatTaskPinRequestIdRef.current
    const base = Boolean(chatTask.task.pinned)
    setChatTaskPinOverrides(current => {
      const next = new Map(current)
      next.set(key, { base, value: data.pinned, requestId, source: runtimeWork })
      return next
    })
    try {
      await onSetRuntimeTaskPinned(data)
    } catch (error) {
      setChatTaskPinOverrides(current => {
        if (current.get(key)?.requestId !== requestId) return current
        const next = new Map(current)
        next.delete(key)
        return next
      })
      throw error
    }
  }
  return setChatTaskPinned
}
export function useSidebarArchiveAction({
  onArchiveProjectsConversations,
  onArchiveChatConversations,
  projectSectionArchiveKeys,
  chatSectionArchiveAddresses,
  setIsArchivingProjectSection,
  setIsArchivingChatSection,
  setArchiveSectionMode,
  setForceArchiveSectionMode,
}: ArchiveActionContext) {
  const runArchiveSectionConversations = async (
    mode: 'projects' | 'chats',
    options?: ArchiveRuntimeTaskOptions
  ) => {
    if (mode === 'projects') {
      if (!onArchiveProjectsConversations || projectSectionArchiveKeys.length === 0) return
      setIsArchivingProjectSection(true)
      try {
        const result = await onArchiveProjectsConversations(projectSectionArchiveKeys, options)
        if (result?.status === 'dirty_worktree') {
          setArchiveSectionMode(null)
          setForceArchiveSectionMode('projects')
          return
        }
        setArchiveSectionMode(null)
        setForceArchiveSectionMode(null)
      } finally {
        setIsArchivingProjectSection(false)
      }
      return
    }

    if (mode === 'chats') {
      if (!onArchiveChatConversations || chatSectionArchiveAddresses.length === 0) return
      setIsArchivingChatSection(true)
      try {
        const result = await onArchiveChatConversations(chatSectionArchiveAddresses, options)
        if (result?.status === 'dirty_worktree') {
          setArchiveSectionMode(null)
          setForceArchiveSectionMode('chats')
          return
        }
        setArchiveSectionMode(null)
        setForceArchiveSectionMode(null)
      } finally {
        setIsArchivingChatSection(false)
      }
    }
  }
  return runArchiveSectionConversations
}
