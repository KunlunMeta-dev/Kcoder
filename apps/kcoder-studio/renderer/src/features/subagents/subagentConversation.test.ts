import { describe, expect, it } from 'vitest'
import { subagentConversation } from './subagentConversation'

describe('public subagent conversation presentation', () => {
  it('renders user and Markdown replies with ordinary chat messages and recorded tool results', () => {
    const messages = subagentConversation(
      '[user]\nReview this file\n\n[assistant]\n## Findings\n- One issue\n\n[tool/start call-1] read\n{"file_path":"a.ts"}\n\n[tool/result call-1] completed\nconst a = 1\n\n[assistant]\n**Done**\n',
      'worker'
    )
    expect(messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'assistant',
    ])
    expect(messages[1].content).toBe('## Findings\n- One issue')
    expect(messages[2].blocks?.[0]).toMatchObject({
      toolName: 'read',
      toolInput: { file_path: 'a.ts' },
      toolOutput: 'const a = 1',
      status: 'done',
    })
  })
  it('preserves a partial tail and never infers tool liveness from an unfinished start', () => {
    const messages = subagentConversation(
      'tail of previous output\n\n[tool/start call-1] read\n{"file_path":',
      'worker',
      1000
    )
    expect(messages[0].content).toBe('tail of previous output')
    expect(messages[1].blocks?.[0].status).toBe('unknown')
    expect(messages[1].content).toBe('{"file_path":')
    expect(messages[0].id).toBe('worker:1000')
  })
  it('keeps old plain output and terminal errors visible', () => {
    expect(subagentConversation('**Result**', 'old')[0].content).toBe('**Result**')
    const messages = subagentConversation(
      '[tool/start x] grep\n{}\n\n[tool/result x] error\npath missing\n',
      'old'
    )
    expect(messages[0].blocks?.[0]).toMatchObject({ status: 'error', toolOutput: 'path missing' })
  })
  it('keeps identities stable through Unicode byte tails', () => {
    const first = '[assistant]\n中文内容\n\n'
    const second = '[assistant]\nLater reply\n'
    const full = subagentConversation(first + second, 'worker')
    const tail = subagentConversation(second, 'worker', new TextEncoder().encode(first).byteLength)
    expect(full[1].id).toBe(tail[0].id)
  })
  it('hides the projection version and keeps missing results distinct from completion', () => {
    const records = subagentConversation(
      '<!-- kcoder-public-transcript:v2 -->\n[tool/start call-1] glob\n{}\n\n[tool/result call-1] completed\nsrc/main.rs\n\n[tool/start call-2] read\n{}\n',
      'worker'
    )
    expect(records).toHaveLength(2)
    expect(records[0].blocks?.[0]).toMatchObject({ status: 'done', toolOutput: 'src/main.rs' })
    expect(records[1].blocks?.[0]).toMatchObject({
      status: 'unknown',
      rawStatus: 'result_unrecorded',
    })
    expect(records.some(record => record.content.includes('kcoder-public-transcript'))).toBe(false)
  })
})
