import type { ThreadRuntimeHandoffReadResult, ThreadRuntimeHandoffReleaseParams, ThreadRuntimeHandoffReleaseResult } from './generated/contracts';
export const THREAD_RUNTIME_HANDOFF_CAPABILITY: 'threadRuntimeHandoffV1';
export const THREAD_RUNTIME_HANDOFF_READ: 'thread/runtime/handoff/read';
export const THREAD_RUNTIME_HANDOFF_RELEASE: 'thread/runtime/handoff/release';
export function isThreadRuntimeHandoffMethod(method: unknown): boolean;
export function validThreadRuntimeHandoffRequest(method: string, params: unknown): boolean;
export function validThreadRuntimeHandoffResult(method: string, params: unknown, result: unknown): boolean;
export function confirmsReleasedThreadRuntime(params: unknown, result: unknown): boolean;
export class ThreadRuntimeHandoffError extends Error { readonly outcome: 'not_sent' | 'unknown'; }
export class ThreadRuntimeHandoffClient {
  constructor(transport: {request(method: string, params: Record<string, unknown>): Promise<unknown>; supported(): boolean; ownerStamp(): unknown});
  observe(threadId: string, operationId?: string): Promise<ThreadRuntimeHandoffReadResult>;
  release(params: ThreadRuntimeHandoffReleaseParams): Promise<ThreadRuntimeHandoffReleaseResult>;
}
