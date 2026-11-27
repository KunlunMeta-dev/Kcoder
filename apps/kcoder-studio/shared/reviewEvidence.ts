import { isTurnReviewEvidence } from './generated/contractGuards.mjs'
import type { TurnReviewEvidence } from './generated/contracts.js'

type Binding = { threadId?: string; turnId?: string; attemptId?: string }
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value)
const time = (value: number | null | undefined) => value == null ||
  (Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000)
const path = (value: string) => value.length > 0 && value.length <= 4096 && !value.includes('\0')

export function normalizeReviewEvidence(value: unknown, binding?: Binding): TurnReviewEvidence | undefined {
  if (!isTurnReviewEvidence(value) || value.version !== 1 || !digest(value.evidenceId) || value.observations.length > 32) return undefined
  for (const field of ['threadId', 'turnId', 'attemptId'] as const) {
    const id = value[field]
    if (!id || id.length > 512 || Array.from(id).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      (binding?.[field] !== undefined && id !== binding[field])) return undefined
  }
  const ordinals = new Set<number>()
  for (const entry of value.observations) {
    if (entry.ordinal < 1 || ordinals.has(entry.ordinal) || !entry.toolCallId || entry.toolCallId.length > 512 ||
      !entry.toolName || entry.toolName.length > 128 || (entry.command?.length ?? 0) > 1024 ||
      (entry.outputPreview?.length ?? 0) > 2048 || !time(entry.executionObservedAtMs) || !time(entry.resultObservedAtMs) || entry.artifacts.length > 32) return undefined
    ordinals.add(entry.ordinal)
    if (entry.outcome === 'recorded') {
      if (entry.toolFailed == null || entry.resultObservedAtMs == null) return undefined
    } else if (entry.process || entry.artifacts.length || entry.validation || entry.toolFailed != null) return undefined
    if (entry.process && !path(entry.process.cwd)) return undefined
    if (entry.artifacts.some(file => !path(file.path) || !digest(file.sha256))) return undefined
    const report = entry.validation
    if (report && (!report.runId || report.runId.length > 512 || !digest(report.declarationsSha256) || !time(report.observedAtMs) || report.entries.length > 32 ||
      report.entries.some(check => check.index >= 32 || check.path.length > 4096 ||
        (check.sha256 != null && !digest(check.sha256)) ||
        (check.sizeBytes != null && (!Number.isSafeInteger(check.sizeBytes) || check.sizeBytes < 0))))) return undefined
  }
  if (value.state === 'settled' && (value.omittedCount > 0 || value.observations.some(e => e.detailsTruncated || e.outcome === 'pending' || e.outcome === 'unknown'))) return undefined
  return value.state === 'collecting' ? {
    ...value, state: 'unknown',
    observations: value.observations.map(entry => entry.outcome === 'pending' ? { ...entry, outcome: 'unknown' } : entry),
  } : value
}
