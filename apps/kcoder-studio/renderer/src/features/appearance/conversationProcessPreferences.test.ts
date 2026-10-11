import { beforeEach, expect, test } from 'vitest'
import {
  readConversationProcessingWindow,
  readProcessingWindowDefault,
  rememberConversationProcessingWindow,
  setProcessingWindowDefault,
} from './conversationProcessPreferences'

beforeEach(() => localStorage.clear())

test('new conversations capture the default without changing existing or historical conversations', () => {
  expect(readProcessingWindowDefault()).toBe(false)
  rememberConversationProcessingWindow('local:old')
  setProcessingWindowDefault(true)
  rememberConversationProcessingWindow('local:new')
  expect(readConversationProcessingWindow('local:old')).toBe(false)
  expect(readConversationProcessingWindow('local:historical')).toBe(false)
  expect(readConversationProcessingWindow('local:new')).toBe(true)
  setProcessingWindowDefault(false)
  rememberConversationProcessingWindow('local:new')
  rememberConversationProcessingWindow('ssh:later')
  expect(readConversationProcessingWindow('local:new')).toBe(true)
  expect(readConversationProcessingWindow('ssh:later')).toBe(false)
})

test('resolved task identities preserve the creation-time mode even if the default has changed', () => {
  setProcessingWindowDefault(true)
  rememberConversationProcessingWindow('ssh:optimistic')
  setProcessingWindowDefault(false)
  rememberConversationProcessingWindow(
    'ssh:resolved',
    readConversationProcessingWindow('ssh:optimistic')
  )
  expect(readConversationProcessingWindow('ssh:resolved')).toBe(true)
  expect(readConversationProcessingWindow('other-host:resolved')).toBe(false)
})
