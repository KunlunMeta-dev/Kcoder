/**
 * Identity fields a client must echo when it answers an interaction on a
 * connection that negotiated `interactionBindingV1` (S5/R046).
 *
 * The server rejects an unattributable reply and keeps the interaction pending,
 * so this helper never invents an identity: it reports the missing piece
 * instead of sending a reply that cannot be applied.
 */

export interface InteractionReplyBindingInput {
  requiresBinding: boolean
  approvalId?: string | null
  questionId?: string | null
  threadId?: string | null
  turnId?: string | null
}

export type InteractionReplyBindingResult =
  { ok: true; fields: Record<string, string> } | { ok: false; reason: string }

function present(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function interactionReplyBinding(
  input: InteractionReplyBindingInput
): InteractionReplyBindingResult {
  if (!input.requiresBinding) return { ok: true, fields: {} }

  const approvalId = present(input.approvalId)
  const questionId = present(input.questionId)
  if (approvalId && questionId) {
    return { ok: false, reason: '交互身份同时包含审批与提问，无法归属' }
  }
  const interactionId = approvalId ?? questionId
  if (!interactionId) return { ok: false, reason: '交互身份缺少 approvalId/questionId' }
  const threadId = present(input.threadId)
  if (!threadId) return { ok: false, reason: '交互身份缺少 threadId' }
  const turnId = present(input.turnId)
  if (!turnId) return { ok: false, reason: '交互身份缺少 turnId' }

  return {
    ok: true,
    fields: {
      ...(approvalId ? { approvalId } : { questionId: questionId as string }),
      threadId,
      turnId,
    },
  }
}
