import { isContract } from '../shared/generated/validator.mjs';

export const TASK_EXPERT_CAPABILITY = 'agentTurnConfigurationV1';
export const EXPERT_CREATION_CAPABILITY = 'agentDefinitionsV1';
export const TASK_EXPERT_LIGHT_READ_CAPABILITY = 'threadExpertReadWithoutTurnsV1';

function supportsExpertCapability(client, experimental, capability) {
  return client?.initialized === true && client.channel === 'runtime' &&
    client[capability] === true && experimental?.[capability] === true;
}

export function taskExpertAdmissionError(request, client, experimental) {
  if (request.method === 'thread/start' && request.params?.agentDefinition != null) {
    return supportsExpertCapability(client, experimental, EXPERT_CREATION_CAPABILITY)
      ? null : 'agentDefinitionsV1 negotiation is required';
  }
  if (request.method !== 'thread/expert') return null;
  if (!supportsExpertCapability(client, experimental, TASK_EXPERT_CAPABILITY)) return 'agentTurnConfigurationV1 negotiation is required';
  if (!isContract('ThreadExpertParams', request.params)) return 'Invalid original task expert request';
  return null;
}

// A shared backend opt-in does not authorize an older client to change experts.
export function projectTaskExpertCapabilities(experimental, client) {
  let projected = experimental;
  for (const capability of [
    TASK_EXPERT_CAPABILITY,
    EXPERT_CREATION_CAPABILITY,
    TASK_EXPERT_LIGHT_READ_CAPABILITY,
  ]) {
    if (Object.hasOwn(experimental ?? {}, capability)) {
      projected = { ...projected, [capability]: supportsExpertCapability(client, experimental, capability) };
    }
  }
  return projected;
}

const TASK_EXPERT_FAILURE_PHRASES = [
  [/history source changed during resume preparation/, 'HISTORY_SOURCE_CHANGED'],
  [/history commit is in progress/, 'HISTORY_COMMIT_IN_PROGRESS'],
  [/persisted thread not found/, 'PERSISTED_THREAD_NOT_FOUND'],
  [/thread\/start or thread\/resume is required/, 'THREAD_NOT_RESIDENT'],
  [/threadId does not match the active thread/, 'THREAD_MISMATCH'],
  [/negotiation is required/, 'NEGOTIATION_REQUIRED'],
  [/Invalid original task expert request/, 'INVALID_REQUEST'],
  [/Gateway request expired/, 'GATEWAY_REQUEST_EXPIRED'],
];

/** Reduce an expert RPC failure to a bounded code; messages may contain paths or IDs. */
export function taskExpertFailureCode(message) {
  const text = typeof message === 'string' ? message : '';
  const leading = /^[A-Z][A-Z0-9_]{2,80}\b/.exec(text)?.[0];
  if (leading) return leading;
  for (const [pattern, code] of TASK_EXPERT_FAILURE_PHRASES) if (pattern.test(text)) return code;
  return 'OTHER';
}

// Logs only the numeric RPC code and the bounded failure code: never params,
// thread identities, expert bindings or raw messages.
export function logTaskExpertFailure(method, error, log = console.warn) {
  if (method !== 'thread/expert' || !error || typeof error !== 'object') return;
  const kind = error.data?.kind;
  log('[kcoder-task-expert-failure]', {
    code: Number.isSafeInteger(error.code) ? error.code : null,
    reason: typeof kind === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(kind)
      ? kind : taskExpertFailureCode(error.message),
  });
}
