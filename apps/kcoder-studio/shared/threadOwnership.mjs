import { isContract } from './generated/validator.mjs';

export const THREAD_OWNERSHIP_ERRORS_CAPABILITY = 'threadOwnershipErrorsV1';

/** Keep only a closed refusal bound to the original resume request, never a read grant. */
export function threadOwnershipErrorData(value, threadId) {
  if (!isContract('ThreadOwnershipErrorDataV1', value) || value.threadId !== threadId) return undefined;
  return Object.freeze({ version: value.version, reason: value.reason, threadId: value.threadId });
}
