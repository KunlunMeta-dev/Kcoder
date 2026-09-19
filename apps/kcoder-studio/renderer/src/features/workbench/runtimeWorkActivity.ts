import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'

const activityObservation = Symbol('runtime-work-activity')
const snapshotObservation = Symbol('runtime-work-snapshot')
let latestRevision = 0
type ObservedTask = RuntimeTaskSummary & {
  [activityObservation]?: { revision: number; running?: boolean }
  [snapshotObservation]?: number
}

export function stampRuntimeWorkSnapshot(
  snapshot: RuntimeWorkListResponse,
  watermark: number
): RuntimeWorkListResponse {
  const stampWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => {
    // A fulfilled directory response may still contain an offline last-good workspace.
    if (workspace.available === false || workspace.deviceStatus === 'offline' || workspace.error) return workspace
    return { ...workspace, tasks: workspace.tasks.map(task => ({ ...task, [snapshotObservation]: watermark })) }
  }
  return {
    ...snapshot,
    projects: snapshot.projects.map(project => ({
      ...project,
      deviceWorkspaces: project.deviceWorkspaces.map(stampWorkspace),
    })),
    chats: snapshot.chats.map(stampWorkspace),
  }
}

export function runtimeWorkActivityWatermark(): number {
  return latestRevision
}

export function createRuntimeTaskActivity(
  address: RuntimeTaskAddress,
  running?: boolean
): RuntimeTaskActivity {
  return { address, running, observedAt: Date.now(), revision: ++latestRevision }
}

export interface RuntimeTaskActivity {
  address: RuntimeTaskAddress
  observedAt: number
  running?: boolean
  revision?: number
}

export function reconcileRuntimeTaskActivity(
  current: RuntimeTaskSummary,
  incoming: RuntimeTaskSummary,
  watermark = -1
): RuntimeTaskSummary {
  const observation = (current as ObservedTask)[activityObservation]
  const sourceWatermark = (incoming as ObservedTask)[snapshotObservation] ?? watermark
  if (!observation || observation.revision <= sourceWatermark) return incoming
  // Symbols remain local to the UI projection and never enter JSON caches or RPC payloads.
  return {
    ...incoming,
    updatedAt: current.updatedAt,
    ...(observation.running === undefined ? {} : { running: observation.running }),
    [activityObservation]: observation,
  } as ObservedTask
}

export function updateRuntimeWorkActivity(
  current: RuntimeWorkListResponse | null,
  activity: RuntimeTaskActivity
): RuntimeWorkListResponse | null {
  if (!current || !Number.isFinite(activity.observedAt)) return current
  const updateWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => {
    if (workspace.deviceId !== activity.address.deviceId) return workspace
    let changed = false
    const tasks = workspace.tasks.map(task => {
      if (task.taskId !== activity.address.taskId) return task
      const previousTime = new Date(task.updatedAt ?? 0).getTime()
      const updatedAt = Math.max(
        Number.isFinite(previousTime) ? previousTime : 0,
        activity.observedAt
      )
      const running = activity.running ?? task.running
      const previousObservation = (task as ObservedTask)[activityObservation]
      if (
        updatedAt === previousTime &&
        running === task.running &&
        activity.revision === previousObservation?.revision
      )
        return task
      changed = true
      return {
        ...task,
        updatedAt,
        ...(activity.running === undefined ? {} : { running }),
        ...(activity.revision === undefined
          ? {}
          : {
              [activityObservation]: {
                revision: activity.revision,
                running: activity.running ?? previousObservation?.running,
              },
            }),
      }
    })
    return changed ? { ...workspace, tasks } : workspace
  }
  let projectsChanged = false
  const projects = current.projects.map(project => {
    const deviceWorkspaces = project.deviceWorkspaces.map(updateWorkspace)
    if (deviceWorkspaces.every((workspace, index) => workspace === project.deviceWorkspaces[index]))
      return project
    projectsChanged = true
    return { ...project, deviceWorkspaces }
  })
  const chats = current.chats.map(updateWorkspace)
  const chatsChanged = chats.some((workspace, index) => workspace !== current.chats[index])
  if (!projectsChanged && !chatsChanged) return current
  // This is a projection update, never a directory upsert or an authoritative timestamp write.
  return {
    ...current,
    projects: projectsChanged ? projects : current.projects,
    chats: chatsChanged ? chats : current.chats,
  }
}
