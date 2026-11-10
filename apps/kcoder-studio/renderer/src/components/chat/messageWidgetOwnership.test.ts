import { expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { getMessageWidgetOwnership } from './messageWidgetOwnership'

function message(id: string, fields: Partial<WorkbenchMessage> = {}): WorkbenchMessage {
  return { id, role: 'assistant', content: id, status: 'done', createdAt: '2026-10-12', ...fields }
}

test('a hydrated body and the real live attempt have one active presentation owner', () => {
  const owners = getMessageWidgetOwnership([
    message('history', { turnId: 'turn-1', subtaskId: 'thread:history:1' }),
    message('live', { turnId: 'turn-1', attemptId: 'accepted-attempt', subtaskId: 'accepted-attempt', status: 'streaming' }),
  ])
  expect(owners.get('history')).toEqual({ ownsWidgets: false, attemptActive: true })
  expect(owners.get('live')).toEqual({ ownsWidgets: true, attemptActive: true })
})

test('only the last body segment owns final artifacts after the same attempt completes', () => {
  const owners = getMessageWidgetOwnership([
    message('history', { turnId: 'turn-1' }),
    message('final', { turnId: 'turn-1', attemptId: 'accepted-attempt' }),
  ])
  expect(owners.get('history')?.ownsWidgets).toBe(false)
  expect(owners.get('final')).toEqual({ ownsWidgets: true, attemptActive: false })
})

test('separate attempts retain separate owners and ambiguous legacy rows acquire none', () => {
  const owners = getMessageWidgetOwnership([
    message('failed', { turnId: 'turn-1', attemptId: 'old-attempt', status: 'failed' }),
    message('legacy', { turnId: 'turn-1', subtaskId: 'thread:history:2' }),
    message('retry', { turnId: 'turn-1', attemptId: 'current-attempt', status: 'streaming' }),
  ])
  expect(owners.get('failed')).toEqual({ ownsWidgets: true, attemptActive: false })
  expect(owners.get('legacy')?.ownsWidgets).toBe(false)
  expect(owners.get('retry')).toEqual({ ownsWidgets: true, attemptActive: true })
})

test('older sessions without attempt metadata still use the last segment of their turn', () => {
  const owners = getMessageWidgetOwnership([message('first', { turnId: 'legacy' }), message('last', { turnId: 'legacy' })])
  expect(owners.get('first')?.ownsWidgets).toBe(false)
  expect(owners.get('last')).toEqual({ ownsWidgets: true, attemptActive: false })
})
