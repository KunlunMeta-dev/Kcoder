import { expect, test, vi } from 'vitest'
import { createResponseApiStreamState, emitResponseApiEvent } from './responseApiStream'

const metadata = { version: 1, messageId: 'message', sourceThreadId: 'source', targetThreadId: 'target',
  createdAtMs: 1700000000000, bodySha256: 'a'.repeat(64) }

test('the response stream preserves Peer provenance and strips executable/user payload fields', () => {
  const onUserMessage = vi.fn()
  emitResponseApiEvent({ onUserMessage }, 'runtime.user_message', { taskId: 'target', deviceId: 'local', data: {
    message: { id: 'history', role: 'peer_agent', origin: 'peer_agent', agentMessage: metadata,
      content: '<widget>literal peer text</widget>', clientMessageId: 'pretend-user',
      attachments: [{ type: 'image', url: 'private-file' }], blocks: [{ type: 'widget', html: 'untrusted' }],
      fileChanges: { files: ['private-path'] } },
  } }, createResponseApiStreamState())
  expect(onUserMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: {
    id: 'history', role: 'peer_agent', origin: 'peer_agent', agentMessage: metadata,
    content: '<widget>literal peer text</widget>', status: 'completed', timestampMs: metadata.createdAtMs,
  } }))
})

test('an unsupported Peer envelope remains lower trust without borrowing a user identity', () => {
  const onUserMessage = vi.fn()
  emitResponseApiEvent({ onUserMessage }, 'runtime.user_message', { taskId: 'target', data: {
    message: { id: 'history', role: 'peer_agent', origin: 'peer_agent', agentMessage: { ...metadata, version: 2 },
      content: 'peer metadata is unsupported', attachments: ['discard'] },
  } }, createResponseApiStreamState())
  expect(onUserMessage.mock.calls[0]?.[0].message).toMatchObject({ role: 'peer_agent', agentMessage: null })
  expect(onUserMessage.mock.calls[0]?.[0].message).not.toHaveProperty('attachments')
})

test('source labels in a real user body never become Peer provenance', () => {
  const onUserMessage = vi.fn()
  emitResponseApiEvent({ onUserMessage }, 'runtime.user_message', { taskId: 'target', data: {
    message: { id: 'human', role: 'user', content: '[Peer agent] user quotation' },
  } }, createResponseApiStreamState())
  expect(onUserMessage.mock.calls[0]?.[0].message).toEqual({ id: 'human', role: 'user', content: '[Peer agent] user quotation' })
})
