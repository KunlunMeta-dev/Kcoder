import '@/i18n'
import { expect, it } from 'vitest'
import type { ToolBlock } from '@/types/workbench'
import { latestProcessActivity, toolActivityText } from './turnProcessActivity'

const catalog = new Map()
function tool(id: string, createdAt: number, text: string): ToolBlock {
  return { id, subtaskId: 'attempt', type: 'tool', toolName: id, status: 'pending', createdAt,
    displayText: { en: text, 'zh-CN': text }, toolInput: { url: 'secret arguments' } }
}

it('takes the latest unfinished call by target time, then reveals an older parallel call', () => {
  const older = tool('search', 10, '正在搜索网页')
  const newer = tool('fetch', 20, '正在访问网页')
  expect(latestProcessActivity([older, newer], catalog)).toBe('正在访问网页')
  newer.status = 'done'
  expect(latestProcessActivity([older, newer], catalog)).toBe('正在搜索网页')
  older.status = 'error'
  expect(latestProcessActivity([older, newer], catalog, true)).toBe('正在描述情况')
  expect(latestProcessActivity([older, newer], catalog)).toBeUndefined()
})

it('handles preparing calls, simultaneous calls, thinking and unknown results without parameter extraction', () => {
  const first = tool('first', 10, '后台文案 A')
  const last = { ...tool('last', 10, '后台文案 B'), status: 'generating_arguments' as const }
  expect(latestProcessActivity([first, last], catalog)).toBe('后台文案 B')
  expect(latestProcessActivity([first, { ...last, status: 'unknown' }], catalog)).toBe('后台文案 A')
  expect(latestProcessActivity([{ id: 'thought', subtaskId: 'attempt', type: 'thinking',
    content: 'reasoning not shown', status: 'streaming', createdAt: 100 }], catalog)).toBe('正在分析请求')
  expect(toolActivityText({ ...first, displayText: undefined }, catalog)).toBe('正在调用工具')
})
