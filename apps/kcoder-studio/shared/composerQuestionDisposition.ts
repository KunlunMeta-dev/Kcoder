import type { AsyncQuestionRecord } from './generated/contracts'

/** Presentation state for a status surfaced beside the composer. */
export type StatusDisposition = 'active' | 'attention' | 'hidden'

export function getQuestionDisposition(record: AsyncQuestionRecord): StatusDisposition {
  switch (record.status) {
    case 'pending':
    case 'answer_saved':
    case 'queued':
      return 'active'
    case 'delivery_failed':
    case 'delivery_unknown':
      return 'attention'
    case 'context_applied':
    case 'cancelled':
    case 'stale':
      return 'hidden'
  }
}
