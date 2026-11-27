import type {
  WikiJobOutcome,
  WikiPageVerification,
  WikiPageUnverifiedLines,
} from '@/kcoder/knowledgeApi'
import { knownWikiCount } from './wikiPipeline'

export const WIKI_UNVERIFIED_VERDICTS = ['unsupported', 'uncertain', 'unassessed'] as const
const verificationStatuses = ['verified', 'partial', 'unassessed', 'legacy', 'human_edited']
const findingCodes = new Set([
  'wiki_support_unsupported',
  'wiki_support_uncertain',
  'wiki_support_verdict_missing',
  'wiki_support_verdict_duplicate',
  'wiki_support_schema',
  'wiki_support_budget_unassessed',
  'wiki_support_context_unassessed',
])
const pendingReasons = new Set([
  'wiki_organization_plan_missing',
  'wiki_organization_unit_unplaced',
  'wiki_page_withheld',
  'wiki_organization_uncertain_disposition',
  'wiki_organization_unverified',
  'wiki_organization_verdict_missing',
  'wiki_organization_verdict_duplicate',
  'wiki_organization_unassessed',
])
const jobNotices = new Set([
  'wiki_generation_restarted_for_file_contract',
  'wiki_organization_model_rebound',
])

/** Unknown protocol values map to a generic label rather than a raw code. */
export function wikiVerdictKey(verdict: string) {
  return (WIKI_UNVERIFIED_VERDICTS as readonly string[]).includes(verdict)
    ? `verification.verdict.${verdict}`
    : 'verification.verdict.unknown'
}
export function wikiFindingCodeKey(code: string) {
  return findingCodes.has(code) ? `verification.code.${code}` : 'verification.code.unknown'
}
export function wikiPendingReasonKey(code: string) {
  return pendingReasons.has(code) ? `pendingUnits.reason.${code}` : 'pendingUnits.reason.unknown'
}
export function wikiJobNoticeKey(notice: string | null | undefined) {
  return notice && jobNotices.has(notice) ? `jobNotices.${notice}` : undefined
}

export type WikiVerificationTone = 'success' | 'warning' | 'neutral'
/**
 * Only partial/unassessed pages warn. Legacy and human-edited pages are
 * neutral facts, and an unknown status is not presented at all.
 */
export function wikiVerificationView(verification: WikiPageVerification | null | undefined) {
  if (!verification || !verificationStatuses.includes(verification.status)) return undefined
  const ranges = (verification.unverified ?? []).filter(
    range =>
      knownWikiCount(range.firstLine) &&
      knownWikiCount(range.lastLine) &&
      range.lastLine >= range.firstLine
  )
  const tone: WikiVerificationTone =
    verification.status === 'verified'
      ? 'success'
      : verification.status === 'partial' || verification.status === 'unassessed'
        ? 'warning'
        : 'neutral'
  return { status: verification.status, tone, ranges }
}

/** Line 0 is the page title; body lines are 1-based. */
export function wikiLineRangeLabel(
  range: { firstLine: number; lastLine: number },
  t: (key: string, options?: Record<string, unknown>) => string
) {
  if (range.firstLine === 0 && range.lastLine === 0) return t('verification.titleLine')
  return t('sourceLines', { start: Math.max(1, range.firstLine), end: range.lastLine })
}

export interface WikiMarkdownSegment {
  markdown: string
  /** Unverified ranges touching this segment; empty for ordinary content. */
  ranges: WikiPageUnverifiedLines[]
}

const fencePattern = /^ {0,3}(`{3,}|~{3,})/

/**
 * Split displayed Markdown into block-aligned segments so unverified body
 * lines can be highlighted without cutting a paragraph, fence or table.
 * `lineOffset` counts original body lines removed before `markdown` starts.
 */
export function wikiVerificationSegments(
  markdown: string,
  ranges: WikiPageUnverifiedLines[],
  lineOffset = 0
): WikiMarkdownSegment[] {
  const bodyRanges = ranges.filter(range => range.lastLine > lineOffset)
  if (!bodyRanges.length) return [{ markdown, ranges: [] }]
  const lines = markdown.split(/\r?\n/)
  const blocks: Array<{ start: number; end: number }> = []
  let fence: string | undefined
  let start: number | undefined
  lines.forEach((line, index) => {
    const marker = fencePattern.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
    } else if (marker) fence = marker
    if (!fence && !marker && line.trim() === '') {
      if (start !== undefined) blocks.push({ start, end: index - 1 })
      start = undefined
      return
    }
    start ??= index
  })
  if (start !== undefined) blocks.push({ start, end: lines.length - 1 })
  const segments: Array<{ start: number; end: number; key: string; ranges: typeof ranges }> = []
  for (const block of blocks) {
    const first = block.start + 1 + lineOffset
    const last = block.end + 1 + lineOffset
    const touching = bodyRanges.filter(range => range.firstLine <= last && range.lastLine >= first)
    const key = touching.map(range => bodyRanges.indexOf(range)).join(',')
    const previous = segments.at(-1)
    if (previous && previous.key === key) previous.end = block.end
    else segments.push({ start: block.start, end: block.end, key, ranges: touching })
  }
  return segments.map(segment => ({
    markdown: lines.slice(segment.start, segment.end + 1).join('\n'),
    ranges: segment.ranges,
  }))
}

/** Ranges touching the title line or lines removed before the displayed body. */
export function wikiTitleRanges(ranges: WikiPageUnverifiedLines[], lineOffset = 0) {
  return ranges.filter(range => range.firstLine <= lineOffset)
}

export function wikiUnverifiedTotal(outcome: WikiJobOutcome) {
  const unverified = outcome.unverified
  return unverified.unsupported + unverified.uncertain + unverified.unassessed
}

/** Malformed outcomes are not rendered; counts are never merged across kinds. */
export function readableWikiOutcome(outcome: WikiJobOutcome | null | undefined) {
  if (!outcome || !outcome.unverified) return undefined
  const counts = [
    outcome.publishedPages,
    outcome.verifiedUnits,
    outcome.pendingUnits,
    outcome.withheldUpdates,
    outcome.unverified.unsupported,
    outcome.unverified.uncertain,
    outcome.unverified.unassessed,
  ]
  return counts.every(knownWikiCount) ? outcome : undefined
}

export type WikiDecisionFailure = 'pageChanged' | 'idempotencyConflict' | 'other'
/** Host errors that require a reload instead of a retry. */
export function wikiDecisionFailure(cause: unknown): WikiDecisionFailure {
  const message = String(cause instanceof Error ? cause.message : cause)
  if (/Wiki page changed/i.test(message)) return 'pageChanged'
  if (/idempotency conflict/i.test(message)) return 'idempotencyConflict'
  return 'other'
}

export function wikiRequestKey(prefix: string) {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}:${random}`
}
