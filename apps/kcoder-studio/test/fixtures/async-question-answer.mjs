import assert from 'node:assert/strict';
import { isContract } from '../../shared/generated/validator.mjs';

// Lifecycle tests need a complete saved answer to reach ownership/cleanup logic.
// Keep the prompt independent of the submitted answer's item keys.
export function answeredAsyncQuestion(params) {
  const question = {
    threadId: params.threadId,
    questionId: params.questionId,
    requestId: `request-${params.questionId}`,
    sourceTurnId: 'source-turn',
    toolCallId: `tool-${params.questionId}`,
    createdAtMs: 1,
    revision: params.expectedRevision + 1,
    status: 'queued',
    questions: [{ id: 'item', header: 'Original question', question: 'Continue the original task?',
      options: [], multiSelect: false }],
    answer: { acceptedAtMs: 2, submissionId: params.submissionId, answers: params.answers },
  };
  assert.equal(isContract('AsyncQuestionRecord', question), true, 'saved-answer fixture satisfies the wire contract');
  return question;
}
