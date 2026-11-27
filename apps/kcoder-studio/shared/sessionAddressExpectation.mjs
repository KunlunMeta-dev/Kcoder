import { validAgentMessageAddress } from './agentMessageMethods.mjs';

export const SESSION_ADDRESS_EXPECTATION_CAPABILITY = 'sessionAddressExpectationV1';
export const SESSION_ADDRESS_EXPECTATION_FIELD = 'expectedSessionAddress';

/** This selector narrows a normal request; it never grants access to a task. */
export function sessionAddressExpectation(value, threadId) {
  if (!validAgentMessageAddress(value) || value.threadId !== threadId)
    throw new Error('SESSION_ADDRESS_EXPECTATION_INVALID');
  return Object.freeze({ targetId: value.targetId, workspaceId: value.workspaceId, threadId: value.threadId });
}
