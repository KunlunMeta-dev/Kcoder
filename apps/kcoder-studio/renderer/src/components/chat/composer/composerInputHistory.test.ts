import { describe, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  ComposerInputHistory,
  composerInputHistory,
  composerInputHistoryScope,
} from './composerInputHistory'

describe('composer input history', () => {
  test('uses stable target and thread identity rather than transient runtime observations', () => {
    const address = {
      deviceId: 'local',
      taskId: 'thread',
      workspacePath: '/workspace',
      phase: 'running',
    }
    const completed = { ...address, phase: 'done' }
    expect(composerInputHistoryScope(address)).toBe(composerInputHistoryScope(completed))
    expect(composerInputHistoryScope(address)).not.toBe(
      composerInputHistoryScope({ ...address, deviceId: 'other' })
    )
  })
  test('returns only user inputs in order, bounded and with consecutive duplicates removed', () => {
    const messages: WorkbenchMessage[] = Array.from({ length: 110 }, (_, index) => ({
      id: String(index),
      role: 'user',
      content: `prompt ${index}`,
      status: 'done',
      createdAt: '',
    }))
    messages.push(
      { id: 'duplicate', role: 'user', content: 'prompt 109', status: 'done', createdAt: '' },
      {
        id: 'assistant',
        role: 'assistant',
        content: 'private reasoning',
        status: 'done',
        createdAt: '',
      },
      { id: 'system', role: 'system', content: 'context', status: 'done', createdAt: '' }
    )
    const history = composerInputHistory(messages)
    expect(history).toHaveLength(100)
    expect(history[0]).toBe('prompt 10')
    expect(history.at(-1)).toBe('prompt 109')
  })

  test('cycles through multiline inputs and restores the original draft and cursor', () => {
    const navigation = new ComposerInputHistory()
    const entries = ['first\n中文🙂', 'second']
    let draft = { value: 'unfinished draft', selectionOffset: 4 }
    const original = draft
    draft = navigation.move('up', entries, draft, true)!
    expect(draft.value).toBe('second')
    draft = navigation.move('up', entries, draft, false)!
    expect(draft.value).toBe('first\n中文🙂')
    expect(navigation.move('up', entries, draft, false)?.value).toBe(draft.value)
    draft = navigation.move('down', entries, draft, false)!
    expect(draft.value).toBe('second')
    expect(navigation.move('down', entries, draft, false)).toEqual(original)
    expect(navigation.move('down', entries, original, true)).toBeNull()
  })

  test('does not replace an editable multiline draft before reaching its first visual row', () => {
    const history = new ComposerInputHistory()
    expect(
      history.move('up', ['older'], { value: 'first\nsecond', selectionOffset: 10 }, false)
    ).toBeNull()
    expect(history.move('up', [], { value: '', selectionOffset: 0 }, true)).toBeNull()
  })

  test('keeps a fixed snapshot when new messages arrive while browsing', () => {
    const history = new ComposerInputHistory()
    const selected = history.move(
      'up',
      ['first', 'second'],
      { value: '', selectionOffset: 0 },
      true
    )!
    expect(history.move('up', ['first', 'second', 'third'], selected, true)?.value).toBe('first')
  })

  test('editing recalled text starts a new draft and resetting fences another conversation', () => {
    const history = new ComposerInputHistory()
    history.move('up', ['older'], { value: 'draft', selectionOffset: 2 }, true)
    expect(
      history.move('down', ['older'], { value: 'older edited', selectionOffset: 12 }, true)
    ).toBeNull()
    history.move('up', ['older'], { value: 'draft', selectionOffset: 2 }, true)
    history.reset()
    expect(
      history.move('down', ['other thread'], { value: '', selectionOffset: 0 }, true)
    ).toBeNull()
  })
})
