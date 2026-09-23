export interface DiagnosticConnection {
  readonly targetId: string
  readonly connectionId: string
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const processSession = /^[0-9a-f]{32}-[0-9a-f]{8}-[0-9a-f]{16}$/i
const executionId = (value: unknown) => typeof value === 'string' && (uuid.test(value) || /^turn-\d+(?:-retry-[0-9a-f-]{36})?$/.test(value)) ? value : null

/** Called only after replay acceptance and successful background UI projection. */
export function reportBackgroundRunDiagnostic(input: {
  connection?: DiagnosticConnection
  threadId: unknown
  runId: unknown
  attemptId: unknown
  status: 'running' | 'completed' | 'failed' | 'interrupted'
}) {
  if (!input.connection || typeof input.runId !== 'string' || !uuid.test(input.runId)) return
  const target = input.connection.targetId
  const connectionId = input.connection.connectionId
  if (typeof target !== 'string' || typeof connectionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target) || /^sk-/.test(target) || !/^rpc-\d+-\d+$/.test(connectionId)) return
  const status = ['running', 'completed', 'failed', 'interrupted'].includes(input.status) ? input.status : 'unknown'
  console.info('[kcoder-background-run]', Object.freeze({
    targetId: target,
    connectionId,
    threadId: typeof input.threadId === 'string' && (uuid.test(input.threadId) || processSession.test(input.threadId) || /^[A-Za-z0-9]{5}$/.test(input.threadId)) ? input.threadId : null,
    runId: input.runId,
    // The envelope belongs to the parent turn. Do not invent a child attempt
    // or a restored parent attempt when the protocol supplied no such fact.
    attemptId: executionId(input.attemptId),
    attemptScope: 'parent_turn',
    phase: status === 'running' ? 'background-start' : 'background-terminal',
    code: `background_run_${status}`,
    status,
  }))
}
