import { describe, expect, test } from 'vitest'
import { subagentArtifactKindFromPath } from './subagent-artifact'

describe('subagentArtifactKindFromPath', () => {
  test('recognizes both report kinds for POSIX and Windows spellings', () => {
    expect(
      subagentArtifactKindFromPath('/root/projects/p/session-1/subagents/agent-1/output.md')
    ).toBe('output')
    expect(
      subagentArtifactKindFromPath('/root/projects/p/session-1/subagents/agent-1/transcript.json')
    ).toBe('transcript')
    expect(
      subagentArtifactKindFromPath(
        'C:\\Users\\x\\.kcoder\\projects\\p\\s\\subagents\\agent-1\\output.md'
      )
    ).toBe('output')
    expect(
      subagentArtifactKindFromPath('C:/Users/x/.kcoder/projects/p/s/subagents/agent-1/output.md')
    ).toBe('output')
    expect(subagentArtifactKindFromPath('  /root/subagents/agent-1/transcript.json  ')).toBe(
      'transcript'
    )
  })

  test('rejects paths that are not sub-agent reports', () => {
    expect(subagentArtifactKindFromPath('/root/subagents/agent-1/notes.md')).toBeNull()
    expect(subagentArtifactKindFromPath('/root/subagents/agent-1/transcript.jsonl')).toBeNull()
    expect(subagentArtifactKindFromPath('/root/subagents/agent-1/output.md.bak')).toBeNull()
    expect(subagentArtifactKindFromPath('/root/projects/p/session-1/output.md')).toBeNull()
    expect(subagentArtifactKindFromPath('/root/projects/p/session-1/transcript.json')).toBeNull()
    expect(subagentArtifactKindFromPath('/root/projects/p/subagents/agent-1')).toBeNull()
    expect(subagentArtifactKindFromPath('/root/projects/p/subagents/agent-1/')).toBeNull()
    expect(subagentArtifactKindFromPath('output.md')).toBeNull()
    expect(subagentArtifactKindFromPath('')).toBeNull()
  })
})
