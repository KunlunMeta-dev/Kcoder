import { describe, expect, it } from 'vitest'
import { automationExecutionDiagnostics } from './automationCapabilities'

const receipt = {
  triggerId: 'cron:job:2026-10-03T09:00:00Z',
  jobId: 'job',
  scheduledAt: '2026-10-03T09:00:00Z',
  recordedAt: '2026-10-03T09:00:00Z',
  deliveryConfirmed: true,
}

describe('automation execution projection', () => {
  it('does not infer execution from legacy delivery or schedule timestamps', () => {
    expect(
      automationExecutionDiagnostics({ jobs: [{ last_fired_at: receipt.scheduledAt }] })
    ).toBeNull()
    expect(
      automationExecutionDiagnostics({ deliveryDiagnostics: { receipts: [receipt] } })
    ).toBeNull()
  })
  it('requires actual reply and all execution identities for success', () => {
    const diagnostics = automationExecutionDiagnostics({
      executionDiagnostics: {
        runs: [
          { ...receipt, status: 'succeeded', threadId: 'empty-thread' },
          {
            ...receipt,
            triggerId: 'actual',
            status: 'succeeded',
            threadId: 'thread',
            turnId: 'turn',
            attemptId: 'attempt',
            replyPreview: 'actual reply',
          },
          { ...receipt, triggerId: 'future', status: 'future-state', automaticReplay: true },
        ],
      },
    })!
    expect(diagnostics.runs.map(run => run.status)).toEqual(['unknown', 'succeeded', 'unknown'])
    expect(diagnostics.runs.every(run => run.automaticReplay === false)).toBe(true)
  })
  it('bounds and validates malformed projections, including duplicate trigger identities', () => {
    const diagnostics = automationExecutionDiagnostics({
      executionDiagnostics: {
        runs: [
          null,
          {},
          { ...receipt, status: 'failed', error: { secret: 'invalid' }, coalesced: -3 },
          { ...receipt, status: 'succeeded' },
        ],
      },
    })!
    expect(diagnostics.runs).toHaveLength(1)
    expect(diagnostics.runs[0].error).toBeNull()
    expect(diagnostics.runs[0].coalesced).toBeUndefined()
  })
})
