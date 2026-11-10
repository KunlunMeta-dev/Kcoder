import { ASYNC_ANSWER_FINGERPRINT, asyncAnswerFingerprint } from './broker-async-question-answer.js';

export const ASYNC_QUESTIONS_CAPABILITY = 'asyncUserQuestionsV1';
export const ASYNC_QUESTION_METHODS = new Set(['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']);

export function supportsAsyncQuestions(client, experimental) {
  return client?.initialized === true && client.channel === 'runtime' &&
    client[ASYNC_QUESTIONS_CAPABILITY] === true && experimental?.[ASYNC_QUESTIONS_CAPABILITY] === true;
}

export function asyncQuestionAdmissionError(request, client, experimental) {
  if (!ASYNC_QUESTION_METHODS.has(request.method)) return null;
  if (!supportsAsyncQuestions(client, experimental)) return 'asyncUserQuestionsV1 negotiation is required';
  if (!['string', 'number'].includes(typeof request.id)) return 'Async question operations require a request ID';
  if (typeof request.params?.threadId !== 'string' || !request.params.threadId.trim() ||
      request.params.threadId.length > 512 || /[\x00-\x1f\x7f]/.test(request.params.threadId))
    return 'Async question operations require an explicit threadId';
  return null;
}

// Backend capability aggregation never grants an older presentation new tools.
export function projectAsyncQuestionRequest(request, client, experimental) {
  if (!['turn/start', 'tools/catalog', 'asyncQuestion/answer'].includes(request.method)) return request;
  const { asyncUserQuestions: requested, ...params } = request.params ?? {};
  return { ...request, params: { ...params, ...(experimental?.[ASYNC_QUESTIONS_CAPABILITY] === true
    ? { asyncUserQuestions: supportsAsyncQuestions(client, experimental) && requested !== false } : {}) } };
}

export function projectAsyncQuestionCapabilities(experimental, client) {
  if (!Object.hasOwn(experimental ?? {}, ASYNC_QUESTIONS_CAPABILITY)) return experimental;
  return { ...experimental, [ASYNC_QUESTIONS_CAPABILITY]: supportsAsyncQuestions(client, experimental) };
}

export function allowsAsyncQuestionNotification(message, client, experimental) {
  if (message.method !== 'asyncQuestion/changed') return true;
  const params = message.params;
  // Check the routing identity before sending question content to any client.
  // Without it, the broker's threadless notification path would broadcast it.
  return supportsAsyncQuestions(client, experimental) &&
    typeof params?.threadId === 'string' && Boolean(params.threadId.trim()) &&
    params.question?.threadId === params.threadId &&
    // Uncorrelatable updates cannot refresh a card, and must not consume the
    // bounded resume queue before a client can reject their identity.
    typeof params.question.questionId === 'string' && Boolean(params.question.questionId.trim()) &&
    // Match State's identifier byte budget before reserving resume capacity.
    Buffer.byteLength(params.question.questionId, 'utf8') <= 256 &&
    Number.isSafeInteger(params.question.revision) && params.question.revision > 0;
}

// Correlation IDs route responses, but do not certify their task or answer
// binding. Fence receipts before the broker changes ownership or cancels a turn.
export function projectAsyncQuestionResponse(response, pending) {
  if (!ASYNC_QUESTION_METHODS.has(pending.method) || response.error) return response;
  const result = response.result, params = pending.params;
  const boundQuestion = question => typeof params?.threadId === 'string' &&
    question?.threadId === params.threadId;
  let bound = typeof params?.threadId === 'string' && result?.threadId === params.threadId;
  // A result is not another RPC envelope. The generic routing parser unwraps
  // params before threadId, which could override this verified task identity.
  bound &&= result?.params == null;
  if (pending.method === 'asyncQuestion/list') {
    // Duplicate IDs cannot identify which prompt, revision or saved answer a
    // client card owns. Reject the whole snapshot instead of choosing a winner.
    bound &&= Array.isArray(result?.questions) && result.questions.every(boundQuestion) &&
      new Set(result.questions.map(question => question.questionId)).size === result.questions.length;
  } else {
    bound &&= typeof params?.questionId === 'string' && boundQuestion(result?.question) &&
      result.question.questionId === params.questionId;
    // Client validation runs after Gateway ownership and disconnect cleanup.
    // Unconfirmed answer receipts must fail before either side effect.
    if (pending.method === 'asyncQuestion/answer') {
      bound &&= typeof result?.accepted === 'boolean' && typeof result?.duplicate === 'boolean';
    }
    if (pending.method === 'asyncQuestion/answer' && result?.startedTurn != null) {
      // A running status alone cannot identify execution. Reject before the
      // broker transfers ownership or interrupts an unconfirmed turn on detach.
      bound &&= typeof result.startedTurn.id === 'string' && Boolean(result.startedTurn.id.trim());
      // A nested turn identity cannot override the original question's task.
      // Preserve older responses without this field, but fence explicit task
      // mismatches before ownership tracking or disconnected-client cleanup.
      bound &&= result.startedTurn.threadId === undefined ||
        result.startedTurn.threadId === params.threadId;
      // The broker's legacy turn parser prefers turnId over canonical id. A
      // conflicting alias cannot certify ownership or disconnect cleanup.
      bound &&= result.startedTurn.turnId === undefined ||
        result.startedTurn.turnId === result.startedTurn.id;
    }
    if (pending.method === 'asyncQuestion/answer' && result?.accepted === true) {
      // State atomically leaves pending when saving an answer. Client checks
      // happen after ownership and disconnect cleanup, so fence it here too.
      bound &&= result.question?.status !== 'pending';
      bound &&= typeof params?.submissionId === 'string' &&
        result.question?.answer?.submissionId === params.submissionId;
      const expected = params?.[ASYNC_ANSWER_FINGERPRINT] ?? asyncAnswerFingerprint(params?.answers);
      bound &&= expected !== null && expected === asyncAnswerFingerprint(result.question?.answer?.answers);
    }
  }
  return bound ? response : { jsonrpc: '2.0', id: response.id, error: { code: -32001,
    message: 'Async question receipt binding mismatch; original outcome is unknown. Read the original task before retrying.' } };
}
