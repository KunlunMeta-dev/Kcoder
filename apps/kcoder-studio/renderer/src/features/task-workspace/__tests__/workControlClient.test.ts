import { describe, expect, expectTypeOf, test, vi } from 'vitest'
import type { GatewayClient } from '@/kcoder/gatewayRuntimeTypes'
import type {
  ContinuousWorkControlAction,
  ContinuousWorkControlParams,
  ContinuousWorkControlResult,
  ContinuousWorkInputReadParams,
  ContinuousWorkInputReceiptView,
  ContinuousWorkInputSubmitParams,
  ContinuousWorkView,
  WorkControlTarget,
} from '../../../../../shared/generated/contracts'
import {
  controlTargetMatchesAction,
  readInputReceipt,
  readWorkObservation,
  submitControl,
  submitInput,
  workControlCapability,
  workControlMethod,
  workControlTargetKinds,
  workInputCapability,
  workInputReadMethod,
  workInputSubmitMethod,
  workReadCapability,
  workReadMethod,
  type WorkRpcClient,
} from '../workControlClient'

type Reply = (method: string, params?: Record<string, unknown>) => Promise<unknown>

const controlParams: ContinuousWorkControlParams = {
  action: 'pause',
  expectedRevision: 7,
  requestId: 'control-request-1',
  target: { kind: 'work' },
  threadId: 'thread-1',
  workId: 'work-1',
}
const controlReceipt: ContinuousWorkControlResult = {
  action: 'pause',
  controlEpoch: 3,
  requestId: 'control-request-1',
  revision: 8,
  state: 'settling',
  target: { kind: 'work' },
  workId: 'work-1',
}
const inputParams: ContinuousWorkInputSubmitParams = {
  expectedRevision: 7,
  inputId: 'input-1',
  requestId: 'input-request-1',
  text: 'Add the missing acceptance case',
  threadId: 'thread-1',
  workId: 'work-1',
}
const inputReadParams: ContinuousWorkInputReadParams = {
  inputId: 'input-1',
  threadId: 'thread-1',
  workId: 'work-1',
}
const inputReceipt: ContinuousWorkInputReceiptView = {
  inputId: 'input-1',
  requestId: 'input-request-1',
  sequence: 1,
  state: 'queued',
  threadId: 'thread-1',
  workId: 'work-1',
}
const workView: ContinuousWorkView = {
  freshness: 'current',
  phase: 'running',
  requirementsRevision: 2,
  revision: 8,
  threadId: 'thread-1',
  workId: 'work-1',
}

function clientWith(capabilities: readonly string[], reply: Reply = async () => ({})) {
  const request = vi.fn<Reply>(reply)
  const client: WorkRpcClient = {
    supportsExperimental: (capability: string) => capabilities.includes(capability),
    request,
  }
  return { client, request }
}

describe('capability-gated continuous work transport', () => {
  test('the real renderer client satisfies the injected transport surface', () => {
    expectTypeOf<GatewayClient>().toExtend<WorkRpcClient>()
  })
  test('an unnegotiated capability sends nothing and reports unsupported', async () => {
    const quiet = clientWith([])
    expect(await submitControl(quiet.client, controlParams)).toEqual({ status: 'unsupported' })
    expect(await submitInput(quiet.client, inputParams)).toEqual({ status: 'unsupported' })
    expect(await readInputReceipt(quiet.client, inputReadParams)).toEqual({ status: 'unsupported' })
    expect(await readWorkObservation(quiet.client, 'work-1')).toEqual({ status: 'unsupported' })
    expect(quiet.request).not.toHaveBeenCalled()
  })
  test('the read capability alone never enables control or appended input', async () => {
    const readOnly = clientWith([workReadCapability], async () => ({ work: workView }))
    expect(await submitControl(readOnly.client, controlParams)).toEqual({ status: 'unsupported' })
    expect(await submitInput(readOnly.client, inputParams)).toEqual({ status: 'unsupported' })
    expect(readOnly.request).not.toHaveBeenCalled()
    // The explicit re-read after an unconfirmed outcome only observes.
    expect(await readWorkObservation(readOnly.client, 'work-1')).toEqual({
      status: 'read',
      work: workView,
    })
    expect(readOnly.request.mock.calls.map(call => call[0])).toEqual([workReadMethod])
  })
  test('a negotiated control sends exactly one request with the frozen method', async () => {
    const sent = clientWith([workControlCapability], async () => controlReceipt)
    expect(await submitControl(sent.client, controlParams)).toEqual({
      status: 'sent',
      receipt: controlReceipt,
    })
    expect(sent.request).toHaveBeenCalledTimes(1)
    expect(sent.request.mock.calls[0][0]).toBe(workControlMethod)
    expect(sent.request.mock.calls[0][1]).toEqual(controlParams)
  })
  test('a negotiated input submit and receipt read use only their frozen methods', async () => {
    const sent = clientWith([workInputCapability], async () => ({ receipt: inputReceipt }))
    expect(await submitInput(sent.client, inputParams)).toEqual({
      status: 'sent',
      receipt: inputReceipt,
    })
    expect(await readInputReceipt(sent.client, inputReadParams)).toEqual({
      status: 'read',
      receipt: inputReceipt,
    })
    expect(sent.request.mock.calls.map(call => call[0])).toEqual([
      workInputSubmitMethod,
      workInputReadMethod,
    ])
    expect(sent.request.mock.calls[0][1]).toEqual(inputParams)
    expect(sent.request.mock.calls[1][1]).toEqual(inputReadParams)
  })
  test('a submitted requirement without a receipt stays unobserved instead of accepted', async () => {
    const unobserved = clientWith([workInputCapability], async () => ({ receipt: null }))
    expect(await submitInput(unobserved.client, inputParams)).toEqual({
      status: 'sent',
      receipt: null,
    })
    expect(unobserved.request).toHaveBeenCalledTimes(1)
  })
  test('a transport failure stays unknown after one attempt and re-reads never resend', async () => {
    const failed = clientWith([workControlCapability, workInputCapability], async () => {
      throw new Error('socket closed')
    })
    expect(await submitControl(failed.client, controlParams)).toEqual({
      status: 'unknown',
      error: 'transport_error',
    })
    expect(await submitInput(failed.client, inputParams)).toEqual({
      status: 'unknown',
      error: 'transport_error',
    })
    expect(failed.request.mock.calls.map(call => call[0])).toEqual([
      workControlMethod,
      workInputSubmitMethod,
    ])

    // A separate explicit re-read may call only the read methods.
    const reread = clientWith([workReadCapability, workInputCapability], async method =>
      method === workInputReadMethod ? { receipt: inputReceipt } : { work: workView }
    )
    expect(await readInputReceipt(reread.client, inputReadParams)).toEqual({
      status: 'read',
      receipt: inputReceipt,
    })
    expect(await readWorkObservation(reread.client, 'work-1')).toEqual({
      status: 'read',
      work: workView,
    })
    expect(reread.request.mock.calls.map(call => call[0])).toEqual([
      workInputReadMethod,
      workReadMethod,
    ])
  })
  test('a mismatched or unreadable receipt is unknown instead of a claimed outcome', async () => {
    const foreign = clientWith([workControlCapability], async () => ({
      ...controlReceipt,
      requestId: 'another-request',
    }))
    expect(await submitControl(foreign.client, controlParams)).toEqual({
      status: 'unknown',
      error: 'invalid_reply',
    })
    expect(foreign.request).toHaveBeenCalledTimes(1)
    const broken = clientWith([workInputCapability], async () => ({
      receipt: { ...inputReceipt, workId: 'another-work' },
    }))
    expect(await submitInput(broken.client, inputParams)).toEqual({
      status: 'unknown',
      error: 'invalid_reply',
    })
    expect(broken.request).toHaveBeenCalledTimes(1)
  })
  test('a control action rejects a semantically mismatched target before sending', async () => {
    const quiet = clientWith([workControlCapability], async () => controlReceipt)
    const mismatched: Array<[ContinuousWorkControlAction, WorkControlTarget]> = [
      ['pause', { kind: 'turn', attemptId: 'attempt-1', threadId: 'thread-1', turnId: 'turn-1' }],
      ['resume', { kind: 'operation', operationId: 'operation-1' }],
      [
        'stop',
        {
          kind: 'agent',
          agentId: 'agent-1',
          attemptId: 'attempt-1',
          runId: 'run-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
        },
      ],
      ['cancel_run', { kind: 'work' }],
      ['retry', { kind: 'work' }],
      ['reconcile', { kind: 'work' }],
      // A future action has no known target semantics, so it is never sent.
      ['future_action' as ContinuousWorkControlAction, { kind: 'work' }],
    ]
    for (const [action, target] of mismatched)
      expect(await submitControl(quiet.client, { ...controlParams, action, target })).toEqual({
        status: 'invalid',
        error: 'target_action_mismatch',
      })
    expect(quiet.request).not.toHaveBeenCalled()
  })
  test('a matched control target is sent once', async () => {
    const sent = clientWith([workControlCapability], async () => ({
      ...controlReceipt,
      action: 'cancel_run',
    }))
    expect(
      await submitControl(sent.client, {
        ...controlParams,
        action: 'cancel_run',
        target: { kind: 'turn', attemptId: 'attempt-1', threadId: 'thread-1', turnId: 'turn-1' },
      })
    ).toMatchObject({ status: 'sent' })
    expect(sent.request.mock.calls.map(call => call[0])).toEqual([workControlMethod])
  })
  test('each known action accepts only its frozen target kinds', () => {
    expect(workControlTargetKinds('pause')).toEqual(['work'])
    expect(workControlTargetKinds('resume')).toEqual(['work'])
    expect(workControlTargetKinds('stop')).toEqual(['work'])
    expect(workControlTargetKinds('cancel_run')).toEqual(['turn', 'agent', 'workflow'])
    expect(workControlTargetKinds('retry')).toEqual(['turn', 'agent', 'workflow', 'operation'])
    expect(workControlTargetKinds('reconcile')).toEqual(['operation'])
    expect(workControlTargetKinds('future_action')).toEqual([])
    const kinds = ['work', 'turn', 'agent', 'workflow', 'operation', 'future_target'] as const
    for (const kind of kinds) {
      expect(controlTargetMatchesAction('pause', { kind })).toBe(kind === 'work')
      expect(controlTargetMatchesAction('reconcile', { kind })).toBe(kind === 'operation')
      expect(controlTargetMatchesAction('cancel_run', { kind })).toBe(
        ['turn', 'agent', 'workflow'].includes(kind)
      )
      expect(controlTargetMatchesAction('retry', { kind })).toBe(
        ['turn', 'agent', 'workflow', 'operation'].includes(kind)
      )
    }
    expect(controlTargetMatchesAction('pause', undefined)).toBe(false)
    expect(controlTargetMatchesAction('pause', null)).toBe(false)
    expect(controlTargetMatchesAction('pause', {})).toBe(false)
  })
  test('malformed identities and empty requirements are refused locally', async () => {
    const quiet = clientWith(
      [workControlCapability, workInputCapability],
      async () => controlReceipt
    )
    expect(
      await submitControl(quiet.client, { ...controlParams, expectedRevision: 0 })
    ).toEqual({ status: 'invalid', error: 'invalid_params' })
    expect(await submitControl(quiet.client, { ...controlParams, workId: '' })).toEqual({
      status: 'invalid',
      error: 'invalid_params',
    })
    expect(await submitInput(quiet.client, { ...inputParams, text: '   ' })).toEqual({
      status: 'invalid',
      error: 'empty_requirement',
    })
    expect(await submitInput(quiet.client, { ...inputParams, text: null })).toEqual({
      status: 'invalid',
      error: 'empty_requirement',
    })
    expect(await readInputReceipt(quiet.client, { ...inputReadParams, inputId: '' })).toEqual({
      status: 'invalid',
      error: 'invalid_params',
    })
    expect(quiet.request).not.toHaveBeenCalled()
  })
})