import { describe, expect, test } from 'vitest'
import {
  pendingInputSegments,
  taskBoardLanes,
  workControlPresentation,
  workControlStateLabels,
  workInputPresentation,
  workInputQueuedInPageOnly,
  workInputStateLabels,
  type TaskBoardLane,
} from '../taskBoardModel'

const nonSuccessLanes: readonly TaskBoardLane[] = taskBoardLanes.filter(lane => lane !== 'completed')

describe('appended requirement and control receipt projections', () => {
  test('every observed input state keeps its own label and never claims success', () => {
    const expected: Record<string, string> = {
      queued: 'queued',
      accepted: 'pending',
      dispatched: 'pending',
      applied: 'applied',
      rejected: 'rejected',
      needs_reconciliation: 'needsReview',
      future_state: 'needsReview',
    }
    for (const [state, label] of Object.entries(expected)) {
      const view = workInputPresentation(state)
      expect(view.state).toBe(state)
      expect(view.label).toBe(label)
      expect(view.lane).not.toBe('completed')
      expect(nonSuccessLanes).toContain(view.lane)
    }
    expect(workInputPresentation('applied')).toMatchObject({ lane: 'active' })
    expect(workInputPresentation('queued').lane).toBe('background')
    expect(workInputPresentation('accepted').lane).toBe('active')
    expect(workInputPresentation('dispatched').lane).toBe('active')
    expect(workInputPresentation('rejected').lane).toBe('stopped')
    expect(workInputPresentation('needs_reconciliation').lane).toBe('unknown')
    expect(workInputPresentation()).toEqual({ state: '', label: 'needsReview', lane: 'unknown' })
    expect(workInputPresentation(null).label).toBe('needsReview')
    // Every label except the page-local queue is produced by an observed state.
    expect(new Set(Object.keys(expected).map(state => workInputPresentation(state).label))).toEqual(
      new Set(workInputStateLabels.filter(label => label !== 'queuedInPageOnly'))
    )
  })
  test('a page-local queue never claims the target accepted the requirement', () => {
    const view = workInputQueuedInPageOnly()
    expect(view).toEqual({ state: 'queued', label: 'queuedInPageOnly', lane: 'background' })
    expect(workInputStateLabels).toContain(view.label)
    expect(view.label).not.toBe('pending')
    expect(view.label).not.toBe('applied')
    expect(nonSuccessLanes).toContain(view.lane)
  })
  test('an observed queue collapses into one segment per state and keeps unknowns for review', () => {
    const segments = pendingInputSegments([
      { state: 'queued' },
      { state: 'rejected' },
      { state: 'queued' },
      // `accepted` and `dispatched` share one presentation label.
      { state: 'accepted' },
      { state: 'dispatched' },
      { state: 'future_state' },
    ])
    expect(segments).toEqual([
      { label: 'queued', lane: 'background', count: 2 },
      { label: 'rejected', lane: 'stopped', count: 1 },
      { label: 'pending', lane: 'active', count: 2 },
      { label: 'needsReview', lane: 'unknown', count: 1 },
    ])
    for (const segment of segments) expect(nonSuccessLanes).toContain(segment.lane)
    expect(pendingInputSegments([{ state: 'future_state' }])).toEqual([
      { label: 'needsReview', lane: 'unknown', count: 1 },
    ])
    expect(pendingInputSegments([])).toEqual([])
  })
  test('every observed control state has an explicit receipt label', () => {
    const expected: Record<string, { label: string; settled: boolean; lane: TaskBoardLane }> = {
      accepted: { label: 'submitted', settled: false, lane: 'active' },
      settling: { label: 'submitted', settled: false, lane: 'active' },
      settled: { label: 'settled', settled: true, lane: 'unknown' },
      superseded: { label: 'superseded', settled: false, lane: 'unknown' },
      failed: { label: 'failed', settled: false, lane: 'stopped' },
      needs_reconciliation: { label: 'needsReview', settled: false, lane: 'unknown' },
      future_state: { label: 'needsReview', settled: false, lane: 'unknown' },
    }
    for (const [state, projection] of Object.entries(expected)) {
      expect(workControlPresentation(state)).toEqual({ state, ...projection })
      expect(nonSuccessLanes).toContain(projection.lane)
    }
    expect(workControlPresentation()).toEqual({
      state: '',
      label: 'needsReview',
      settled: false,
      lane: 'unknown',
    })
    expect(workControlPresentation(null).label).toBe('needsReview')
    expect(
      new Set(Object.keys(expected).map(state => workControlPresentation(state).label))
    ).toEqual(new Set(workControlStateLabels))
  })
  test('only a settled receipt ends the requested action and no receipt proves completion', () => {
    const states = [
      'accepted',
      'settling',
      'settled',
      'superseded',
      'failed',
      'needs_reconciliation',
      'future_state',
    ]
    expect(states.filter(state => workControlPresentation(state).settled)).toEqual(['settled'])
    for (const state of states) expect(nonSuccessLanes).toContain(workControlPresentation(state).lane)
  })
})