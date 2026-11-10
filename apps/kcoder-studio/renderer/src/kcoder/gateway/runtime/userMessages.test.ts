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
