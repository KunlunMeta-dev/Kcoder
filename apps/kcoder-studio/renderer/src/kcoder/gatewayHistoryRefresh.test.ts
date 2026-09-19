import { describe, expect, test } from 'vitest'
import { historyRefreshResult } from './gatewayHistoryRefresh'

describe('historyRefreshResult', () => {
  test('parses per-entry issue details', () => {
    const result = historyRefreshResult({
      status: 'incomplete',
      examinedEntries: 9,
      indexedSessions: 2,
      issueCount: 2,
      issues: [
        { sessionId: 'abc123', reason: 'history source record is corrupt' },
        { reason: 'old.jsonl: unsupported history source version' },
      ],
    })
    expect(result.issues).toEqual([
      { sessionId: 'abc123', reason: 'history source record is corrupt' },
      { reason: 'old.jsonl: unsupported history source version' },
    ])
  })

  test('omits issues when the response has none and filters malformed entries', () => {
    const ready = historyRefreshResult({
      status: 'ready',
      examinedEntries: 3,
      indexedSessions: 3,
      issueCount: 0,
    })
    expect(ready.issues).toBeUndefined()

    const incomplete = historyRefreshResult({
      status: 'incomplete',
      examinedEntries: 3,
      indexedSessions: 1,
      issueCount: 2,
      issues: [
        { sessionId: 'ok', reason: 'fine' },
        { sessionId: 42 },
        'not-an-object',
        null,
      ],
    })
    expect(incomplete.issues).toEqual([{ sessionId: 'ok', reason: 'fine' }])
  })

  test('caps collected issue details at twenty entries', () => {
    const issues = Array.from({ length: 30 }, (_, index) => ({
      sessionId: `s${index}`,
      reason: `r${index}`,
    }))
    const result = historyRefreshResult({
      status: 'incomplete',
      examinedEntries: 30,
      indexedSessions: 0,
      issueCount: 30,
      issues,
    })
    expect(result.issues).toHaveLength(20)
    expect(result.issues![0].sessionId).toBe('s0')
    expect(result.issues![19].sessionId).toBe('s19')
  })
})
