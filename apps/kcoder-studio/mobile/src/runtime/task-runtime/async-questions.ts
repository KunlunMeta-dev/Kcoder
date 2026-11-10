import { asyncQuestionRevisionFingerprint, asyncQuestionSourceFingerprint, asyncQuestionCommittedStateChanged } from "../../../../shared/asyncQuestionRevision";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import {
  isAsyncQuestionAnswerResult,
  isAsyncQuestionAnswerValue,
  isAsyncQuestionCancelResult,
  isAsyncQuestionChangedNotification,
  isAsyncQuestionListParams,
  isAsyncQuestionListResult,
  isAsyncQuestionRecord,
  type AsyncQuestionAnswerParams,
  type AsyncQuestionCancelParams,
  type AsyncQuestionCancelResult,
  type AsyncQuestionListParams,
  type AsyncQuestionListResult,
} from "../../../../shared/generated/contracts";
import { interactionServerIdentity } from "./threadDirectory";
import { TaskRuntime } from "./core";
import type {
  AsyncQuestionAnswerPayload,
  AsyncQuestionRecord,
  AsyncQuestionSnapshot,
} from "./types";

const CAPABILITY = "asyncUserQuestionsV1";
const MAX_RECORDS = 512;
const MAX_ITEMS = 8;
const MAX_OPTIONS = 16;
const MAX_TEXT = 64 * 1024;
const MAX_ANSWER_BYTES = 16 * 1024;
const STATUSES = new Set([
  "pending",
  "answer_saved",
  "queued",
  "context_applied",
  "delivery_unknown",
  "delivery_failed",
  "cancelled",
  "stale",
]);

interface AsyncQuestionOwnerFence {
  client: NonNullable<TaskRuntime["client"]>;
  generation: number;
  runtimeInstanceNonce: number;
  threadId: string;
  current(): boolean;
}

// Retained cards are drafts, not authority for a replacement connection. Only
// its confirmed full list may reopen mutations; ordinary live refreshes do not
// revoke the already-confirmed owner's input.
const confirmedQuestionOwners = new WeakMap<TaskRuntime, AsyncQuestionOwnerFence>();

// Expose the existing runtime authority to retained cards without adding another
// readiness flag or treating an ordinary live refresh as a reconnect.
export function canMutateAsyncQuestions(this: TaskRuntime): boolean {
  const owner = confirmedQuestionOwners.get(this);
  return owner?.current() === true && owner.client.supportsExperimental(CAPABILITY) === true &&
    this.asyncQuestionSnapshot.error === undefined;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT
    ? value
    : null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT ? value : undefined;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function finiteTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function parseAsyncQuestionRecord(value: unknown, expectedThreadId: string): AsyncQuestionRecord | null {
  if (!isAsyncQuestionRecord(value)) return null;
  const raw = object(value);
  if (!raw || raw.threadId !== expectedThreadId) return null;
  const questionId = requiredText(raw.questionId);
  const requestId = requiredText(raw.requestId);
  const sourceTurnId = requiredText(raw.sourceTurnId);
  const toolCallId = requiredText(raw.toolCallId);
  const revision = safeInteger(raw.revision);
  const createdAtMs = finiteTime(raw.createdAtMs);
  if (!questionId || requestId === null || !sourceTurnId || !toolCallId ||
      revision === null || revision === 0 || createdAtMs === null || typeof raw.status !== "string" ||
      !STATUSES.has(raw.status) || !Array.isArray(raw.questions) ||
      raw.questions.length === 0 || raw.questions.length > MAX_ITEMS) return null;

  const itemIds = new Set<string>();
  const questions = [];
  for (const value of raw.questions) {
    const item = object(value);
    const id = requiredText(item?.id);
    const header = optionalText(item?.header);
    const question = requiredText(item?.question);
    if (!item || !id || itemIds.has(id) || header === undefined || !question ||
        typeof item.multiSelect !== "boolean" || !Array.isArray(item.options) ||
        item.options.length > MAX_OPTIONS) return null;
    itemIds.add(id);
    const optionIds = new Set<string>();
    const options = [];
    for (const value of item.options) {
      const option = object(value);
      const optionId = requiredText(option?.id);
      const label = requiredText(option?.label);
      const description = optionalText(option?.description);
      if (!option || !optionId || optionIds.has(optionId) || !label ||
          (option.description !== undefined && description === undefined)) return null;
      optionIds.add(optionId);
      options.push({
        id: optionId,
        label,
        description: description ?? "",
      });
    }
    questions.push({
      id,
      header: header || id,
      question,
      options,
      multiSelect: item.multiSelect,
    });
  }

  let answer: AsyncQuestionRecord["answer"];
  if (raw.answer !== undefined && raw.answer !== null) {
    const answerRaw = object(raw.answer);
    const submissionId = requiredText(answerRaw?.submissionId);
    const acceptedAtMs = finiteTime(answerRaw?.acceptedAtMs);
    const answersRaw = object(answerRaw?.answers);
    if (!answerRaw || !submissionId || acceptedAtMs === null || !answersRaw) return null;
    const answerEntries: Array<[string, NonNullable<AsyncQuestionRecord["answer"]>["answers"][string]]> = [];
    // Answer maps are unordered. Canonicalize only their keys so semantically
    // identical replays cannot become same-revision content conflicts.
    for (const itemId of Object.keys(answersRaw).sort()) {
      const value = answersRaw[itemId];
      const answerValue = object(value);
      const selectedOptionIds = answerValue?.selectedOptionIds ?? [];
      if (!answerValue || !Array.isArray(selectedOptionIds) ||
          selectedOptionIds.some((id) => typeof id !== "string" || !id)) return null;
      const text = optionalText(answerValue.text);
      if (answerValue.text !== undefined && answerValue.text !== null &&
          text === undefined) return null;
      answerEntries.push([itemId, {
        selectedOptionIds: [...selectedOptionIds as string[]],
        // Saved answers are idempotency payloads. Preserve the server's exact
        // text, including empty/whitespace fields, when continuing delivery.
        ...(text === undefined ? {} : { text }),
      }]);
    }
    // Item IDs are protocol data. Define own properties without invoking the
    // legacy __proto__ setter, which would drop an answer from JSON and retries.
    const answers = Object.fromEntries(answerEntries);
    // Saved answers must satisfy the same item/selection rules as new input
    // before a list, notification or competing receipt can settle the card.
    try {
      validateAnswer({ questions }, answers);
    } catch {
      return null;
    }
    answer = { submissionId, answers, acceptedAtMs };
  }

  // Delivery states certify a saved answer. A structurally valid status alone
  // cannot consume the original card or its draft when the answer is missing.
  if (!answer && !["pending", "cancelled", "stale"].includes(raw.status)) return null;
  // State never reopens an answered question as pending. A contradictory
  // receipt cannot grant another answer or cancellation on the original card.
  if (answer && raw.status === "pending") return null;

  const deliveryError = optionalText(raw.deliveryError);
  if (raw.deliveryError !== undefined && raw.deliveryError !== null && deliveryError === undefined) return null;
  return {
    questionId,
    requestId,
    threadId: expectedThreadId,
    sourceTurnId,
    toolCallId,
    revision,
    createdAtMs,
    status: raw.status as AsyncQuestionRecord["status"],
    questions,
    ...(answer ? { answer } : {}),
    ...(deliveryError === undefined ? {} : { deliveryError }),
  };
}

function parseQuestionList(value: unknown, threadId: string): AsyncQuestionRecord[] | null {
  if (!isAsyncQuestionListResult(value)) return null;
  const result = object(value) as AsyncQuestionListResult | null;
  if (!result || result.threadId !== threadId || !Array.isArray(result.questions) ||
      result.questions.length > MAX_RECORDS) return null;
  const byId = new Map<string, AsyncQuestionRecord>();
  for (const value of result.questions) {
    const question = parseAsyncQuestionRecord(value, threadId);
    if (!question || byId.has(question.questionId)) return null;
    byId.set(question.questionId, question);
  }
  return [...byId.values()].sort((left, right) => left.createdAtMs - right.createdAtMs ||
    left.questionId.localeCompare(right.questionId));
}

function currentFence(runtime: TaskRuntime, requireCapability: boolean): AsyncQuestionOwnerFence | null {
  const client = runtime.client;
  const context = runtime.reconnectContext;
  const threadId = runtime.snapshot.threadId;
  const generation = runtime.clientGeneration;
  const runtimeInstanceNonce = runtime.runtimeInstanceNonce;
  const cwd = context?.threadCwd ?? runtime.snapshot.cwd;
  const appServerId = client?.getAppServerId();
  if (!client || !context || !threadId || !appServerId || !client.isTransportOpen() ||
      !runtime.snapshot.connected || runtime.disposed ||
      (requireCapability && client.supportsExperimental(CAPABILITY) !== true)) return null;
  const authorizationOwner = {
    profileId: context.profile.id,
    profileAuthorizationScopeKey: profileAuthorizationScopeKey(context.profile),
    serverId: context.server.id,
    serverConfigIdentity: interactionServerIdentity(context.server),
    profileActivationEpoch: context.profileActivationEpoch ?? -1,
  };
  const current = () => !runtime.disposed && runtime.client === client &&
    runtime.clientGeneration === generation && runtime.runtimeInstanceNonce === runtimeInstanceNonce &&
    // Reconnect invalidates input authority before the old socket is replaced.
    runtime.snapshot.connected &&
    runtime.snapshot.threadId === threadId && runtime.reconnectContext === context &&
    runtime.client?.getAppServerId() === appServerId && client.isTransportOpen() &&
    client.matchesRuntimeOwner(context.profile, context.server, cwd) &&
    context.isCurrentInteractionOwner?.(authorizationOwner) === true &&
    (!requireCapability || client.supportsExperimental(CAPABILITY) === true);
  const owner = { client, generation, runtimeInstanceNonce, threadId, current };
  return owner.current() ? owner : null;
}

function publish(runtime: TaskRuntime, update: Partial<AsyncQuestionSnapshot>): void {
  runtime.asyncQuestionSnapshot = { ...runtime.asyncQuestionSnapshot, ...update };
  for (const listener of runtime.listeners) listener();
}

function recoveredMutationIds(runtime: TaskRuntime): string[] {
  // A successful original-task snapshot retires locks from replaced connections.
  // Keep live requests locked; readback never repeats their side effects.
  for (const [id, owner] of runtime.asyncQuestionMutationIds) {
    if (!owner.current()) runtime.asyncQuestionMutationIds.delete(id);
  }
  return [...runtime.asyncQuestionMutationIds.keys()];
}

function finishMutation(runtime: TaskRuntime, questionId: string, owner: AsyncQuestionOwnerFence): void {
  // A late completion cannot release a replacement connection's request lock.
  if (runtime.asyncQuestionMutationIds.get(questionId) !== owner) return;
  runtime.asyncQuestionMutationIds.delete(questionId);
  if (!runtime.disposed) publish(runtime, { mutatingQuestionIds: [...runtime.asyncQuestionMutationIds.keys()] });
}

function upsertQuestion(runtime: TaskRuntime, question: AsyncQuestionRecord): void {
  const previous = runtime.asyncQuestionSnapshot.questions.find((item) =>
    item.questionId === question.questionId);
  // Mutation receipts can follow a confirmed notification or list. The same
  // revision cannot replace that content; newer revisions retain saved answers and ends.
  if (previous && (asyncQuestionCommittedStateChanged(previous, question) ||
      (previous.revision === question.revision &&
        asyncQuestionRevisionFingerprint(previous) !== asyncQuestionRevisionFingerprint(question)))) {
    const error = "The server returned a conflicting async question receipt. Refresh its status before answering.";
    publish(runtime, { error });
    throw new Error(error);
  }
  if (previous && previous.revision > question.revision) return;
  const questions = runtime.asyncQuestionSnapshot.questions.filter((item) =>
    item.questionId !== question.questionId);
  questions.push(question);
  questions.sort((left, right) => left.createdAtMs - right.createdAtMs ||
    left.questionId.localeCompare(right.questionId));
  publish(runtime, { supported: true, questions });
}

function sameQuestionSource(left: AsyncQuestionRecord, right: AsyncQuestionRecord): boolean {
  return asyncQuestionSourceFingerprint(left) === asyncQuestionSourceFingerprint(right);
}

function validateAnswer(question: Pick<AsyncQuestionRecord, "questions">, answers: AsyncQuestionAnswerPayload): void {
  const itemIds = new Set(question.questions.map((item) => item.id));
  if (Object.keys(answers).length !== itemIds.size || Object.keys(answers).some((id) => !itemIds.has(id)))
    throw new Error("Provide an answer for each question.");
  for (const item of question.questions) {
    const answer = answers[item.id];
    // Validate the raw contract before defaults or text access can conceal an
    // invalid value. Rejection must precede busy publication and RPC dispatch.
    if (!isAsyncQuestionAnswerValue(answer))
      throw new Error("Select an option or enter a response for every question.");
    const optionIds = new Set(item.options.map((option) => option.id));
    const selected = answer?.selectedOptionIds ?? [];
    const text = answer?.text?.trim();
    if (selected.length > MAX_OPTIONS ||
        selected.some((id) => !optionIds.has(id)) || new Set(selected).size !== selected.length ||
        (!item.multiSelect && selected.length > 1) ||
        (selected.length === 0 && !text))
      throw new Error("Select an option or enter a response for every question.");
  }
  // State measures the serde-serialized answer map: omitted selections become
  // an empty Vec, and null/omitted text is skipped. Count that same shape without
  // changing the submitted payload used for stable answer receipt matching.
  const persistedAnswers = Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, {
    selectedOptionIds: answer.selectedOptionIds ?? [],
    ...(answer.text == null ? {} : { text: answer.text }),
  }]));
  if (utf8ByteLength(JSON.stringify(persistedAnswers)) > MAX_ANSWER_BYTES)
    throw new Error("The response is too long. Shorten it and try again.");
}

function matchesSavedAnswer(
  candidate: AsyncQuestionAnswerPayload,
  saved: NonNullable<AsyncQuestionRecord["answer"]>["answers"],
): boolean {
  const candidateIds = Object.keys(candidate).sort();
  const savedIds = Object.keys(saved).sort();
  if (candidateIds.length !== savedIds.length ||
      candidateIds.some((id, index) => id !== savedIds[index])) return false;
  return savedIds.every((id) => {
    const candidateAnswer = object(candidate[id]);
    const savedAnswer = object(saved[id]);
    if (!candidateAnswer || !savedAnswer) return false;
    // Match Rust's defaults without changing the text or selection order that
    // contributes to the saved answer digest.
    const candidateOptions = candidateAnswer.selectedOptionIds === undefined
      ? [] : candidateAnswer.selectedOptionIds;
    const savedOptions = savedAnswer.selectedOptionIds === undefined
      ? [] : savedAnswer.selectedOptionIds;
    if (!Array.isArray(candidateOptions) || !Array.isArray(savedOptions) ||
        candidateOptions.length !== savedOptions.length ||
        candidateOptions.some((optionId, index) => optionId !== savedOptions[index])) return false;
    return (candidateAnswer.text ?? undefined) === (savedAnswer.text ?? undefined);
  });
}

interface PendingQuestionRefresh {
  owner: AsyncQuestionOwnerFence;
  again: boolean;
  notificationFingerprints: Set<string>;
  promise: Promise<void>;
}

const pendingQuestionRefreshes = new WeakMap<TaskRuntime, PendingQuestionRefresh>();

export async function refreshAsyncQuestions(this: TaskRuntime): Promise<void> {
  const owner = currentFence(this, false);
  if (!owner) return;
  const pending = pendingQuestionRefreshes.get(this);
  if (pending?.owner.current()) {
    // A change received during a read needs a later snapshot, not another
    // concurrent full-list RPC. All callers await the trailing reconciliation.
    pending.again = true;
    return pending.promise;
  }
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  const refresh: PendingQuestionRefresh = { owner, again: false, notificationFingerprints: new Set(), promise };
  pendingQuestionRefreshes.set(this, refresh);
  const release = () => {
    // An old connection must not release its replacement's in-flight read.
    if (pendingQuestionRefreshes.get(this) === refresh) {
      pendingQuestionRefreshes.delete(this);
      // Ownership fences discard stale data, but the settled read still owns
      // its local loading flag. Do not retain obsolete loading after revocation.
      if (!this.disposed && this.asyncQuestionSnapshot.loading) publish(this, { loading: false });
    }
  };
  void (async () => {
    try {
      do {
        refresh.again = false;
        await refreshAsyncQuestionsOnce(this, owner, () => refresh.again);
      } while (refresh.again && owner.current());
    } finally {
      // Close the owner slot before the Promise completion microtask. A change
      // arriving after the loop finishes must start a new read, not be lost.
      release();
    }
  })().then(resolve, reject);
  return refresh.promise;
}

async function refreshAsyncQuestionsOnce(
  runtime: TaskRuntime,
  owner: AsyncQuestionOwnerFence,
  superseded: () => boolean,
): Promise<void> {
  if (!owner.current()) return;
  if (owner.client.supportsExperimental(CAPABILITY) !== true) {
    publish(runtime, { supported: false, loading: false, questions: [], error: undefined,
      mutatingQuestionIds: recoveredMutationIds(runtime) });
    return;
  }
  const sequence = ++runtime.asyncQuestionListSequence;
  // Retain a failed read until an authoritative snapshot succeeds. Starting a
  // retry does not make the retained cards safe to mutate.
  publish(runtime, { supported: true, loading: true });
  try {
    const params: AsyncQuestionListParams = {
      threadId: owner.threadId,
      includeTerminal: true,
    };
    if (!isAsyncQuestionListParams(params)) throw new Error("The async question list request was invalid.");
    // Publishing loading state can synchronously reconnect or revoke the owner.
    if (!owner.current()) return;
    const result = await owner.client.request<AsyncQuestionListResult>("asyncQuestion/list", params);
    const questions = parseQuestionList(result, owner.threadId);
    if (!owner.current() || sequence !== runtime.asyncQuestionListSequence || superseded()) return;
    if (!questions) throw new Error("The server returned an invalid async question list.");
    // A mutation receipt can arrive while this list read is in flight.
    // Keep its newer revision instead of reopening an already settled card.
    const currentById = new Map(runtime.asyncQuestionSnapshot.questions.map((question) =>
      [question.questionId, question]));
    // includeTerminal requests the complete durable ledger. A missing known
    // question is a failed read, not authority to discard its card or answer.
    const receivedIds = new Set(questions.map(question => question.questionId));
    if ([...currentById.keys()].some(id => !receivedIds.has(id)))
      throw new Error("The server returned an incomplete async question list.");
    const reconciled = questions.map((question) => {
      const current = currentById.get(question.questionId);
      // Revisions order one original question, never a replacement source that
      // reused its ID. Reject before the newer-revision merge can retain it.
      if (current && (asyncQuestionCommittedStateChanged(current, question) || !sameQuestionSource(current, question) ||
          (current.revision === question.revision &&
            asyncQuestionRevisionFingerprint(current) !== asyncQuestionRevisionFingerprint(question))))
        throw new Error("The server returned an invalid async question list.");
      return current && current.revision > question.revision ? current : question;
    });
    confirmedQuestionOwners.set(runtime, owner);
    publish(runtime, { supported: true, loading: false, questions: reconciled, error: undefined,
      mutatingQuestionIds: recoveredMutationIds(runtime) });
  } catch (error) {
    if (!owner.current() || sequence !== runtime.asyncQuestionListSequence || superseded()) return;
    publish(runtime, {
      supported: true,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function answerAsyncQuestion(
  this: TaskRuntime,
  input: {
    questionId: string;
    submissionId: string;
    expectedRevision: number;
    answers: AsyncQuestionAnswerPayload;
  },
): Promise<{ accepted: boolean; duplicate: boolean; question: AsyncQuestionRecord }> {
  // Snapshot the exact JSON payload before dispatch. A caller may keep editing
  // its draft while this receipt waits; those edits cannot redefine the input.
  const request = {
    ...input,
    answers: JSON.parse(JSON.stringify(input.answers)) as AsyncQuestionAnswerPayload,
  };
  const owner = currentFence(this, true);
  const question = this.asyncQuestionSnapshot.questions.find((item) =>
    item.questionId === request.questionId);
  const isNewAnswer = question?.status === "pending";
  const isSavedAnswerRetry = Boolean(
    question &&
    (question.status === "queued" || question.status === "answer_saved") &&
    question.answer &&
    question.answer.submissionId === request.submissionId &&
    matchesSavedAnswer(request.answers, question.answer.answers)
  );
  if (!owner || !canMutateAsyncQuestions.call(this) || !question || (!isNewAnswer && !isSavedAnswerRetry) ||
      question.revision !== request.expectedRevision || !request.submissionId.trim())
    throw new Error("This question is no longer current. Refresh its status before answering.");
  validateAnswer(question, request.answers);
  const mutationKey = request.questionId;
  if (this.asyncQuestionMutationIds.has(mutationKey))
    throw new Error("This question already has an answer request in progress.");
  this.asyncQuestionMutationIds.set(mutationKey, owner);
  publish(this, { mutatingQuestionIds: [...this.asyncQuestionMutationIds.keys()] });
  let confirmation: { accepted: boolean; duplicate: boolean; question: AsyncQuestionRecord };
  try {
    const params: AsyncQuestionAnswerParams = {
      threadId: owner.threadId,
      questionId: request.questionId,
      submissionId: request.submissionId,
      expectedRevision: request.expectedRevision,
      answers: request.answers,
    };
    // Busy-state subscribers can change authority before the request is sent.
    if (!owner.current()) throw new Error("The task owner changed before the answer was sent.");
    const result = await owner.client.request<unknown>("asyncQuestion/answer", params);
    const receipt = object(result);
    const startedTurn = object(receipt?.startedTurn);
    // Legacy receipts may omit only the nested task ID. Bind that omission to
    // the captured owner before strict validation; explicit IDs still must match.
    const payload = startedTurn && startedTurn.threadId === undefined
      ? { ...receipt, startedTurn: { ...startedTurn, threadId: owner.threadId } }
      : result;
    if (!isAsyncQuestionAnswerResult(payload)) throw new Error("The server returned an invalid async question answer receipt.");
    const responseQuestion = parseAsyncQuestionRecord(payload.question, owner.threadId);
    // Every successful answer RPC returns the saved winner, including a lost
    // race. A pending/withdrawn record alone cannot confirm this submission.
    if (payload.threadId !== owner.threadId || !responseQuestion?.answer ||
        responseQuestion.questionId !== request.questionId ||
        !sameQuestionSource(responseQuestion, question) ||
        // A legacy Gateway can forward a well-typed turn for another task.
        // Check its binding before publishing the question or confirming input.
        (payload.startedTurn != null && (!payload.startedTurn.id.trim() ||
          payload.startedTurn.threadId !== owner.threadId ||
          // Legacy Gateways may forward an alias that identifies a peer turn.
          (object(payload.startedTurn)?.turnId !== undefined &&
            object(payload.startedTurn)?.turnId !== payload.startedTurn.id))) ||
        (payload.accepted && (responseQuestion.answer.submissionId !== request.submissionId ||
          !matchesSavedAnswer(request.answers, responseQuestion.answer.answers))))
      throw new Error("The server returned an invalid async question answer receipt.");
    if (!owner.current()) throw new Error("The task owner changed before the answer was confirmed.");
    upsertQuestion(this, responseQuestion);
    confirmation = {
      accepted: payload.accepted,
      duplicate: payload.duplicate,
      question: responseQuestion,
    };
  } catch (error) {
    // Reconciliation owns its loading/error state; a slow read must not keep
    // the failed mutation or its local busy flag pending. Never replay it.
    if (owner.current()) {
      // Releasing busy must not reopen uncertain input before readback. A newer
      // authoritative revision already supersedes this request's failure.
      const current = this.asyncQuestionSnapshot.questions.find((item) => item.questionId === request.questionId);
      if (current && current.revision <= request.expectedRevision)
        publish(this, { error: error instanceof Error ? error.message : String(error) });
      if (owner.current()) void this.refreshAsyncQuestions();
    }
    throw error;
  } finally {
    finishMutation(this, mutationKey, owner);
  }
  // Receipt and busy-state subscribers can synchronously replace the owner.
  // Confirm input only after both publications, preserving the saved fact.
  if (!owner.current()) throw new Error("The task owner changed before the answer was confirmed.");
  return confirmation;
}

export async function cancelAsyncQuestion(
  this: TaskRuntime,
  input: { questionId: string; expectedRevision: number },
): Promise<AsyncQuestionRecord> {
  const request = { ...input };
  const owner = currentFence(this, true);
  const question = this.asyncQuestionSnapshot.questions.find((item) =>
    item.questionId === request.questionId);
  if (!owner || !canMutateAsyncQuestions.call(this) || !question || question.status !== "pending" ||
      question.revision !== request.expectedRevision)
    throw new Error("This question is no longer current. Refresh its status before cancelling.");
  const mutationKey = request.questionId;
  if (this.asyncQuestionMutationIds.has(mutationKey))
    throw new Error("This question already has an answer request in progress.");
  this.asyncQuestionMutationIds.set(mutationKey, owner);
  publish(this, { mutatingQuestionIds: [...this.asyncQuestionMutationIds.keys()] });
  let confirmation: AsyncQuestionRecord;
  try {
    const params: AsyncQuestionCancelParams = {
      threadId: owner.threadId,
      questionId: request.questionId,
      expectedRevision: request.expectedRevision,
    };
    if (!owner.current()) throw new Error("The task owner changed before cancellation was sent.");
    const result = await owner.client.request<AsyncQuestionCancelResult>("asyncQuestion/cancel", params);
    if (!isAsyncQuestionCancelResult(result)) throw new Error("The server returned an invalid async question cancellation receipt.");
    const payload = result;
    const responseQuestion = parseAsyncQuestionRecord(payload.question, owner.threadId);
    // A bound record is not a cancellation receipt unless withdrawal committed.
    if (payload.threadId !== owner.threadId || !responseQuestion || responseQuestion.status !== "cancelled" ||
        responseQuestion.questionId !== request.questionId ||
        !sameQuestionSource(responseQuestion, question))
      throw new Error("The server returned an invalid async question cancellation receipt.");
    if (!owner.current()) throw new Error("The task owner changed before cancellation was confirmed.");
    upsertQuestion(this, responseQuestion);
    confirmation = responseQuestion;
  } catch (error) {
    // Reconciliation owns its loading/error state; a slow read must not keep
    // the failed mutation or its local busy flag pending. Never replay it.
    if (owner.current()) {
      // Releasing busy must not reopen uncertain input before readback. A newer
      // authoritative revision already supersedes this request's failure.
      const current = this.asyncQuestionSnapshot.questions.find((item) => item.questionId === request.questionId);
      if (current && current.revision <= request.expectedRevision)
        publish(this, { error: error instanceof Error ? error.message : String(error) });
      if (owner.current()) void this.refreshAsyncQuestions();
    }
    throw error;
  } finally {
    finishMutation(this, mutationKey, owner);
  }
  if (!owner.current()) throw new Error("The task owner changed before cancellation was confirmed.");
  return confirmation;
}

export function handleAsyncQuestionChanged(
  this: TaskRuntime,
  params: Record<string, unknown>,
): void {
  const owner = currentFence(this, true);
  if (!owner || !owner.current() || params.threadId !== owner.threadId) return;
  const question = isAsyncQuestionChangedNotification(params)
    ? parseAsyncQuestionRecord(params.question, owner.threadId) : null;
  const previous = this.asyncQuestionSnapshot.questions.find((item) =>
    item.questionId === question?.questionId);
  // Invalid updates and source/content conflicts revoke input until the original
  // list is confirmed. Retaining the old card must not leave it actionable.
  if (!question || (previous && (asyncQuestionCommittedStateChanged(previous, question) || !sameQuestionSource(previous, question) ||
      (question.revision === previous.revision && asyncQuestionRevisionFingerprint(previous) !== asyncQuestionRevisionFingerprint(question))))) {
    // Keep conflict replays within the current read from invalidating every
    // trailing snapshot or hiding its failure. Distinct conflicts still reconcile.
    const pending = pendingQuestionRefreshes.get(this);
    if (question && pending?.owner.current()) {
      const fingerprint = asyncQuestionRevisionFingerprint(question);
      if (pending.notificationFingerprints.has(fingerprint)) return;
      // Retain every observed version within this read's bounded window, so
      // interleaved replays cannot replace each other's deduplication identity.
      if (pending.notificationFingerprints.size < MAX_RECORDS)
        pending.notificationFingerprints.add(fingerprint);
    }
    publish(this, { error: "The server returned an invalid or conflicting async question update. Refresh its status before answering." });
    if (owner.current()) void this.refreshAsyncQuestions();
    return;
  }
  // Older revisions and exact replays add no state and must not supersede an
  // in-flight read or erase its failure. Same-revision conflicts still reconcile.
  if (previous && (question.revision < previous.revision ||
      asyncQuestionRevisionFingerprint(previous) === asyncQuestionRevisionFingerprint(question))) return;
  if (!previous || question.revision > previous.revision) upsertQuestion(this, question);
  void this.refreshAsyncQuestions();
}
