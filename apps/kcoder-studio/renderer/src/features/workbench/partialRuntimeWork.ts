import type {
  RuntimeDeviceWorkspace,
  RuntimeWorkListResponse,
  RuntimeTaskAddress,
} from '@/types/api'
import { workspacePathKey } from '@/lib/workspace-path-identity'
import { runtimeWorkContainsTask } from './workbenchRuntimeHelpers'

export function shouldRetainArchivedRuntimeTask(
  runtimeWork: RuntimeWorkListResponse,
  address: RuntimeTaskAddress
): boolean {
  return (
    runtimeWorkContainsTask(runtimeWork, address) ||
    [
      ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
      ...runtimeWork.chats,
    ].some(
      workspace =>
        workspace.deviceId === address.deviceId &&
        workspace.threadsComplete === false &&
        (!address.workspacePath ||
          workspacePathKey(workspace.workspacePath) === workspacePathKey(address.workspacePath))
    )
  )
}

function identity(workspace: RuntimeDeviceWorkspace): string {
  return JSON.stringify([
    workspace.deviceId,
    workspacePathKey(workspace.workspacePath),
    workspace.workspaceKind ?? 'workspace',
  ])
}

function preserveOrder<T>(previous: T[], incoming: T[], key: (item: T) => string): T[] {
  const remaining = new Map(incoming.map(item => [key(item), item]))
  const ordered: T[] = []
  for (const item of previous) {
    const id = key(item)
    const next = remaining.get(id)
    if (next !== undefined) {
      ordered.push(next)
      remaining.delete(id)
    }
  }
  return [...ordered, ...remaining.values()]
}

export function mergePartialRuntimeWork(
  previous: RuntimeWorkListResponse,
  incoming: RuntimeWorkListResponse,
  retainMissingWorkspaces = true
): RuntimeWorkListResponse {
  const previousWorkspaces = new Map(
    [...previous.projects.flatMap(project => project.deviceWorkspaces), ...previous.chats].map(
      workspace => [identity(workspace), workspace]
    )
  )
  const mergeWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => {
    const old = previousWorkspaces.get(identity(workspace))
    if (workspace.threadsComplete !== false || !old) return workspace
    const tasks = new Map(old.tasks.map(task => [task.taskId, task]))
    for (const task of workspace.tasks) tasks.set(task.taskId, task)
    return { ...workspace, tasks: [...tasks.values()] }
  }
  incoming = {
    ...incoming,
    projects: incoming.projects.map(project => ({
      ...project,
      deviceWorkspaces: project.deviceWorkspaces.map(mergeWorkspace),
    })),
    chats: incoming.chats.map(mergeWorkspace),
  }
  const refreshed = new Set(
    [...incoming.projects.flatMap(project => project.deviceWorkspaces), ...incoming.chats].map(
      identity
    )
  )
  // Scan scheduling completion can remove absent workspaces, never partial workspace tasks.
  const retained = {
    projects: previous.projects
      .map(project => ({
        ...project,
        deviceWorkspaces: project.deviceWorkspaces.filter(
          workspace => retainMissingWorkspaces && !refreshed.has(identity(workspace))
        ),
      }))
      .filter(project => project.deviceWorkspaces.length > 0),
    chats: previous.chats.filter(
      workspace => retainMissingWorkspaces && !refreshed.has(identity(workspace))
    ),
    totalTasks: 0,
  }
  const projects = new Map(retained.projects.map(project => [project.project.key, project]))
  const previousProjects = new Map(previous.projects.map(project => [project.project.key, project]))
  for (const project of incoming.projects) {
    const existing = projects.get(project.project.key)
    const deviceWorkspaces = preserveOrder(
      previousProjects.get(project.project.key)?.deviceWorkspaces ?? [],
      [...(existing?.deviceWorkspaces ?? []), ...project.deviceWorkspaces],
      identity
    )
    projects.set(project.project.key, {
      ...project,
      deviceWorkspaces,
      totalTasks: deviceWorkspaces.reduce((sum, workspace) => sum + workspace.tasks.length, 0),
    })
  }
  // IO completion order is not a user-requested sidebar reorder.
  const chats = preserveOrder(previous.chats, [...retained.chats, ...incoming.chats], identity)
  const result = preserveOrder(
    previous.projects,
    [...projects.values()],
    project => project.project.key
  )
  return {
    projects: result,
    chats,
    totalTasks: [...result.flatMap(project => project.deviceWorkspaces), ...chats].reduce(
      (sum, workspace) => sum + workspace.tasks.length,
      0
    ),
  }
}
