import { describe, expect, test } from 'vitest'
import { SubagentCommandJournal, subagentCommandDigest } from './subagentCommandJournal'

function storage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

describe('client subagent observation journal', () => {
  const command = {
    clientMessageId: 'cmd:0:identity',
    message: 'adjust the goal',
    status: 'queued_live',
    messageId: 'msg-1',
  }

  test('refresh preserves identity and body while treating cached acceptance as unknown', () => {
    const store = storage()
    const first = new SubagentCommandJournal(store, 'target/account/parent/agent')
    first.remember(command)
    const restored = new SubagentCommandJournal(store, 'target/account/parent/agent')
    expect(restored.load()[0]).toMatchObject({
      clientMessageId: command.clientMessageId,
      messageId: 'msg-1',
      bodyDigest: subagentCommandDigest(command.message),
      status: 'unknown',
    })
    expect(restored.load()[0]).not.toHaveProperty('message')
    expect(
      store.getItem('kcoder.subagent.pendingCommands.v1:target/account/parent/agent')
    ).not.toContain(command.message)
    expect(new SubagentCommandJournal(store, 'other-account/parent/agent').load()).toEqual([])
    restored.update({ ...command, status: 'applied' })
    expect(restored.load()).toEqual([])
  })

  test('identity conflicts and quota failures cannot evict an unconfirmed recovery handle', () => {
    const journal = new SubagentCommandJournal(storage(), 'scope')
    journal.remember(command)
    expect(() => journal.remember({ ...command, message: 'different' })).toThrow(
      'identity conflict'
    )
    for (let index = 1; index < 256; index += 1)
      journal.remember({ ...command, clientMessageId: `cmd:0:${index}` })
    expect(() => journal.remember({ ...command, clientMessageId: 'cmd:0:overflow' })).toThrow(
      'full'
    )
    expect(journal.load()).toHaveLength(256)
    expect(journal.load()[0].clientMessageId).toBe(command.clientMessageId)
  })

  test('confirmed epoch archival retires obsolete handles without sending or storing bodies', () => {
    const journal = new SubagentCommandJournal(storage(), 'scope')
    journal.remember(command)
    journal.remember({ ...command, clientMessageId: 'cmd:1:newer', message: 'newer intent' })
    journal.retireBeforeEpoch(1)
    expect(journal.load()).toHaveLength(1)
    expect(journal.load()[0].clientMessageId).toBe('cmd:1:newer')
    expect(journal.load()[0].status).toBe('unknown')
  })
})
