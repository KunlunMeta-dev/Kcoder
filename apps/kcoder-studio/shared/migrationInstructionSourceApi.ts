import * as C from './generated/contracts'
import { INSTRUCTION_METHODS, validInstructionSourceCall } from './migrationInstructions.mjs'

type Result = C.MigrationInstructionCaptureResult | C.MigrationInstructionPageResult | C.MigrationInstructionBodyResult
type Query = Extract<C.MigrationSourceSessionQueryParams['query'], { kind: 'instructions_capture' | 'instructions_page' | 'instructions_body' }>
type Request = <T>(operation: string, input: unknown, validInput: (value: unknown) => boolean, validResult: (value: unknown) => value is T, signal?: AbortSignal) => Promise<T>
export const isInstructionSourceQuery = (value: C.MigrationSourceSessionQueryParams['query']): value is Query =>
  value.kind === 'instructions_capture' || value.kind === 'instructions_page' || value.kind === 'instructions_body'

function call(query: Query) {
  if (query.kind === 'instructions_capture') return { method: INSTRUCTION_METHODS.capture, params: query.params }
  return query.kind === 'instructions_page'
    ? { method: INSTRUCTION_METHODS.page, params: { target: { kind: 'source', captureId: query.params.captureId }, pageIndex: query.params.pageIndex ?? 0 } }
    : { method: INSTRUCTION_METHODS.body, params: { target: { kind: 'source', captureId: query.params.captureId }, itemId: query.params.itemId, representation: query.params.representation, offset: query.params.offset ?? 0 } }
}
export function validInstructionSourceQuery(input: unknown, result?: unknown): boolean {
  if (!C.isMigrationSourceSessionQueryParams(input) || input.session.purpose !== 'source' || !isInstructionSourceQuery(input.query)) return false
  const { method, params } = call(input.query)
  return validInstructionSourceCall(method, params, result)
}
/** Capture uses an ordered mutation transport. No query can address a destination job. */
export function createInstructionSourceApi(read: Request, mutation: Request) {
  const query = <T extends Result>(session: C.MigrationSourceSessionParams, query: Query, signal?: AbortSignal) =>
    (query.kind === 'instructions_capture' ? mutation : read)<T>('query', { session, query }, validInstructionSourceQuery,
      (value): value is T => validInstructionSourceQuery({ session, query }, value), signal)
  return {
    instructionsCapture: (session: C.MigrationSourceSessionParams, params: C.MigrationInstructionCaptureParams, signal?: AbortSignal) => query<C.MigrationInstructionCaptureResult>(session, { kind: 'instructions_capture', params }, signal),
    instructionsPage: (session: C.MigrationSourceSessionParams, params: C.MigrationSourceInstructionPageParams, signal?: AbortSignal) => query<C.MigrationInstructionPageResult>(session, { kind: 'instructions_page', params }, signal),
    instructionsBody: (session: C.MigrationSourceSessionParams, params: C.MigrationSourceInstructionBodyParams, signal?: AbortSignal) => query<C.MigrationInstructionBodyResult>(session, { kind: 'instructions_body', params }, signal),
  }
}
