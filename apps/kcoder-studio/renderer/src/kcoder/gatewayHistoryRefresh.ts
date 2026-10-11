export type HistoryRefreshInput =
  { acknowledgeExternalWriters: true } | { cursor: string; cancel?: true }

export interface HistoryRefreshIssue {
  sessionId?: string
  reason: string
}

export interface HistoryRefreshResult {
  status: 'building' | 'ready' | 'incomplete' | 'cancelled'
  nextCursor?: string
  examinedEntries: number
  indexedSessions: number
  issueCount: number
  issues?: HistoryRefreshIssue[]
}

export function historyRefreshInput(params: Record<string, unknown>): HistoryRefreshInput {
  if (params.cursor !== undefined) {
    if (
      typeof params.cursor !== 'string' ||
      !params.cursor.trim() ||
      params.cursor.length > 8192 ||
      params.acknowledgeExternalWriters !== undefined ||
      (params.cancel !== undefined && params.cancel !== true)
    )
      throw new Error('Invalid history refresh cursor or cancellation')
    return { cursor: params.cursor, ...(params.cancel === true ? { cancel: true as const } : {}) }
  }
  if (params.acknowledgeExternalWriters !== true || params.cancel !== undefined)
    throw new Error('History refresh requires explicit acknowledgement of external writers')
  return { acknowledgeExternalWriters: true }
}

export function historyRefreshResult(value: unknown): HistoryRefreshResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid history refresh response')
  const result = value as Record<string, unknown>
  if (
    typeof result.status !== 'string' ||
    !['building', 'ready', 'incomplete', 'cancelled'].includes(result.status) ||
    !['examinedEntries', 'indexedSessions', 'issueCount'].every(
      key => Number.isSafeInteger(result[key]) && Number(result[key]) >= 0
    )
  )
    throw new Error('Invalid history refresh progress')
  if (result.status === 'ready' && result.issueCount !== 0)
    throw new Error('Completed history refresh still reports unresolved issues')
  const cursor = result.nextCursor
  if (result.status === 'building') {
    if (typeof cursor !== 'string' || !cursor.trim() || cursor.length > 8192)
      throw new Error('History refresh is missing its continuation cursor')
  } else if (cursor !== undefined && cursor !== null)
    throw new Error('Terminal history refresh returned a continuation cursor')
  const issues = Array.isArray(result.issues)
    ? result.issues
        .filter(
          (issue): issue is Record<string, unknown> =>
            !!issue && typeof issue === 'object' && typeof issue.reason === 'string'
        )
        .slice(0, 20)
        .map(issue => ({
          ...(typeof issue.sessionId === 'string' ? { sessionId: issue.sessionId } : {}),
          reason: String(issue.reason),
        }))
    : undefined
  return {
    status: result.status as HistoryRefreshResult['status'],
    ...(typeof cursor === 'string' ? { nextCursor: cursor } : {}),
    examinedEntries: Number(result.examinedEntries),
    indexedSessions: Number(result.indexedSessions),
    issueCount: Number(result.issueCount),
    ...(issues && issues.length ? { issues } : {}),
  }
}

export async function requestHistoryRefreshStep(
  client: {
    request<T>(method: string, params: Record<string, unknown>): Promise<T>
    supportsExperimental?: (name: string) => boolean
  },
  input: HistoryRefreshInput
): Promise<HistoryRefreshResult> {
  if (client.supportsExperimental?.('threadHistoryIndexRefresh') !== true)
    throw new Error(
      'The target KCoder server does not support threadHistoryIndexRefresh; upgrade it first'
    )
  return historyRefreshResult(await client.request('thread/history/refresh', input))
}
