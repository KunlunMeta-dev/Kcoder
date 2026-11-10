import type { TaskWorkspaceTarget, TaskWorkspaceTransport } from '@/kcoder/taskWorkspaceTransport'

export interface TaskWorkspaceViewBinding {
  target: TaskWorkspaceTarget
  threadId: string
  transport: TaskWorkspaceTransport
}

/** Component request lifetime only; this is never task or authorization state. */
export class TaskWorkspaceViewOwner {
  readonly key: string
  private current: TaskWorkspaceViewBinding | undefined
  private readonly parentCurrent: () => boolean
  constructor(key: string, parentCurrent: () => boolean) {
    this.key = key
    this.parentCurrent = parentCurrent
  }
  install(binding: TaskWorkspaceViewBinding) {
    this.current = binding
  }
  read() {
    return this.current
  }
  isCurrent(binding: TaskWorkspaceViewBinding) {
    return this.current === binding && this.parentCurrent() && binding.transport.isCurrent()
  }
  owns(binding: TaskWorkspaceViewBinding) {
    return this.current === binding && this.parentCurrent()
  }
  detach(binding: TaskWorkspaceViewBinding) {
    if (this.current === binding) this.current = undefined
  }
}
