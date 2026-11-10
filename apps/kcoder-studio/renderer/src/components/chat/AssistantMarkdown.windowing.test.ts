import { describe, expect, test } from 'vitest'
import { splitStaticMarkdownChunks } from './assistantMarkdownWindowing'

function longSection(index: number): string {
  return [
    `### Section ${index}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Index | ${index} |`,
    '',
    '```ts',
    `export const section${index} = true`,
    '```',
    '',
    'x'.repeat(180),
  ].join('\n')
}

describe('splitStaticMarkdownChunks', () => {
  test('keeps ordinary messages in one renderer', () => {
    expect(splitStaticMarkdownChunks('### Short\n\nMessage')).toEqual(['### Short\n\nMessage'])
  })

  test('windows long markdown only at headings outside code fences', () => {
    const content = Array.from({ length: 50 }, (_, index) => longSection(index + 1)).join('\n')

    const chunks = splitStaticMarkdownChunks(content)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(content)
    expect(chunks.every(chunk => (chunk.match(/```/g)?.length ?? 0) % 2 === 0)).toBe(true)
  })

  test.each(['`', '~'])('does not split inside a longer %s code fence', marker => {
    const content = [
      marker.repeat(4),
      'code inside\n'.repeat(130),
      marker.repeat(3),
      '# Still inside the code block',
      `${marker.repeat(4)}not a closing fence`,
      '# Also inside the code block',
      marker.repeat(4),
      '# Outside the code block',
    ].join('\n')

    const chunks = splitStaticMarkdownChunks(content, 0)

    expect(chunks.join('')).toBe(content)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toContain('# Also inside the code block')
    expect(chunks[1]).toBe('# Outside the code block')
  })
})
