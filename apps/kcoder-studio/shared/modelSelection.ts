interface ModelSelectionClient {
  supportsExperimental?: (capability: string) => boolean
  request: (method: string) => Promise<unknown>
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

// New peers need no discovery roundtrip. Old peers support configured provider IDs,
// but only a single advertised model can prove that this selects the intended model.
export async function negotiateModelSelector(client: ModelSelectionClient, selection?: string | null): Promise<string | undefined> {
  if (!selection) return undefined
  if (!selection.includes('::') || client.supportsExperimental?.('qualifiedModelSelectionV1')) return selection
  const separator = selection.indexOf('::')
  const provider = selection.slice(0, separator)
  const model = selection.slice(separator + 2)
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = record(await Promise.race([
    client.request('runtime.models.list'),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('读取目标模型目录超时，请重试或升级目标 KCoder。')), 10000)
    }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer) }))
  const groups = Array.isArray(result.providers) ? result.providers.map(record).filter(group => group.id === provider) : []
  const rows = groups.length === 1 && Array.isArray(groups[0].data)
    ? groups[0].data.map(record)
    : groups.length === 0 && Array.isArray(result.data)
      ? result.data.map(record).filter(row => (row.providerId ?? row.provider_id) === provider)
      : []
  if (provider && model && rows.length === 1 && (rows[0].model ?? rows[0].id) === model) return provider
  throw new Error('目标 KCoder 不支持完整模型选择，且无法确认对应的默认模型。请升级目标 KCoder 后重试。')
}
