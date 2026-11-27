import type { ThreadOwnershipErrorDataV1 } from './generated/contracts';
export const THREAD_OWNERSHIP_ERRORS_CAPABILITY: 'threadOwnershipErrorsV1';
export function threadOwnershipErrorData(value: unknown, threadId: string): Readonly<ThreadOwnershipErrorDataV1> | undefined;
