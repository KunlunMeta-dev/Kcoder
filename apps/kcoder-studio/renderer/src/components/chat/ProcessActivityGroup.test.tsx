import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import i18n from '@/i18n'
import { ToolsCatalogContext, type ToolCatalogEntry } from '@/kcoder/toolsCatalogContext'
import type { ProcessingBlock } from '@/types/workbench'
import { clearPersistentProcessingExpansions } from './blocks/processingExpansionState'
import { ProcessActivityGroup } from './ProcessActivityGroup'

beforeEach(async () => { await i18n.changeLanguage('zh-CN') })
afterEach(async () => { cleanup(); clearPersistentProcessingExpansions(); await i18n.changeLanguage('zh-CN') })

const catalog = new Map<string, ToolCatalogEntry>([['read', { name: 'read', displayName: 'Read',
  icon: 'file', group: 'files', description: '',
  displayText: { 'zh-CN': '正在读取测试文件', en: 'Reading test file' } }]])

test('clock updates change duration without rescanning unchanged process facts or closing disclosure', () => {
  const start = 1000
  let statusReads = 0
  const blocks: ProcessingBlock[] = Array.from({ length: 64 }, (_, index) => ({
    id: `tool-${index}`, type: 'tool', toolName: 'read', createdAt: start,
    completedAt: index === 63 ? undefined : start + 1000,
    get status() { statusReads++; return index === 63 ? 'streaming' as const : 'done' as const },
  }))
  const content = (now: number, values = blocks) => <ToolsCatalogContext.Provider value={catalog}>
    <ProcessActivityGroup blocks={values} stateKey="clock-cost" showTiming now={now}>
      <span>Owned details</span>
    </ProcessActivityGroup>
  </ToolsCatalogContext.Provider>
  const view = render(content(start + 1000))
  fireEvent.click(view.getByTestId('process-activity-toggle'))
  statusReads = 0
  for (let tick = 1; tick <= 40; tick++) view.rerender(content(start + 1000 + tick * 1000))
  expect(view.getByTestId('process-activity-heading')).toHaveTextContent('41秒')
  expect(view.getByText('Owned details')).toBeVisible()
  expect(view.getByTestId('process-activity-group')).toHaveTextContent('正在读取测试文件')
  expect(statusReads).toBe(0)
  const completed = blocks.map(block => ({ ...block, status: 'done' as const, completedAt: start + 41000 }))
  view.rerender(content(start + 50000, completed))
  expect(view.container.querySelector('.animate-spin')).toBeNull()
  expect(view.getByTestId('process-activity-heading')).toHaveTextContent('41秒')
  view.rerender(content(start + 90000, completed))
  expect(view.getByTestId('process-activity-heading')).toHaveTextContent('41秒')
})

test('language, catalog and thinking changes refresh activity independently of elapsed time', async () => {
  const blocks: ProcessingBlock[] = [{ id: 'reader', type: 'tool', toolName: 'read', status: 'streaming', createdAt: 1000 }]
  const content = (values: ProcessingBlock[], entries = catalog, thinkingActive = true) => <ToolsCatalogContext.Provider value={entries}>
    <ProcessActivityGroup blocks={values} stateKey="activity-inputs" showTiming now={5000} thinkingActive={thinkingActive}>
      <span>Details</span>
    </ProcessActivityGroup>
  </ToolsCatalogContext.Provider>
  const view = render(content(blocks))
  expect(view.getByTestId('process-activity-group')).toHaveTextContent('正在读取测试文件')
  await act(async () => { await i18n.changeLanguage('en') })
  expect(view.getByTestId('process-activity-group')).toHaveTextContent('Reading test file')
  const replacement = new Map(catalog)
  replacement.set('read', { ...catalog.get('read')!, displayText: { en: 'Updated activity' } })
  view.rerender(content(blocks, replacement))
  expect(view.getByTestId('process-activity-group')).toHaveTextContent('Updated activity')
  const thinking: ProcessingBlock[] = [{ id: 'thought', type: 'thinking', status: 'streaming', content: 'Private thought', createdAt: 1000 }]
  view.rerender(content(thinking, replacement, true))
  expect(view.container.querySelector('.animate-spin')).not.toBeNull()
  view.rerender(content(thinking, replacement, false))
  expect(view.container.querySelector('.animate-spin')).toBeNull()
})
