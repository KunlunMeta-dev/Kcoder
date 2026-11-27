import { describe, expect, test } from 'vitest'
import {
  appendArtifactPage,
  markCommandApplied,
  mergeCommandReceipt,
} from './subagentWorkspaceState'

describe('subagent workspace projections', () => {
  const command = { clientMessageId: 'client-1', message: 'adjust target', status: 'unknown' }
  const receipt = {
    agentId: 'agent-1',
    clientMessageId: 'client-1',
    messageId: 'msg-1',
    accepted: true,
    queued: true,
    status: 'queued_live',
  }

  test('unknown observation keeps identity and application cannot regress after a late receipt', () => {
    const applied = markCommandApplied(command, ['msg-1'], 'client-1')
    expect(mergeCommandReceipt(applied, receipt)).toMatchObject({
      status: 'applied',
      messageId: 'msg-1',
    })
    expect(mergeCommandReceipt(command, { ...receipt, clientMessageId: 'another' })).toBe(command)
    expect(markCommandApplied(command, ['another'], 'another')).toBe(command)
    const known = { ...command, messageId: 'msg-1' }
    expect(markCommandApplied(known, ['different'], 'client-1')).toBe(known)
  })

  test('mismatched server identity cannot replace a known receipt', () => {
    const known = { ...command, messageId: 'original' }
    expect(mergeCommandReceipt(known, receipt)).toBe(known)
  })

  test('only contiguous pages from the same snapshot can combine', () => {
    const first = {
      content: '你好',
      offset: 0,
      nextOffset: 6,
      revision: 'r1',
      size: 9,
      truncated: true,
    }
    const next = { content: '！', offset: 6, revision: 'r1', size: 9, truncated: false }
    expect(appendArtifactPage(first, next)?.content).toBe('你好！')
    expect(appendArtifactPage(first, { ...next, revision: 'r2' })).toBeNull()
    expect(appendArtifactPage(first, { ...next, offset: 7 })).toBeNull()
    expect(appendArtifactPage(first, { ...next, offset: 0 })).toEqual({ ...next, offset: 0 })
  })
})
