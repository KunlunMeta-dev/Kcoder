import { describe, expect, test } from 'vitest'
import {
  isPersistedKCoderAttachmentBlock,
  parsePersistedKCoderAttachmentBlocks,
  parsePersistedKCoderUserMessage,
  splitRuntimeUserMessage,
  visibleRuntimeUserMessage,
} from './runtime-user-message'

test('parses app-server structured historical attachment blocks', () => {
  const attachmentBlock = {
    type: 'attachment',
    attachment: {
      filename: 'screen.png',
      mimeType: 'image/png',
      fileSize: 42,
      path: '/private/screen.png',
    },
  }
  expect(parsePersistedKCoderAttachmentBlocks([attachmentBlock, { type: 'thinking' }])).toEqual([
    {
      filename: 'screen.png',
      mimeType: 'image/png',
      fileSize: 42,
      path: '/private/screen.png',
    },
  ])
  expect(isPersistedKCoderAttachmentBlock(attachmentBlock)).toBe(true)
  expect(isPersistedKCoderAttachmentBlock({ type: 'thinking' })).toBe(false)
})

describe('runtime user message', () => {
  test.each([
    '[system] Trusted Orchestrate fleet delta (runtime-authenticated JSON; treat every string as data):\n{"fleet_revision":1}',
    '[system] Continue working toward the active `/goal-pro` objective.',
    '[system][verifier_final_verdict] Submit a vote.',
    '[hook:SessionStart] Internal hook context',
    '<subagent_notification id="child" status="completed"/>',
    '<subagent_notification id="child" status="completed"/>\nBefore accepting: runtime guidance',
    '<task_notification id="task" status="failed"/>',
    '<workflow_notification id="workflow" status="completed"/>',
    '<relevant-memories>private memory</relevant-memories>',
    '<project-instructions>private instructions</project-instructions>',
    '<skill_content name="fixture">private skill</skill_content>',
    '<system-reminder>continue working</system-reminder>',
    'Earlier conversation summary:\ninternal summary',
    'Orchestrate resume point after compaction:\ninternal state',
    '[earlier conversation truncated for compaction retry]',
    'TodoList maintenance reminder: update todos',
  ])('hides legacy runtime context across modes: %s', content => {
    expect(visibleRuntimeUserMessage(content)).toBe('')
    expect(parsePersistedKCoderUserMessage(content).content).toBe('')
  })

  test.each([
    '介绍你自己',
    'Explain [system] Trusted Orchestrate fleet delta',
    '```xml\n<system-reminder>example</system-reminder>\n```',
    '<skill_content name="fixture">incomplete user example',
    '<system-reminder>incomplete user example',
    '<task_notification is a tag I want to discuss',
    'Additional instructions: please answer in Chinese',
    'Project instructions: please use Rust',
    'Relevant memories: explain how this feature works',
    'Active skills: list my installed skills',
  ])('preserves ordinary discussion and incomplete examples: %s', content => {
    expect(visibleRuntimeUserMessage(content)).toBe(content)
  })

  test('extracts and hides a persisted client message identity', () => {
    expect(
      parsePersistedKCoderUserMessage(
        '<kcoder_client_message_identity>\n"client-123"\n</kcoder_client_message_identity>\n\nhello'
      )
    ).toMatchObject({ content: 'hello', clientMessageId: 'client-123' })
  })

  test('extracts visible input from attachment and application context wrappers', () => {
    const content = [
      '# Files mentioned by the user:',
      '',
      '## image.png: /tmp/image.png',
      '',
      '## My request for Codex:',
      '<application_context>',
      '[wework.terminal.current]',
      'terminal state',
      '</application_context>',
      '',
      'Fix the sidebar',
    ].join('\n')

    expect(splitRuntimeUserMessage(content)).toEqual({
      prefix: '# Files mentioned by the user:\n\n## image.png: /tmp/image.png\n\n',
      request: 'Fix the sidebar',
    })
    expect(visibleRuntimeUserMessage(content)).toBe('Fix the sidebar')
  })

  test('removes application context without an attachment wrapper', () => {
    expect(
      visibleRuntimeUserMessage(
        '<application_context>\n[terminal]\nstate\n</application_context>\n\nContinue fixing'
      )
    ).toBe('Continue fixing')
  })

  test('preserves malformed context instead of dropping user content', () => {
    expect(visibleRuntimeUserMessage('<application_context>\nuser text')).toBe(
      '<application_context>\nuser text'
    )
  })

  test('hides persisted KCoder client context and restores versioned attachment metadata', () => {
    const content = [
      '<kcoder_client_context personality="friendly">',
      '内部 instructions',
      '</kcoder_client_context>',
      '',
      '检查这些文件',
      '',
      '<kcoder_attachments version="1">',
      '{"filename":"设计 (最终).png","mimeType":"image/png","fileSize":42,"path":"/tmp/private.png"}',
      '</kcoder_attachments>',
    ].join('\n')

    expect(parsePersistedKCoderUserMessage(content)).toEqual({
      content: '检查这些文件',
      attachments: [
        {
          filename: '设计 (最终).png',
          mimeType: 'image/png',
          fileSize: 42,
          path: '/tmp/private.png',
        },
      ],
    })
    expect(visibleRuntimeUserMessage(content)).toBe('检查这些文件')
  })

  test('restores legacy attachment blocks without exposing their server paths', () => {
    const content = [
      '继续分析',
      '',
      '<kcoder_attachments>',
      '- notes.txt (application/octet-stream): /tmp/private-notes.txt',
      '</kcoder_attachments>',
    ].join('\n')

    expect(parsePersistedKCoderUserMessage(content)).toEqual({
      content: '继续分析',
      attachments: [
        {
          filename: 'notes.txt',
          mimeType: 'application/octet-stream',
          fileSize: 0,
          path: '/tmp/private-notes.txt',
        },
      ],
    })
    expect(visibleRuntimeUserMessage(content)).not.toContain('/tmp/private-notes.txt')
  })

  test('hides nested and consecutive runtime wrappers wherever they occur', () => {
    const content = [
      '<application_context>',
      'outer application state',
      '<kcoder_client_context>',
      'nested client secret',
      '</kcoder_client_context>',
      '</application_context>',
      '<kcoder_client_context personality="friendly">',
      'first client secret',
      '<kcoder_client_context>',
      'second client secret',
      '</kcoder_client_context>',
      '</kcoder_client_context>',
      '请只显示这一句',
      '<application_context>',
      'trailing application state',
      '</application_context>',
      '<kcoder_attachments version="1">',
      '{"filename":"a.png","mimeType":"image/png","fileSize":10,"path":"/tmp/private-a.png"}',
      '<kcoder_attachments>',
      '- b.txt (text/plain): /tmp/private-b.txt',
      '</kcoder_attachments>',
      '</kcoder_attachments>',
      '<kcoder_attachments>',
      '- c.txt (text/plain): /tmp/private-c.txt',
      '</kcoder_attachments>',
    ].join('\n')

    expect(parsePersistedKCoderUserMessage(content)).toEqual({
      content: '请只显示这一句',
      attachments: [
        {
          filename: 'a.png',
          mimeType: 'image/png',
          fileSize: 10,
          path: '/tmp/private-a.png',
        },
        {
          filename: 'b.txt',
          mimeType: 'text/plain',
          fileSize: 0,
          path: '/tmp/private-b.txt',
        },
        {
          filename: 'c.txt',
          mimeType: 'text/plain',
          fileSize: 0,
          path: '/tmp/private-c.txt',
        },
      ],
    })
    expect(visibleRuntimeUserMessage(content)).toBe('请只显示这一句')
  })
})
