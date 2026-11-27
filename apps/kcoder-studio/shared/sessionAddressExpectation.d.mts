import type { SessionAddress } from './peerAgentMessage';
export const SESSION_ADDRESS_EXPECTATION_CAPABILITY: 'sessionAddressExpectationV1';
export const SESSION_ADDRESS_EXPECTATION_FIELD: 'expectedSessionAddress';
export function sessionAddressExpectation(value: unknown, threadId: unknown): Readonly<SessionAddress>;
