import { expect, test } from 'vitest'
import { visibleUserItem } from './userMessages'

test('uses the original input identity and hides the same context as restored history', () => {
  const item = { id: 'history-id', type: 'userMessage', content: {
    id: 'history-id', clientMessageId: 'original-input', role: 'user',
    content: '<application_context>Private context</application_context>\nVisible input',
    timestampMs: 1700000000000, contentTruncated: true, contentOriginalChars: 900000,
  } }
  expect(visibleUserItem(item)).toMatchObject({ id: 'history-id', clientMessageId: 'original-input',
    role: 'user', content: 'Visible input', contentTruncated: true, contentOriginalChars: 900000 })
})

test.each([
  { id: 'not-user', type: 'toolCall', content: { role: 'user', content: 'wrong kind' } },
  { id: 'system', type: 'userMessage', content: { role: 'system', content: 'private system' } },
  { id: 'empty', type: 'userMessage', content: { role: 'user', content: '' } },
])('does not turn other content into a visible input: $id', item => {
  expect(visibleUserItem(item)).toBeNull()
})

test('reads a top-level peer completion as plain peer text even when the provenance is malformed', () => {
  const content = '<application_context>peer context is visible text</application_context>'
  expect(visibleUserItem({ id: 'peer-history', type: 'peerAgentMessage', text: content,
    agentMessage: { version: 1, sourceThreadId: 'forged' } })).toMatchObject({
    id: 'peer-history', role: 'peer_agent', origin: 'peer_agent', content, agentMessage: null,
  })
})
