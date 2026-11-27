import type {
  ContinuousWorkControlAction,
  ContinuousWorkControlParams,
  ContinuousWorkControlResult,
  ContinuousWorkInputReadParams,
  ContinuousWorkInputReceiptView,
  ContinuousWorkInputSubmitParams,
  ContinuousWorkView,
} from '../../../../shared/generated/contracts'
import {
  isContinuousWorkControlResult,
  isContinuousWorkInputResult,
  isContinuousWorkReadResult,
} from '../../../../shared/generated/contractGuards.mjs'

/** Negotiated names frozen by `kcoder_app_protocol::continuous_work`. */
export const workControlCapability = 'continuousWorkControlV1'
export const workInputCapability = 'continuousWorkInputV1'
export const workReadCapability = 'continuousWorkReadV1'

/** Frozen RPC methods; this module never substitutes another method. */
export const workControlMethod = 'work/control'
export const workInputSubmitMethod = 'work/input/submit'
export const workInputReadMethod = 'work/input/read'
export const workReadMethod = 'work/read'

/**
 * Minimal transport surface. A real GatewayClient satisfies it structurally,
 * and every reply stays `unknown` because this module validates it first.
 */
export interface WorkRpcClient {
  supportsExperimental?: (capability: string) => boolean
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>
}

export type WorkControlTargetKind = 'work' | 'turn' | 'agent' | 'workflow' | 'operation'

/** Mirrors `WorkControlTarget::matches_action`; the host still verifies existence. */
const actionTargetKinds: Record<ContinuousWorkControlAction, readonly WorkControlTargetKind[]> = {
  pause: ['work'],
  resume: ['work'],
  stop: ['work'],
  cancel_run: ['turn', 'agent', 'workflow'],
  retry: ['turn', 'agent', 'workflow', 'operation'],
  reconcile: ['operation'],
}

/** Target kinds an action may address; an unknown action accepts none. */
export function workControlTargetKinds(action: string): readonly WorkControlTargetKind[] {
  return Object.hasOwn(actionTargetKinds, action)
    ? actionTargetKinds[action as ContinuousWorkControlAction]
    : []
}

/** Reject a control whose target cannot mean that action before any request. */
export function controlTargetMatchesAction(
  action: string,
  target: { kind?: string } | null | undefined
): boolean {
  const kind = target?.kind
  if (typeof kind !== 'string') return false
  return workControlTargetKinds(action).some(known => known === kind)
}

export type WorkControlSubmitResult =
  /** One request completed with a correlated receipt; its state decides settling. */
  | { status: 'sent'; receipt: ContinuousWorkControlResult }
  /** The target never negotiated `continuousWorkControlV1`; nothing was sent. */
  | { status: 'unsupported' }
  | { status: 'invalid'; error: 'invalid_params' | 'target_action_mismatch' }
  /** A sent request has no trustworthy answer; only an explicit re-read settles it. */
  | { status: 'unknown'; error: 'transport_error' | 'invalid_reply' }

export type WorkInputSubmitResult =
  | { status: 'sent'; receipt: ContinuousWorkInputReceiptView | null }
  | { status: 'unsupported' }
  | { status: 'invalid'; error: 'invalid_params' | 'empty_requirement' }
  | { status: 'unknown'; error: 'transport_error' | 'invalid_reply' }

export type WorkInputReadResult =
  | { status: 'read'; receipt: ContinuousWorkInputReceiptView }
  /** The host answered but reports no receipt for this input yet. */
  | { status: 'absent' }
  | { status: 'unsupported' }
  | { status: 'invalid'; error: 'invalid_params' }
  | { status: 'unknown'; error: 'transport_error' | 'invalid_reply' }

export type WorkReadResult =
  | { status: 'read'; work: ContinuousWorkView | null }
  | { status: 'unsupported' }
  | { status: 'invalid'; error: 'invalid_params' }
  | { status: 'unknown'; error: 'transport_error' | 'invalid_reply' }

type RequestOptions = { signal?: AbortSignal }

const supported = (client: WorkRpcClient, capability: string): boolean =>
  client.supportsExperimental?.(capability) === true

const validIdentity = (...values: Array<string | null | undefined>): boolean =>
  values.every(value => typeof value === 'string' && value.length > 0)

const validRevision = (value: number): boolean => Number.isSafeInteger(value) && value > 0

/**
 * Submit one explicit control request. Nothing is sent without the negotiated
 * capability, a complete original identity or a matching target/action pair.
 * A failed or unconfirmed request is never resent here; the caller re-reads.
 */
export async function submitControl(
  client: WorkRpcClient,
  params: ContinuousWorkControlParams,
  options?: RequestOptions
): Promise<WorkControlSubmitResult> {
  if (!supported(client, workControlCapability)) return { status: 'unsupported' }
  if (
    !validIdentity(params.action, params.requestId, params.threadId, params.workId) ||
    !validRevision(params.expectedRevision)
  )
    return { status: 'invalid', error: 'invalid_params' }
  if (!controlTargetMatchesAction(params.action, params.target))
    return { status: 'invalid', error: 'target_action_mismatch' }
  try {
    const value = await client.request(
      workControlMethod,
      {
        action: params.action,
        expectedRevision: params.expectedRevision,
        requestId: params.requestId,
        target: params.target,
        threadId: params.threadId,
        workId: params.workId,
      },
      options
    )
    if (
      !isContinuousWorkControlResult(value) ||
      value.requestId !== params.requestId ||
      value.workId !== params.workId ||
      value.action !== params.action
    )
      return { status: 'unknown', error: 'invalid_reply' }
    return { status: 'sent', receipt: value }
  } catch {
    return { status: 'unknown', error: 'transport_error' }
  }
}

/**
 * Submit one appended requirement. Without `continuousWorkInputV1` the
 * requirement stays in the caller's page queue and is never sent.
 */
export async function submitInput(
  client: WorkRpcClient,
  params: ContinuousWorkInputSubmitParams,
  options?: RequestOptions
): Promise<WorkInputSubmitResult> {
  if (!supported(client, workInputCapability)) return { status: 'unsupported' }
  if (
    !validIdentity(params.inputId, params.requestId, params.threadId, params.workId) ||
    !validRevision(params.expectedRevision)
  )
    return { status: 'invalid', error: 'invalid_params' }
  // The host accepts a requirement only with visible text or retained input.
  if (!params.text?.trim() && params.retention == null)
    return { status: 'invalid', error: 'empty_requirement' }
  const wire: Record<string, unknown> = {
    expectedRevision: params.expectedRevision,
    inputId: params.inputId,
    requestId: params.requestId,
    threadId: params.threadId,
    workId: params.workId,
  }
  if (params.text != null) wire.text = params.text
  if (params.interaction != null) wire.interaction = params.interaction
  if (params.retention != null) wire.retention = params.retention
  try {
    const value = await client.request(workInputSubmitMethod, wire, options)
    if (!isContinuousWorkInputResult(value)) return { status: 'unknown', error: 'invalid_reply' }
    const receipt = value.receipt ?? null
    if (
      receipt &&
      (receipt.inputId !== params.inputId ||
        receipt.requestId !== params.requestId ||
        receipt.threadId !== params.threadId ||
        receipt.workId !== params.workId)
    )
      return { status: 'unknown', error: 'invalid_reply' }
    return { status: 'sent', receipt }
  } catch {
    return { status: 'unknown', error: 'transport_error' }
  }
}

/** Read one requirement receipt; this is the only re-read after a submit. */
export async function readInputReceipt(
  client: WorkRpcClient,
  params: ContinuousWorkInputReadParams,
  options?: RequestOptions
): Promise<WorkInputReadResult> {
  if (!supported(client, workInputCapability)) return { status: 'unsupported' }
  if (!validIdentity(params.inputId, params.threadId, params.workId))
    return { status: 'invalid', error: 'invalid_params' }
  try {
    const value = await client.request(
      workInputReadMethod,
      { inputId: params.inputId, threadId: params.threadId, workId: params.workId },
      options
    )
    if (!isContinuousWorkInputResult(value)) return { status: 'unknown', error: 'invalid_reply' }
    const receipt = value.receipt ?? null
    if (!receipt) return { status: 'absent' }
    if (
      receipt.inputId !== params.inputId ||
      receipt.threadId !== params.threadId ||
      receipt.workId !== params.workId
    )
      return { status: 'unknown', error: 'invalid_reply' }
    return { status: 'read', receipt }
  } catch {
    return { status: 'unknown', error: 'transport_error' }
  }
}

/** Re-read one work record; this never resends a control or an input. */
export async function readWorkObservation(
  client: WorkRpcClient,
  workId: string,
  options?: RequestOptions
): Promise<WorkReadResult> {
  if (!supported(client, workReadCapability)) return { status: 'unsupported' }
  if (!validIdentity(workId)) return { status: 'invalid', error: 'invalid_params' }
  try {
    const value = await client.request(workReadMethod, { workId }, options)
    if (!isContinuousWorkReadResult(value)) return { status: 'unknown', error: 'invalid_reply' }
    const work = value.work ?? null
    if (work && work.workId !== workId) return { status: 'unknown', error: 'invalid_reply' }
    return { status: 'read', work }
  } catch {
    return { status: 'unknown', error: 'transport_error' }
  }
}