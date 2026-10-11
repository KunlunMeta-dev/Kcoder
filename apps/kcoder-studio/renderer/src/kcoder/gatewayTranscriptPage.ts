interface TranscriptClient {
  supportsExperimental?(name: string): boolean
  request<T>(method: string, params: Record<string, unknown>): Promise<T>
}

export async function requestTranscriptPage<T extends object>(
  client: TranscriptClient,
  params: Record<string, unknown>
): Promise<T & { historyReset?: boolean }> {
  const indexed = client.supportsExperimental?.('threadIndexedPagesV1') === true
  const method = indexed ? 'thread/read/indexed' : 'thread/read'
  const opaque = typeof params.beforeCursor === 'string' && params.beforeCursor.startsWith('tp1:')
  const fresh = { ...params }
  delete fresh.beforeCursor
  if (opaque && !indexed) return { ...(await client.request<T>(method, fresh)), historyReset: true }
  try {
    return await client.request<T>(method, params)
  } catch (error) {
    if (!opaque || !(error instanceof Error) || error.message !== 'TRANSCRIPT_CURSOR_STALE')
      throw error
    return { ...(await client.request<T>(method, fresh)), historyReset: true }
  }
}
