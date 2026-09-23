export async function readWorkspaceList<T>(
  request: (params: Record<string, unknown>) => Promise<unknown>,
  adapt: (value: Record<string, unknown>) => T,
  onProgress?: (snapshot: T) => void
): Promise<T> {
  let params: Record<string, unknown> = onProgress ? { progressive: true } : {}
  let scanId: string | null = null
  let revision = 0
  for (;;) {
    const response = await request(params)
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('Invalid workspace scan response')
    }
    const value = response as Record<string, unknown>
    if (
      !onProgress ||
      (scanId === null && !('scanId' in value) && !('revision' in value) && !('complete' in value))
    ) {
      return adapt(value)
    }
    if (
      typeof value.scanId !== 'string' ||
      !value.scanId ||
      value.scanId.length > 256 ||
      (scanId !== null && scanId !== value.scanId) ||
      typeof value.revision !== 'number' ||
      !Number.isSafeInteger(value.revision) ||
      value.revision <= revision ||
      typeof value.complete !== 'boolean' ||
      !Array.isArray(value.workspaces)
    ) {
      throw new Error('Invalid workspace scan response')
    }
    scanId = value.scanId
    revision = value.revision
    const snapshot = adapt(value)
    if (value.complete) return snapshot
    onProgress(snapshot)
    params = { progressive: true, scanId, afterRevision: revision }
  }
}
