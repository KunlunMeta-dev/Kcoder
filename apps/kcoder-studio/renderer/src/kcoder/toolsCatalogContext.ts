import { createContext, useContext } from 'react'
import { Bot, File, Globe, ListChecks, Search, Terminal, Wrench } from 'lucide-react'
import { requestLocalExecutor } from '@/tauri/localExecutor'

export const toolCatalogIcons = {
  tool: Wrench,
  file: File,
  search: Search,
  terminal: Terminal,
  agent: Bot,
  globe: Globe,
  checklist: ListChecks,
}
const groups = new Set(['other', 'files', 'search', 'terminal', 'agents', 'web', 'planning'])
// Keep in sync with kcoder_types::tool_ui presentation-only snapshot budgets.
const TOOL_CATALOG_LIMIT = 512
const TOOL_CATALOG_CONTENT_BYTE_LIMIT = 1024 * 1024 - 4096
export interface ToolCatalogEntry {
  name: string
  displayName: string
  icon: keyof typeof toolCatalogIcons
  group: string
  description: string
}
export interface ToolCatalogSnapshot {
  entries: ReadonlyMap<string, ToolCatalogEntry>
  total: number
  truncated: boolean
}
export const emptyToolsCatalog = new Map<string, ToolCatalogEntry>()
export const ToolsCatalogContext =
  createContext<ReadonlyMap<string, ToolCatalogEntry>>(emptyToolsCatalog)
const bounded = (value: unknown, max: number) =>
  typeof value === 'string'
    ? Array.from(value)
        .filter(ch => !/\p{Cc}/u.test(ch))
        .slice(0, max)
        .join('')
    : ''

export function toolDisplayName(name: string): string {
  const normalized = name.trim()
  const leaf = normalized.split(/\.|__/).filter(Boolean).at(-1) ?? normalized
  return bounded(leaf.replaceAll('_', ' '), 128)
}

export async function readToolsCatalog(
  taskId: string,
  serverId?: string
): Promise<ToolCatalogSnapshot> {
  const result = await requestLocalExecutor<{
    cachePolicy: string
    tools: ToolCatalogEntry[]
    total?: number
    truncated?: boolean
  } | null>('runtime.tools.catalog', { taskId, serverId })
  const entries = new Map<string, ToolCatalogEntry>()
  if (result?.cachePolicy !== 'no-store' || !Array.isArray(result.tools)) {
    return { entries, total: 0, truncated: false }
  }
  let remaining = TOOL_CATALOG_CONTENT_BYTE_LIMIT
  const encoder = new TextEncoder()
  for (const entry of result.tools.slice(0, TOOL_CATALOG_LIMIT)) {
    if (!entry || typeof entry.name !== 'string') continue
    const size = encoder.encode(JSON.stringify(entry)).length + 1
    if (size > remaining) break
    remaining -= size
    entries.set(entry.name, {
      name: entry.name,
      displayName: bounded(entry.displayName, 128) || toolDisplayName(entry.name),
      description: bounded(entry.description, 512),
      group: groups.has(entry.group) ? entry.group : 'other',
      icon: Object.hasOwn(toolCatalogIcons, entry.icon) ? entry.icon : 'tool',
    })
  }
  const total = Math.max(
    result.tools.length,
    typeof result.total === 'number' && Number.isSafeInteger(result.total) && result.total >= 0
      ? result.total
      : 0
  )
  return { entries, total, truncated: result.truncated === true || entries.size < total }
}

export function useToolCatalogEntry(name?: string) {
  return useContext(ToolsCatalogContext).get(name ?? '')
}
