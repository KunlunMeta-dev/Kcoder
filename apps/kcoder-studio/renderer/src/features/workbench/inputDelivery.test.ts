import { expect, test } from 'vitest'
import { applyInputDelivery, canSubmitInput, isPendingInput } from './inputDelivery'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
const row = (status: RuntimePaneQueuedMessage['status'], extra = {}): RuntimePaneQueuedMessage => ({
  id: 'input',
  content: 'original',
  createdAt: 'now',
  status,
  ...extra,
})

test.each(['unknown', 'accepted', 'running'] as const)('unchanged %s observations preserve the existing queue and attachment identities', status => {
  const pending = row(status, { turnId: status === 'running' ? 'turn' : undefined,
    attachments: [{ id: 1, filename: 'owned.png' }] })
  const rows = [row('queued', { id: 'next' }), pending]
  for (let index = 0; index < 40; index++)
    expect(applyInputDelivery(rows, pending.id, { status, turnId: pending.turnId })).toBe(rows)
  expect(applyInputDelivery(rows, 'missing-input', { status: 'unknown' })).toBe(rows)
  expect(applyInputDelivery(rows, pending.id, {} as never)).toBe(rows)
})

test('an unchanged status still clears a stale notice and error once', () => {
  const pending = row('unknown', { notice: 'Checking receipt', error: 'Old transport failure' })
  const rows = [pending]
  const next = applyInputDelivery(rows, pending.id, { status: 'unknown' })
  expect(next).not.toBe(rows)
  expect(next[0]).toMatchObject({ status: 'unknown', notice: undefined, error: undefined })
  expect(applyInputDelivery(next, pending.id, { status: 'unknown' })).toBe(next)
})

test('execution leaves the visible queue and completion releases its tracking record', () => {
  const original = row('sending')
  let rows = applyInputDelivery([original], original.id, { status: 'running', turnId: 'turn' })
  expect(rows).toEqual([
    expect.objectContaining({ id: original.id, status: 'running', turnId: 'turn' }),
  ])
  expect(rows.filter(isPendingInput)).toEqual([])
  rows = applyInputDelivery(rows, original.id, { status: 'completed', turnId: 'turn' })
  expect(rows).toEqual([])
})

test('late or malformed observations cannot undo completion or target a replacement turn', () => {
  const completed = row('completed', { turnId: 'turn' })
  expect(applyInputDelivery([completed], 'input', { status: 'running', turnId: 'turn' })).toEqual(
    []
  )
  const running = row('running', { turnId: 'original' })
  expect(
    applyInputDelivery([running], 'input', { status: 'interrupted', turnId: 'other' })[0]
  ).toBe(running)
  expect(applyInputDelivery([running], 'input', {} as never)[0]).toBe(running)
})

test('missing evidence preserves accepted facts and cannot enable retry', () => {
  const accepted = row('accepted')
  expect(applyInputDelivery([accepted], 'input', { status: 'unknown' })[0]).toBe(accepted)
  for (const status of [
    'unknown',
    'accepted',
    'running',
    'completed',
    'execution_failed',
    'interrupted',
  ] as const)
    expect(canSubmitInput(row(status))).toBe(false)
  expect(canSubmitInput(row('queued'))).toBe(true)
  expect(canSubmitInput(row('failed'))).toBe(true)
})

test('cancellation intent survives sending and stopping, but completion wins', () => {
  const pending = row('unknown', { cancelRequested: true })
  const stopping = applyInputDelivery([pending], 'input', {
    status: 'running',
    turnId: 'original',
  })[0]
  expect(stopping.cancelRequested).toBe(true)
  expect(
    applyInputDelivery([stopping], 'input', { status: 'interrupted', turnId: 'original' })[0]
      .cancelRequested
  ).toBe(true)
  expect(
    applyInputDelivery([stopping], 'input', { status: 'completed', turnId: 'original' })
  ).toEqual([])
})

test('only pre-execution entries or an unresolved cancellation remain visible', () => {
  for (const status of ['queued', 'sending', 'accepted', 'unknown', 'failed'] as const)
    expect(isPendingInput(row(status))).toBe(true)
  for (const status of [
    'running',
    'completed',
    'execution_failed',
    'interrupted',
    'applied',
  ] as const)
    expect(isPendingInput(row(status))).toBe(false)
  expect(isPendingInput(row('running', { cancelRequested: true }))).toBe(true)
})

test('late queued-steer observations cannot regress a confirmed fallback execution', () => {
  const executing = row('running', { turnId: 'fallback-turn' })
  expect(applyInputDelivery([executing], executing.id, { status: 'accepted' })[0]).toBe(executing)
})

test('legacy cancellation intent is cleared when a queued steer cannot be withdrawn', () => {
  const pending = row('unknown', { deliveryMode: 'guidance', cancelRequested: true })
  expect(applyInputDelivery([pending], pending.id, { status: 'accepted' })[0].cancelRequested).toBe(false)
})
