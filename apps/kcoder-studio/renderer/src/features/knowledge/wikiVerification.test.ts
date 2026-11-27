import { describe, expect, test } from 'vitest'
import {
  readableWikiOutcome,
  wikiDecisionFailure,
  wikiFindingCodeKey,
  wikiJobNoticeKey,
  wikiPendingReasonKey,
  wikiTitleRanges,
  wikiVerdictKey,
  wikiVerificationSegments,
  wikiVerificationView,
} from './wikiVerification'

const outcome = {
  publishedPages: 3,
  verifiedUnits: 5,
  unverified: { unsupported: 1, uncertain: 2, unassessed: 0 },
  pendingUnits: 1,
  withheldUpdates: 1,
  toolTurns: 4,
  toolCalls: 9,
}

describe('Wiki verification projection', () => {
  test('only partial and unassessed pages warn; legacy and human edits stay neutral', () => {
    expect(wikiVerificationView({ status: 'partial', unverified: [] })?.tone).toBe('warning')
    expect(wikiVerificationView({ status: 'unassessed' })?.tone).toBe('warning')
    expect(wikiVerificationView({ status: 'verified' })?.tone).toBe('success')
    expect(wikiVerificationView({ status: 'legacy' })?.tone).toBe('neutral')
    expect(wikiVerificationView({ status: 'human_edited' })?.tone).toBe('neutral')
    expect(wikiVerificationView(undefined)).toBeUndefined()
    expect(wikiVerificationView({ status: 'future' as never, unverified: [] })).toBeUndefined()
    // Malformed ranges are dropped rather than highlighting arbitrary text.
    expect(
      wikiVerificationView({
        status: 'partial',
        unverified: [
          { firstLine: 4, lastLine: 2, verdict: 'uncertain' },
          { firstLine: 1, lastLine: 1, verdict: 'unsupported' },
        ],
      })?.ranges
    ).toEqual([{ firstLine: 1, lastLine: 1, verdict: 'unsupported' }])
  })

  test('segments follow Markdown blocks and keep fenced code intact', () => {
    const markdown = [
      'Intro paragraph',
      '',
      'Claim one',
      'continues here',
      '',
      '```',
      'code',
      '',
      'still code',
      '```',
      '',
      'Tail',
    ].join('\n')
    const segments = wikiVerificationSegments(markdown, [
      { firstLine: 4, lastLine: 4, verdict: 'unsupported' },
      { firstLine: 8, lastLine: 8, verdict: 'uncertain' },
    ])
    expect(segments.map(segment => [segment.markdown, segment.ranges.map(r => r.verdict)])).toEqual(
      [
        ['Intro paragraph', []],
        ['Claim one\ncontinues here', ['unsupported']],
        ['```\ncode\n\nstill code\n```', ['uncertain']],
        ['Tail', []],
      ]
    )
    expect(wikiVerificationSegments(markdown, [])).toEqual([{ markdown, ranges: [] }])
  })

  test('the hidden duplicate title shifts body lines and maps to the title', () => {
    // Stored body "# Title\n\nBody": the reader hides two lines before "Body".
    const ranges = [
      { firstLine: 0, lastLine: 0, verdict: 'unassessed' as const },
      { firstLine: 3, lastLine: 3, verdict: 'uncertain' as const },
    ]
    const segments = wikiVerificationSegments('Body\n\nNext', ranges, 2)
    expect(segments[0]).toEqual({ markdown: 'Body', ranges: [ranges[1]] })
    expect(segments[1]).toEqual({ markdown: 'Next', ranges: [] })
    expect(wikiTitleRanges(ranges, 2)).toEqual([ranges[0]])
  })

  test('unknown protocol codes fall back to generic labels', () => {
    expect(wikiVerdictKey('uncertain')).toBe('verification.verdict.uncertain')
    expect(wikiVerdictKey('later')).toBe('verification.verdict.unknown')
    expect(wikiFindingCodeKey('wiki_support_schema')).toBe('verification.code.wiki_support_schema')
    expect(wikiFindingCodeKey('wiki_support_future')).toBe('verification.code.unknown')
    expect(wikiPendingReasonKey('wiki_page_withheld')).toBe(
      'pendingUnits.reason.wiki_page_withheld'
    )
    expect(wikiPendingReasonKey('other')).toBe('pendingUnits.reason.unknown')
    expect(wikiJobNoticeKey('wiki_organization_model_rebound')).toBe(
      'jobNotices.wiki_organization_model_rebound'
    )
    expect(wikiJobNoticeKey('raw provider text')).toBeUndefined()
  })

  test('decision failures that need a reload are distinguished from unknown outcomes', () => {
    expect(
      wikiDecisionFailure(new Error('Wiki page changed; reload it before deciding this finding'))
    ).toBe('pageChanged')
    expect(wikiDecisionFailure(new Error('idempotency conflict'))).toBe('idempotencyConflict')
    expect(wikiDecisionFailure(new Error('connection closed'))).toBe('other')
  })

  test('malformed outcomes are not rendered', () => {
    expect(readableWikiOutcome(outcome)).toBe(outcome)
    expect(readableWikiOutcome({ ...outcome, verifiedUnits: -1 })).toBeUndefined()
    expect(readableWikiOutcome({ ...outcome, unverified: undefined as never })).toBeUndefined()
  })
})
