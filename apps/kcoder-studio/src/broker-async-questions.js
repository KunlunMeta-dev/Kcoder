import { visit } from 'jsonc-parser';
import { hasWellFormedJsonStrings } from './broker-json-strings.js';
import { allowedFields, isContract } from '../shared/generated/validator.mjs';
import { ASYNC_ANSWER_FINGERPRINT, asyncAnswerFingerprint } from './broker-async-question-answer.js';

// Match Rust str::trim: U+0085 is whitespace, while U+FEFF is content.
const NON_WHITESPACE = /\P{White_Space}/u;
// Match State's ASYNC_QUESTION_MAX_RECORDS and the Mobile readback limit.
const MAX_RECORDS = 512;

export const ASYNC_QUESTIONS_CAPABILITY = 'asyncUserQuestionsV1';
export const ASYNC_QUESTION_METHODS = new Set(['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']);

export function supportsAsyncQuestions(client, experimental) {
  return client?.initialized === true && client.channel === 'runtime' &&
    client[ASYNC_QUESTIONS_CAPABILITY] === true && experimental?.[ASYNC_QUESTIONS_CAPABILITY] === true;
}

function hasUsableAsyncQuestionThreadId(threadId) {
  // Keep the existing client whitespace restriction and the RPC's UTF-8 limit.
  return typeof threadId === 'string' && Boolean(threadId.trim()) &&
    NON_WHITESPACE.test(threadId) && Buffer.byteLength(threadId, 'utf8') <= 256 &&
    !/[\x00-\x1f\x7f]/.test(threadId);
}

// Inspect the wire fields before rewriting can discard duplicates or round
// a numeral used for response correlation or optimistic concurrency.
function invalidAsyncQuestionWireField(method, raw) {
  let invalid = null;
  const envelopeFields = new Set();
  const paramFields = new Set();
  const answerIds = new Set();
  const answerFields = new Set();
  const frame = typeof raw === 'string' ? raw : raw.toString('utf8');
  try {
    visit(frame, {
      onObjectProperty(field, _offset, _length, _line, _column, path) {
        const keys = path();
        let fields = keys.length === 0 ? envelopeFields
          : keys.length === 1 && keys[0] === 'params' ? paramFields : null;
        if (method === 'asyncQuestion/answer' && keys[0] === 'params' && keys[1] === 'answers') {
          if (keys.length === 2) {
            // The visitor walks each answer value before the next item ID.
            answerFields.clear();
            fields = answerIds;
          } else if (keys.length === 3) {
            fields = answerFields;
          }
        }
        if (!fields) return;
        if (fields.has(field)) {
          if (fields === envelopeFields && field === 'id') invalid = 'request ID';
          else invalid ??= fields === answerIds || fields === answerFields ? 'answers' : 'request envelope';
        }
        fields.add(field);
      },
      onLiteralValue(value, offset, length, _line, _column, path) {
        if (typeof value !== 'number') return;
        const keys = path();
        const isRequestId = keys.length === 1 && keys[0] === 'id';
        const isRevision = keys.length === 2 && keys[0] === 'params' && keys[1] === 'expectedRevision' &&
          method !== 'asyncQuestion/list';
        if (!isRequestId && !isRevision) return;
        if (Number.isSafeInteger(value) && /^(0|[1-9][0-9]*)$/.test(frame.slice(offset, offset + length))) return;
        if (isRequestId) invalid = 'request ID';
        else invalid ??= 'expectedRevision';
      },
    });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // Parsing stopped before checking the entire envelope for duplicate IDs.
    return 'request ID';
  }
  return invalid;
}

export function asyncQuestionAdmissionRejection(request, raw, client, experimental) {
  if (!ASYNC_QUESTION_METHODS.has(request.method)) return null;
  const invalidField = invalidAsyncQuestionWireField(request.method, raw);
  const message = invalidField ? `Invalid async question ${invalidField}`
    : asyncQuestionAdmissionError(request, client, experimental);
  if (!message) return null;
  // An ambiguous or rounded ID cannot correlate the rejection.
  const id = invalidField === 'request ID' ? null : request.id ?? null;
  return { jsonrpc: '2.0', id, error: { code: -32602, message } };
}

export function invalidInteractionUpstreamWireField(line, notification = false) {
  const objects = [];
  let invalid = null;
  try {
    visit(line, {
      onObjectBegin() { objects.push(new Set()); },
      onObjectEnd() { objects.pop(); },
      onObjectProperty(field, _offset, _length, _line, _column, path) {
        const fields = objects.at(-1);
        if (fields.has(field)) {
          if (field === 'id' && path().length === 0) invalid = 'id';
          else invalid ??= 'receipt';
        }
        fields.add(field);
      },
      onLiteralValue(value, offset, length, _line, _column, path) {
        if (typeof value !== 'number') return;
        const keys = path();
        // JSON.parse accepts exponent overflow as Infinity; re-encoding it
        // as null would turn a malformed refusal into a definitive outcome.
        if (!notification && keys[0] === 'error' && keys[1] === 'data' && !Number.isFinite(value)) {
          invalid ??= 'receipt';
          return;
        }
        const isId = keys.length === 1 && keys[0] === 'id';
        const isErrorCode = !notification && keys.length === 2 && keys[0] === 'error' && keys[1] === 'code';
        const isSequence = notification && keys.length === 2 && keys[0] === 'params' && keys[1] === 'sequence';
        const questionPathLength = keys[0] !== (notification ? 'params' : 'result') ? 0
          : keys[1] === 'question' ? 2
          : !notification && keys[1] === 'questions' && typeof keys[2] === 'number' ? 3 : 0;
        // Check original integer tokens before rounding can change replay or receipt identity.
        const isQuestionInteger = questionPathLength > 0 && (
          (keys.length === questionPathLength + 1 && ['revision', 'createdAtMs'].includes(keys.at(-1))) ||
          (keys.length === questionPathLength + 2 && keys.at(-2) === 'answer' && keys.at(-1) === 'acceptedAtMs')
        );
        if (!isId && !isErrorCode && !isSequence && !isQuestionInteger) return;
        const token = line.slice(offset, offset + length);
        // Legacy notifications can spell zero as -0. Both spellings have the
        // same replay identity; fractions and exponent notation remain invalid.
        const integer = isErrorCode ? /^-?(0|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/;
        if (Number.isSafeInteger(value) &&
            (integer.test(token) || (notification && token === '-0'))) return;
        if (isId) invalid = 'id';
        else invalid ??= 'receipt';
      },
    });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // An incomplete scan cannot exclude another top-level ID.
    return 'id';
  }
  return invalid;
}

export function asyncQuestionAdmissionError(request, client, experimental) {
  if (!ASYNC_QUESTION_METHODS.has(request.method)) return null;
  if ((request.jsonrpc !== undefined && request.jsonrpc !== '2.0') ||
      request.result !== undefined || request.error !== undefined)
    return 'Invalid async question request envelope';
  if (!supportsAsyncQuestions(client, experimental)) return 'asyncUserQuestionsV1 negotiation is required';
  const expectedRevision = request.params?.expectedRevision;
  if (request.method !== 'asyncQuestion/list' &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0))
    return 'Invalid async question expectedRevision';
  // Rewriting must not turn an invalid Rust u64 or a rounded JS correlation
  // identity into an executable request whose receipt the caller cannot match.
  if (!(typeof request.id === 'string' || (Number.isSafeInteger(request.id) && request.id >= 0)))
    return 'Async question operations require a string or non-negative safe integer request ID';
  // Reject unparseable frames before the shared Rust stream can fail every peer.
  if (!hasWellFormedJsonStrings(request)) return 'Async question operations require valid Unicode strings';
  // JSON re-encoding converts overflowing numerals to null, which the list
  // RPC accepts as the default filter that excludes terminal questions.
  const includeTerminal = request.params?.includeTerminal;
  if (request.method === 'asyncQuestion/list' && includeTerminal != null && typeof includeTerminal !== 'boolean')
    return 'Async question list includeTerminal must be a boolean or null';
  // Validate the optional Rust boolean before capability projection can turn
  // malformed input into an enabled answer mutation.
  if (request.method === 'asyncQuestion/answer') {
    const { asyncUserQuestions: requested, answers } = request.params ?? {};
    if (requested != null && typeof requested !== 'boolean')
      return 'Async question answer asyncUserQuestions must be a boolean or null';
    // JSON.stringify turns overflowing numerals into null, which Rust accepts
    // as absent text on an otherwise valid option selection.
    if (answers !== null && typeof answers === 'object' &&
        Object.values(answers).some(answer => answer?.text != null && typeof answer.text !== 'string'))
      return 'Async question answer text must be a string or null';
  }
  if (!hasUsableAsyncQuestionThreadId(request.params?.threadId))
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
  return supportsAsyncQuestions(client, experimental) && hasValidAsyncQuestionNotificationBinding(message.params);
}

function hasValidAsyncQuestionContent(question, { allowLegacyReadback = false } = {}) {
  // Clients reject unknown record fields. Fence them before recovery buffering
  // or answer ownership, while preserving omitted fields in legacy snapshots.
  if (Object.keys(question ?? {}).some(field => !allowedFields.AsyncQuestionRecord.includes(field))) return false;
  // JSON may contain isolated UTF-16 surrogates, but Rust and the client
  // contracts require Unicode scalar values. Reject before buffering or ownership.
  if (['threadId', 'questionId', 'requestId', 'sourceTurnId', 'toolCallId', 'deliveryError']
    .some(field => typeof question?.[field] === 'string' && !question[field].isWellFormed())) return false;
  // Explicit creation times must satisfy the same wire contract as client
  // cards before reserving recovery capacity or confirming answer ownership.
  const createdAtMs = question?.createdAtMs;
  if (createdAtMs !== undefined && (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0)) return false;
  // State bounds the JSON-serialized error, including quotes and escaping.
  // Invalid metadata cannot reserve recovery slots before clients reject it.
  const deliveryError = question?.deliveryError;
  if (deliveryError != null && (typeof deliveryError !== 'string' ||
      Buffer.byteLength(JSON.stringify(deliveryError), 'utf8') > 2 * 1024)) return false;
  const deliveryUnconfirmed = ['delivery_failed', 'delivery_unknown'].includes(question?.status);
  // State retains delivery errors only on failed/unknown delivery. Reject
  // stale metadata before recovery buffering or answer ownership can change.
  // Status-only legacy producers may omit the state; preserve that boundary.
  if (deliveryError != null && question.status !== undefined && !deliveryUnconfirmed) return false;
  const answer = question?.answer;
  // Saving advances revision one to two; claiming the answer keeps revision two.
  // Explicit revisions must match State even when prompts are omitted.
  if (question?.status === 'pending' &&
      (answer != null || (question.revision !== undefined && question.revision !== 1))) return false;
  if (question?.status === 'queued' && question.revision !== undefined && question.revision !== 2) return false;
  // Unusable saved answers cannot reconcile a card or reserve handoff capacity.
  // Omitted/null answers remain valid for unanswered and legacy snapshots.
  if (answer != null) {
    // Older list/cancel producers may omit acceptedAtMs on a sparse answer.
    // Validate the same generated shape with only that absent legacy field
    // supplied for validation; explicit malformed values still fail closed.
    const validAnswer = isContract('AsyncQuestionAnswerRecord', answer) ||
      (allowLegacyReadback && answer.acceptedAtMs === undefined &&
        isContract('AsyncQuestionAnswerRecord', { ...answer, acceptedAtMs: 0 }));
    if (!validAnswer) return false;
    // State validates these identities even when legacy snapshots omit prompts.
    // Unsavable answers cannot consume recovery capacity or certify ownership.
    // Map keys bypass generated string guards; they must also be Rust strings.
    const validIdentifier = id => id.isWellFormed() && NON_WHITESPACE.test(id) && Buffer.byteLength(id, 'utf8') <= 256;
    const entries = Object.entries(answer.answers);
    // Legacy snapshots may omit prompts, but State's answer shape still applies.
    if (entries.length < 1 || entries.length > 8 || !validIdentifier(answer.submissionId) ||
        entries.some(([id, value]) => {
          const selected = value.selectedOptionIds ?? [];
          return !validIdentifier(id) || selected.length > 16 ||
            new Set(selected).size !== selected.length || selected.some(id => !validIdentifier(id)) ||
            (selected.length === 0 && !NON_WHITESPACE.test(value.text ?? ''));
        })) return false;
    // State measures the typed map: Vec defaults are serialized and None text
    // is omitted, regardless of an older producer's optional-field spelling.
    const answers = Object.fromEntries(Object.entries(answer.answers).map(([id, value]) =>
      [id, { selectedOptionIds: value.selectedOptionIds ?? [], ...(value.text == null ? {} : { text: value.text }) }]));
    if (Buffer.byteLength(JSON.stringify(answers), 'utf8') > 16 * 1024) return false;
  }
  // Explicit source locators must remain usable by both clients before they
  // consume handoff capacity. Preserve omission by older notification producers.
  if (['requestId', 'sourceTurnId', 'toolCallId'].some(field => {
    const value = question?.[field];
    return value !== undefined && (typeof value !== 'string' || !NON_WHITESPACE.test(value) ||
      Buffer.byteLength(value, 'utf8') > 256);
  })) return false;
  const items = question?.questions;
  // Explicit prompt snapshots must be complete before consuming recovery
  // capacity or confirming a read. Legacy status-only hints may omit items.
  // Full failed/unknown snapshots must carry the original outbox error.
  if (items !== undefined &&
      (!isContract('AsyncQuestionRecord', question) || (deliveryUnconfirmed && deliveryError == null))) return false;
  // Legacy hints and readbacks may omit lifecycle fields. An explicit revision
  // must still describe a possible durable transition before it can win replay.
  if (question?.revision !== undefined && question.status !== 'pending') {
    // A saved answer or delivery error proves a State transition even when
    // a legacy readback omits the status.
    const retired = question.status === 'cancelled' || question.status === 'stale';
    const deliverySettled = deliveryUnconfirmed || question.status === 'context_applied' || deliveryError != null;
    const minimumRevision = deliverySettled || (answer != null && retired) ? 3
      : question.status !== undefined || answer != null ? 2 : 1;
    if (question.revision < minimumRevision) return false;
  }
  // A full delivery snapshot certifies its saved answer. Older status-only
  // notifications may omit both items and answer to trigger original-task reads.
  if (items !== undefined && question.status !== undefined && answer == null &&
      !['pending', 'cancelled', 'stale'].includes(question.status)) return false;
  // Explicit snapshots need usable prompts and option identities/labels before
  // reserving recovery capacity. Omitted legacy items remain compatible.
  if (items !== undefined && (!Array.isArray(items) || items.length < 1 || items.length > 8 ||
      !items.every(item => isContract('AsyncQuestionItem', item) && NON_WHITESPACE.test(item.id) && NON_WHITESPACE.test(item.header) && NON_WHITESPACE.test(item.question) &&
        // These identities become answer map keys/selections; State bounds both.
        Buffer.byteLength(item.id, 'utf8') <= 256 &&
        Buffer.byteLength(item.header, 'utf8') <= 256 &&
        Buffer.byteLength(item.question, 'utf8') <= 16 * 1024 &&
        item.options.length <= 16 && item.options.every(option => NON_WHITESPACE.test(option.id) && NON_WHITESPACE.test(option.label) &&
          Buffer.byteLength(option.id, 'utf8') <= 256 &&
          Buffer.byteLength(option.label, 'utf8') <= 256 &&
          Buffer.byteLength(option.description, 'utf8') <= 2 * 1024) &&
        new Set(item.options.map(option => option.id)).size === item.options.length) ||
      new Set(items.map(item => item.id)).size !== items.length)) return false;
  // Match State's serialized draft budget, including JSON escaping but excluding
  // generated item/option IDs. Unsavable snapshots cannot consume handoff bytes.
  if (items !== undefined && Buffer.byteLength(JSON.stringify({
    sourceTurnId: question.sourceTurnId, toolCallId: question.toolCallId,
    questions: items.map(item => ({ header: item.header, question: item.question,
      options: item.options.map(option => ({ label: option.label, description: option.description })),
      multiSelect: item.multiSelect })),
  }), 'utf8') > 64 * 1024) return false;
  // A structurally valid saved answer must still belong to these exact items
  // and choices. Reject unusable snapshots before they reserve recovery slots.
  if (answer != null && items !== undefined &&
      (Object.keys(answer.answers).length !== items.length || !items.every(item => {
        if (!Object.hasOwn(answer.answers, item.id)) return false;
        const value = answer.answers[item.id], selected = value.selectedOptionIds ?? [];
        return (item.multiSelect || selected.length <= 1) &&
          selected.every(id => item.options.some(option => option.id === id));
      }))) return false;
  return true;
}

export function hasValidAsyncQuestionNotificationBinding(params) {
  // Clients strip only these transport fields before validating the strict
  // notification contract. Unknown envelope fields cannot reserve replay slots.
  if (Object.keys(params ?? {}).some(field => field !== 'serverId' && field !== 'sequence' &&
      !allowedFields.AsyncQuestionChangedNotification.includes(field))) return false;
  // Older producers may omit both the initialize session and the notification
  // server ID. An explicit ID still needs to be usable by clients.
  const serverId = params?.serverId;
  if (serverId !== undefined && (typeof serverId !== 'string' ||
      !serverId.isWellFormed() || !NON_WHITESPACE.test(serverId) || serverId.length > 256)) return false;
  // Invalid replay metadata must not consume resume or early-adoption capacity
  // before a client rejects it. Legacy producers may omit the sequence.
  if (params?.sequence !== undefined &&
      (!Number.isSafeInteger(params.sequence) || params.sequence < 0)) return false;
  if (!hasValidAsyncQuestionContent(params?.question)) return false;
  // Check identity before delivery or buffering, including early Office adoption.
  // Without it, an unusable snapshot could consume capacity for a real question.
  return hasUsableAsyncQuestionThreadId(params?.threadId) &&
    params.question?.threadId === params.threadId &&
    // Uncorrelatable updates cannot refresh a card, and must not consume the
    // bounded resume queue before a client can reject their identity.
    typeof params.question.questionId === 'string' && NON_WHITESPACE.test(params.question.questionId) &&
    // Match State's identifier byte budget before reserving resume capacity.
    Buffer.byteLength(params.question.questionId, 'utf8') <= 256 &&
    Number.isSafeInteger(params.question.revision) && params.question.revision > 0 &&
    // Reject unusable explicit states before they consume recovery capacity.
    (params.question.status === undefined || isContract('AsyncQuestionStatus', params.question.status));
}

// Correlation IDs route responses, but do not certify their task or answer
// binding. Fence receipts before the broker changes ownership or cancels a turn.
export function projectAsyncQuestionResponse(response, pending) {
  if (!ASYNC_QUESTION_METHODS.has(pending.method)) return response;
  // Request fields cannot certify either a success or a refusal.
  const validEnvelope = response.method === undefined && response.params === undefined &&
    (response.jsonrpc === undefined || response.jsonrpc === '2.0');
  // A refusal certifies a mutation outcome too. An invalid envelope or a frame
  // carrying both result and error must remain unknown, just like bad success receipts.
  const error = response.error;
  if (validEnvelope && response.result === undefined && error && typeof error === 'object' &&
      !Array.isArray(error) && Number.isSafeInteger(error.code) && typeof error.message === 'string' &&
      hasWellFormedJsonStrings(error)) return response;
  const result = response.result, params = pending.params;
  const boundQuestion = question => typeof params?.threadId === 'string' &&
    question?.threadId === params.threadId &&
    // Sparse legacy reads still need the exact usable question identity that
    // notifications require; matching two invalid cancel IDs proves nothing.
    typeof question.questionId === 'string' && question.questionId.isWellFormed() &&
    NON_WHITESPACE.test(question.questionId) && Buffer.byteLength(question.questionId, 'utf8') <= 256 &&
    // Client rejection comes after ownership and cleanup. Explicit saved states
    // must satisfy the generated contract before either side effect occurs.
    (question.status === undefined || isContract('AsyncQuestionStatus', question.status)) &&
    // Validate every field that is present before exposing a successful receipt.
    // Sparse legacy list/cancel records may omit prompts and answer timestamps.
    hasValidAsyncQuestionContent(question, {
      allowLegacyReadback: question.questions === undefined && pending.method !== 'asyncQuestion/answer',
    }) &&
    // Explicit revisions must be usable by the card before ownership or cleanup.
    (question.revision === undefined ||
      (Number.isSafeInteger(question.revision) && question.revision > 0));
  // Invalid protocol versions or explicit falsy errors cannot certify a
  // success before task ownership changes or disconnect cleanup, even when
  // the correlation ID and result bindings happen to match.
  let bound = validEnvelope && response.error === undefined &&
    typeof params?.threadId === 'string' && result?.threadId === params.threadId;
  // Clients reject unknown result fields. Check before ownership or cleanup,
  // retaining legacy omissions without accepting a nested routing envelope.
  const resultContract = pending.method === 'asyncQuestion/list' ? 'AsyncQuestionListResult'
    : pending.method === 'asyncQuestion/cancel' ? 'AsyncQuestionCancelResult' : 'AsyncQuestionAnswerResult';
  bound &&= Object.keys(result ?? {}).every(field => allowedFields[resultContract].includes(field));
  if (pending.method === 'asyncQuestion/list') {
    // Match the app-server's active-only default. Unknown delivery remains active.
    const activeOnly = params?.includeTerminal !== true;
    const questionIds = new Set();
    const requestIds = new Set();
    const sources = new Set();
    bound &&= Array.isArray(result?.questions) && result.questions.length <= MAX_RECORDS &&
      result.questions.every(question => {
        if (!boundQuestion(question) || questionIds.has(question.questionId) ||
            (activeOnly && ['context_applied', 'delivery_failed', 'cancelled', 'stale'].includes(question.status)))
          return false;
        questionIds.add(question.questionId);
        // State derives both identities from the same original tool call.
        // A sparse legacy row may omit requestId.
        if (question.requestId !== undefined) {
          if (requestIds.has(question.requestId)) return false;
          requestIds.add(question.requestId);
        }
        // State binds a question to one source turn and tool call in this thread.
        // Sparse legacy rows may omit the source, but explicit pairs must be unique.
        if (question.sourceTurnId === undefined || question.toolCallId === undefined) return true;
        const source = JSON.stringify([question.sourceTurnId, question.toolCallId]);
        if (sources.has(source)) return false;
        sources.add(source);
        return true;
      });
  } else {
    bound &&= typeof params?.questionId === 'string' && boundQuestion(result?.question) &&
      result.question.questionId === params.questionId;
    // A matching identity alone cannot confirm withdrawal. Keep legacy omitted
    // fields compatible, but fence explicit state and the displayed revision.
    if (pending.method === 'asyncQuestion/cancel') {
      const { status, revision, answer, deliveryError, questions } = result?.question ?? {};
      // State clears delivery errors on withdrawal, even if a legacy receipt omits status.
      bound &&= deliveryError == null && (status === undefined || status === 'cancelled');
      if (revision !== undefined) {
        // Complete receipts must advance the revision of the actionable card.
        // Sparse legacy receipts can still report an equal revision.
        const minimumRevision = answer == null ? 2 : 3;
        const expectedRevision = params?.expectedRevision;
        bound &&= revision >= minimumRevision &&
          (!Number.isSafeInteger(expectedRevision) || revision > expectedRevision ||
            (questions === undefined && revision === expectedRevision));
      }
    }
    // Client validation runs after Gateway ownership and disconnect cleanup.
    // Unconfirmed answer receipts must fail before either side effect.
    if (pending.method === 'asyncQuestion/answer') {
      bound &&= typeof result?.accepted === 'boolean' && typeof result?.duplicate === 'boolean';
      // Only an accepted submission can be a duplicate or start a turn.
      bound &&= result.accepted || (!result.duplicate && result.startedTurn == null);
      // Answer receipts require the complete prompt as well as the saved winner.
      // Sparse notification/list/cancel compatibility cannot certify execution
      // before clients reject the incomplete record or disconnect cleanup runs.
      bound &&= result.question?.questions !== undefined && result.question.answer != null;
    }
    if (pending.method === 'asyncQuestion/answer' && result?.startedTurn != null) {
      // The app-server pairs admission with the saved queued snapshot.
      // Delivery progress is published separately and cannot certify a new turn.
      bound &&= result.question.status === 'queued';
      // A duplicate may return the saved answer below the requested revision,
      // but that readback cannot authorize delivery or certify a started turn.
      if (result.duplicate && Number.isSafeInteger(params.expectedRevision)) {
        bound &&= result.question.revision >= params.expectedRevision;
      }
      // Clients reject unknown nested Turn fields before consuming the receipt.
      // Keep the existing unambiguous turnId alias for legacy cleanup routing.
      bound &&= Object.keys(result.startedTurn).every(field =>
        field === 'turnId' || allowedFields.Turn.includes(field));
      // The app-server only includes startedTurn for a newly admitted running turn.
      bound &&= result.startedTurn.status === 'running';
      const memorySnapshotId = result.startedTurn.memorySnapshotId;
      bound &&= memorySnapshotId == null || (typeof memorySnapshotId === 'string' && memorySnapshotId.isWellFormed());
      // A running status alone cannot identify execution. Reject before the
      // broker transfers ownership or interrupts an unconfirmed turn on detach.
      bound &&= typeof result.startedTurn.id === 'string' && result.startedTurn.id.isWellFormed() &&
        NON_WHITESPACE.test(result.startedTurn.id) &&
        // Steering the source turn never admits a new turn.
        result.startedTurn.id !== result.question.sourceTurnId;
      // A nested turn identity cannot override the original question's task.
      // Preserve older responses without this field, but fence explicit task
      // mismatches before ownership tracking or disconnected-client cleanup.
      bound &&= result.startedTurn.threadId === undefined ||
        result.startedTurn.threadId === params.threadId;
      // The broker's legacy turn parser prefers turnId over canonical id. A
      // conflicting alias cannot certify ownership or disconnect cleanup.
      bound &&= result.startedTurn.turnId === undefined ||
        result.startedTurn.turnId === result.startedTurn.id;
      // An unusable retry identity, including JSON-only isolated surrogates,
      // must not supersede a real attempt and hide its terminal or authorize cleanup.
      const attemptId = result.startedTurn.attemptId;
      bound &&= attemptId == null || (typeof attemptId === 'string' && attemptId.isWellFormed() &&
        NON_WHITESPACE.test(attemptId));
    }
    // State only accepts a first answer at the initial pending revision.
    // Exact retries can report the saved winner at other revisions.
    if (pending.method === 'asyncQuestion/answer' && result?.accepted === true && result.duplicate === false) {
      bound &&= params.expectedRevision === 1;
    }
    if (bound && pending.method === 'asyncQuestion/answer') {
      const saved = result.question.answer;
      let matchesSubmission = false;
      if (saved.submissionId === params.submissionId) {
        const expected = params[ASYNC_ANSWER_FINGERPRINT] ?? asyncAnswerFingerprint(params.answers);
        matchesSubmission = expected !== null && expected === asyncAnswerFingerprint(saved.answers);
      }
      // State returns accepted for both a first save and an exact retry.
      // A refusal for the exact saved submission contradicts the outbox receipt.
      bound = result.accepted === matchesSubmission;
    }
  }
  if (bound && pending.method === 'asyncQuestion/answer' && result.startedTurn != null &&
      (result.startedTurn.threadId === undefined || result.startedTurn.turnId !== undefined)) {
    // Legacy locators have already been checked against the original request.
    // Emit the canonical Turn so strict clients can consume the saved answer.
    const { turnId: _legacyTurnId, ...turn } = result.startedTurn;
    return { ...response, result: { ...result, startedTurn: { ...turn, threadId: params.threadId } } };
  }
  return bound ? response : { jsonrpc: '2.0', id: response.id, error: { code: -32001,
    message: 'Async question receipt binding mismatch; original outcome is unknown. Read the original task before retrying.' } };
}
