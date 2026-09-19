import { describe, expect, it } from 'vitest'
import { rawDeltaText } from '@/kcoder/gatewayRuntime'

describe('rawDeltaText', () => {
  it('keeps whitespace-only streaming deltas such as a lone newline', () => {
    // Ollama streams newlines as standalone chunks; dropping them collapses
    // the live Markdown into a single paragraph until the persisted text loads.
    expect(rawDeltaText('\n')).toBe('\n')
    expect(rawDeltaText('\n\n')).toBe('\n\n')
    expect(rawDeltaText('  ')).toBe('  ')
    expect(rawDeltaText('plain')).toBe('plain')
    expect(rawDeltaText('')).toBe('')
  })

  it('rejects non-string payloads instead of trimming text', () => {
    expect(rawDeltaText(undefined)).toBeNull()
    expect(rawDeltaText(null)).toBeNull()
    expect(rawDeltaText(42)).toBeNull()
    expect(rawDeltaText({ text: 'x' })).toBeNull()
  })
})
