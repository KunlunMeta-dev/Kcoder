import { expect, test } from 'vitest'
import { createInitialChunkName } from './initial-chunks'

test('keeps all static startup dependencies separate, including shared dependencies and cycles', () => {
  const graph: Record<string, string[]> = {
    startup: ['appearance', 'storage'], appearance: ['palette'], storage: ['palette'],
    palette: ['appearance'], main: ['appearance', 'react'], react: [],
  }
  const context = { getModuleInfo: (id: string) => graph[id] ? { importedIds: graph[id] } : null }
  const name = createInitialChunkName('startup')
  for (const id of ['startup', 'appearance', 'storage', 'palette']) expect(name(id, context)).toBeNull()
  for (const id of ['main', 'react']) expect(name(id, context)).toBe('workbench-initial')
})

test('a later build uses its current startup graph instead of retaining the prior classification', () => {
  const graph: Record<string, string[]> = { startup: [], extra: [] }
  const context = { getModuleInfo: (id: string) => ({ importedIds: graph[id] }) }
  const name = createInitialChunkName('startup')
  expect(name('extra', context)).toBe('workbench-initial')
  graph.startup.push('extra')
  expect(name('extra', context)).toBeNull()
})

test('an unavailable startup graph fails the build instead of merging its dependencies', () => {
  expect(() => createInitialChunkName('startup')('main', { getModuleInfo: () => null }))
    .toThrow('Missing startup module')
})
