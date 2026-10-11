import { beforeEach, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { knowledgeApi } from './knowledgeApi'

vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))

beforeEach(() => {
  vi.mocked(requestLocalExecutor).mockReset().mockResolvedValue({ items: [] })
})

test.each([
  ['pages', 'knowledge/page/list'],
  ['sources', 'knowledge/source/list'],
  ['removedSources', 'knowledge/source/removed'],
] as const)(
  '%s passes the catalog limit and preserves the existing default',
  async (operation, method) => {
    await knowledgeApi[operation]('target', 'library', 'cursor', 10)
    expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.knowledge.request', {
      serverId: 'target',
      method,
      params: { libraryId: 'library', afterId: 'cursor', limit: 10 },
    })
    await knowledgeApi[operation]('target', 'library')
    expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.knowledge.request', {
      serverId: 'target',
      method,
      params: { libraryId: 'library', afterId: undefined, limit: 50 },
    })
  }
)
