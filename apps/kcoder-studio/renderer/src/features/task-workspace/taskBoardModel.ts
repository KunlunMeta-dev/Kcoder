import type { RuntimeTaskSummary } from '@/types/api'
import type { ContinuousWorkView } from '../../../../shared/generated/contracts'
import { parseThreadGoalStatusObservation } from '@/kcoder/threadGoalStatus'
import { workspacePathKey } from '@/lib/workspace-path-identity'

/**
 * The six board states plus `unknown` (lean plan M1-8): in progress, waiting
 * for you, waiting for background work, paused, completed, failed or stopped.
 */
export const taskBoardLanes = [
  'active',
  'waiting',
  'background',
  'paused',
  'completed',
  'stopped',
  'unknown',
] as const
export type TaskBoardLane = (typeof taskBoardLanes)[number]
export type TaskBoardPeriod = 'today' | '7days' | '30days' | 'all'
export function taskBoardChoiceKey(choice: {
  threadId: string
  workspacePath?: string
  workId?: string
}) {
  const workspace = workspacePathKey(choice.workspacePath) || null
  return JSON.stringify(
    choice.workId ? [choice.threadId, workspace, choice.workId] : [choice.threadId, workspace]
  )
}
export interface TaskBoardObservation {
  task: RuntimeTaskSummary
  targetLabel: string
  stale: boolean
  work?: ContinuousWorkView
  workScanIncomplete?: boolean
}
export interface TaskBoardState {
  lane: TaskBoardLane
  hint: string
  confirmations?: number
  statusLabel?:
    | 'active'
    | 'paused'
    | 'blocked'
    | 'limited'
    | 'cancelled'
    | 'replyCompleted'
    | 'workWaiting'
    | 'workPaused'
    | 'workStopped'
    | 'workReview'
}

// Every hint has exactly one lane, so a lane is never inferred twice.
const laneByHint: Record<string, TaskBoardLane> = {
  running: 'active',
  aggregating: 'active',
  workPending: 'active',
  approval: 'waiting',
  answer: 'waiting',
  idle: 'waiting',
  goalBlocked: 'waiting',
  goalLimited: 'waiting',
  workReview: 'waiting',
  background: 'background',
  workWaiting: 'background',
  goalPaused: 'paused',
  workPaused: 'paused',
  completed: 'completed',
  failed: 'stopped',
  interrupted: 'stopped',
  goalCancelled: 'stopped',
  workStopped: 'stopped',
}

type ObservedState = Omit<TaskBoardState, 'lane'>

/** Group native observations only; this never changes an execution state. */
export function taskBoardState(observation?: TaskBoardObservation): TaskBoardState {
  const observed = observedTaskState(observation)
  return { ...observed, lane: laneByHint[observed.hint] ?? 'unknown' }
}

function observedTaskState(observation?: TaskBoardObservation): ObservedState {
  if (!observation || observation.stale || observation.task.optimistic)
    return { hint: 'syncNeeded' }
  const work = observation.work
  if (work) {
    // A saved phase or finished reply does not prove business completion.
    if (observation.workScanIncomplete || work.freshness !== 'current')
      return { hint: 'workUnconfirmed' }
    if (work.waiting && !['waiting_user', 'waiting_event'].includes(work.phase))
      return { hint: 'workUnconfirmed' }
    switch (work.phase) {
      case 'pending':
        return { hint: 'workPending' }
      case 'running':
        return { hint: 'running' }
      case 'waiting_user':
        return work.waiting?.kind === 'user' && work.waiting.reference
          ? { hint: 'answer' }
          : { hint: 'workUnconfirmed' }
      case 'waiting_event':
        return work.waiting?.kind === 'event' && work.waiting.reference
          ? { hint: 'workWaiting', statusLabel: 'workWaiting' }
          : { hint: 'workUnconfirmed' }
      case 'paused':
        return { hint: 'workPaused', statusLabel: 'workPaused' }
      case 'failed':
        return { hint: 'failed' }
      case 'stopped':
        return { hint: 'workStopped', statusLabel: 'workStopped' }
      case 'needs_reconciliation':
        return { hint: 'workReview', statusLabel: 'workReview' }
      default:
        return { hint: 'workUnconfirmed' }
    }
  }
  const task = observation.task
  const workScanIncomplete = observation.workScanIncomplete
  const turnStatus = task.runSummary?.latestTurnStatus ?? task.turnStatus
  switch (task.runActivity) {
    case 'waiting_approval':
    case 'waiting_answer': {
      const approvals = task.runSummary?.pendingApprovals
      const questions = task.runSummary?.pendingQuestions
      return {
        hint: task.runActivity === 'waiting_approval' ? 'approval' : 'answer',
        ...(approvals != null && questions != null ? { confirmations: approvals + questions } : {}),
      }
    }
    case 'running':
      return { hint: 'running' }
    case 'background':
      return { hint: 'background' }
    case 'aggregating':
      return { hint: 'aggregating' }
    case 'failed':
      return { hint: 'failed' }
    case 'idle': {
      if (turnStatus === 'failed') return { hint: 'failed' }
      if (turnStatus === 'interrupted') return { hint: 'interrupted' }
      if (turnStatus !== 'completed' && task.runSummary?.recentError?.kind === 'failed')
        return { hint: 'failed' }
      if (turnStatus !== 'completed' && task.runSummary?.recentError?.kind === 'interrupted')
        return { hint: 'interrupted' }
      const observation =
        task.goalStatusObservation === undefined
          ? undefined
          : parseThreadGoalStatusObservation(task.goalStatusObservation)
      // Older targets may omit the observation entirely. A completed turn or
      // an unverified legacy completion cannot establish Goal completion.
      if (
        observation?.availability === 'unavailable' ||
        (turnStatus === 'completed' &&
          observation === undefined &&
          (task.goalStatus == null || task.goalStatus === 'complete'))
      )
        return turnStatus === 'completed'
          ? { hint: 'replyCompletedGoalUnknown', statusLabel: 'replyCompleted' }
          : { hint: 'syncNeeded' }
      const goalStatus =
        observation?.availability === 'available' ? observation.status : task.goalStatus
      switch (goalStatus) {
        case 'active':
          // An active goal alone does not prove that its scheduler is running.
          return { hint: 'goalActive', statusLabel: 'active' }
        case 'paused':
          return { hint: 'goalPaused', statusLabel: 'paused' }
        case 'blocked':
          return { hint: 'goalBlocked', statusLabel: 'blocked' }
        case 'usageLimited':
        case 'budgetLimited':
          return { hint: 'goalLimited', statusLabel: 'limited' }
        case 'cancelled':
          return { hint: 'goalCancelled', statusLabel: 'cancelled' }
        case null:
        case undefined:
        case 'complete':
          break
        default:
          return { hint: 'syncNeeded' }
      }
      if (turnStatus === 'completed')
        return workScanIncomplete
          ? { hint: 'replyCompletedGoalUnknown', statusLabel: 'replyCompleted' }
          : { hint: 'completed' }
      if (task.runSummary?.recentError === undefined) return { hint: 'syncNeeded' }
      return { hint: 'idle' }
    }
    default:
      return { hint: 'syncNeeded' }
  }
}

export function taskBoardUpdatedAt(value: RuntimeTaskSummary['updatedAt']): Date | undefined {
  if (value == null || value === 0 || value === '') return
  // Native work-list timestamps may be serialized as decimal milliseconds.
  const trimmed = typeof value === 'string' ? value.trim() : value
  if (trimmed === '' || trimmed === '0') return
  const normalized =
    typeof trimmed === 'string' && /^\d{11,16}$/.test(trimmed) ? Number(trimmed) : trimmed
  const date = new Date(normalized)
  return Number.isFinite(date.getTime()) ? date : undefined
}

/** Labels for one observed appended-input state; unknown states never claim success. */
export const workInputStateLabels = [
  'queued',
  'pending',
  'applied',
  'rejected',
  'needsReview',
  'queuedInPageOnly',
] as const
export type WorkInputStateLabel = (typeof workInputStateLabels)[number]
export interface WorkInputPresentation {
  /** The observed native state, preserved verbatim for the details view. */
  state: string
  label: WorkInputStateLabel
  /** An input receipt never proves business completion, so it has no success lane. */
  lane: Exclude<TaskBoardLane, 'completed'>
}

/**
 * Project one observed requirement state. `applied` only means the input
 * entered a request; rejected, missing and future states stay unconfirmed.
 */
export function workInputPresentation(state?: string | null): WorkInputPresentation {
  const value = typeof state === 'string' ? state : ''
  switch (value) {
    case 'queued':
      return { state: value, label: 'queued', lane: 'background' }
    case 'accepted':
    case 'dispatched':
      return { state: value, label: 'pending', lane: 'active' }
    case 'applied':
      return { state: value, label: 'applied', lane: 'active' }
    case 'rejected':
      return { state: value, label: 'rejected', lane: 'stopped' }
    default:
      return { state: value, label: 'needsReview', lane: 'unknown' }
  }
}

/** This page/tab keeps the requirement itself; the target never received it. */
export function workInputQueuedInPageOnly(): WorkInputPresentation {
  return { state: 'queued', label: 'queuedInPageOnly', lane: 'background' }
}

export interface PendingInputSegment {
  /** One compact segment per observed presentation state. */
  label: WorkInputStateLabel
  /** Reuses the board's existing lane colors; never a success lane. */
  lane: Exclude<TaskBoardLane, 'completed'>
  count: number
}

/**
 * Collapse the observed accepted-but-unconsumed requirements into one segment
 * per state. The array is already bounded by the host, and an unknown label
 * stays a review item instead of reading as applied.
 */
export function pendingInputSegments(
  inputs: ReadonlyArray<{ state?: string | null }>
): PendingInputSegment[] {
  const segments: PendingInputSegment[] = []
  for (const input of inputs) {
    const presentation = workInputPresentation(input.state)
    const segment = segments.find(candidate => candidate.label === presentation.label)
    if (segment) segment.count += 1
    else segments.push({ label: presentation.label, lane: presentation.lane, count: 1 })
  }
  return segments
}

/** Labels for one observed control receipt; only `settled` ends the request. */
export const workControlStateLabels = [
  'submitted',
  'settled',
  'superseded',
  'failed',
  'needsReview',
] as const
export type WorkControlStateLabel = (typeof workControlStateLabels)[number]
export interface WorkControlPresentation {
  /** The observed native state, preserved verbatim for the details view. */
  state: string
  label: WorkControlStateLabel
  /** True only when the requested action itself reached a final receipt. */
  settled: boolean
  /** A control receipt is not a work observation, so it has no success lane. */
  lane: Exclude<TaskBoardLane, 'completed'>
}

/**
 * Project one observed control receipt. `accepted` and `settling` are pending
 * submissions, never terminal states; an unconfirmed outcome needs review.
 */
export function workControlPresentation(state?: string | null): WorkControlPresentation {
  const value = typeof state === 'string' ? state : ''
  switch (value) {
    case 'accepted':
    case 'settling':
      return { state: value, label: 'submitted', settled: false, lane: 'active' }
    case 'settled':
      return { state: value, label: 'settled', settled: true, lane: 'unknown' }
    case 'superseded':
      return { state: value, label: 'superseded', settled: false, lane: 'unknown' }
    case 'failed':
      return { state: value, label: 'failed', settled: false, lane: 'stopped' }
    default:
      return { state: value, label: 'needsReview', settled: false, lane: 'unknown' }
  }
}

/** Calendar-day filtering uses the viewer's local timezone and never guesses missing times. */
export function taskBoardMatchesPeriod(
  value: RuntimeTaskSummary['updatedAt'],
  period: TaskBoardPeriod,
  now: Date
): boolean {
  if (period === 'all') return true
  const updated = taskBoardUpdatedAt(value)
  if (!updated || !Number.isFinite(now.getTime())) return false
  const days = period === 'today' ? 1 : period === '7days' ? 7 : 30
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return updated >= start && updated < end
}

export interface WorkResultPresentation {
  state: string
  /** `ready` only means the target recorded a result, never that it was delivered. */
  label:
    | 'readyNeedsDelivery'
    | 'readyDeliveryUnobserved'
    | 'delivering'
    | 'delivered'
    | 'deliveryUnconfirmed'
    | 'deliveryFailed'
    | 'deliveryCancelled'
    | 'needsReview'
  lane: TaskBoardLane
}

/**
 * A recorded result and a delivered result are different facts. The projection
 * carries `deliveryRequirement: unobserved` until the host proves the
 * requirement, so the default label must not claim delivery.
 */
export function workResultPresentation(result?: {
  ready?: boolean | null
  deliveryRequirement?: string | null
  requiredDeliveryState?: string | null
} | null): WorkResultPresentation | undefined {
  if (!result) return undefined
  const requirement = result.deliveryRequirement ?? ''
  // Values of the protocol's WorkDeliveryState. `unknown_outcome` means the
  // send may have happened: it is shown as unconfirmed, never as delivered or
  // as safe to resend.
  const delivery = result.requiredDeliveryState ?? ''
  switch (delivery) {
    case 'confirmed':
      return { state: delivery, label: 'delivered', lane: 'completed' }
    case 'pending':
      return { state: delivery, label: 'readyNeedsDelivery', lane: 'waiting' }
    case 'sending':
      return { state: delivery, label: 'delivering', lane: 'active' }
    case 'unknown_outcome':
      return { state: delivery, label: 'deliveryUnconfirmed', lane: 'unknown' }
    case 'failed':
      return { state: delivery, label: 'deliveryFailed', lane: 'stopped' }
    case 'cancelled':
      return { state: delivery, label: 'deliveryCancelled', lane: 'stopped' }
  }
  if (result.ready === true && requirement === 'unobserved') {
    return { state: 'unobserved', label: 'readyDeliveryUnobserved', lane: 'unknown' }
  }
  return { state: requirement || 'unknown', label: 'needsReview', lane: 'unknown' }
}
