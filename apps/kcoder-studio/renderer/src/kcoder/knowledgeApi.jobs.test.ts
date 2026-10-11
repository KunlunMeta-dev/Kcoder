import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { notifyAccountContextChange } from './accountContextEvents'
import { knowledgeApi, type WikiJob } from './knowledgeApi'

vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))

const job = (id: string, status = 'running'): WikiJob => ({
  id,
  status,
  sourceId: id,
  afterChunk: 0,
})
// QA: bounded-page public contract, atomic caller observation, cursor failures and account isolation.
// Request fixtures exercise RPC orchestration only; the native suite uses the actual backend.
describe('Wiki overview complete page observation', () => {
  beforeEach(() => vi.mocked(requestLocalExecutor).mockReset())

  test('reads every opaque cursor and deduplicates identities before returning once', async () => {
    vi.mocked(requestLocalExecutor)
      .mockResolvedValueOnce({ items: [job('one')], nextCursor: 'opaque-token' })
      .mockResolvedValueOnce({ items: [job('one', 'completed'), job('two')], nextCursor: null })
    expect(await knowledgeApi.jobs('target', 'library')).toEqual({
      items: [job('one', 'completed'), job('two')],
    })
    expect(requestLocalExecutor).toHaveBeenNthCalledWith(1, 'runtime.knowledge.request', {
      serverId: 'target',
      method: 'knowledge/job/overview',
      params: { libraryId: 'library' },
    })
    expect(requestLocalExecutor).toHaveBeenNthCalledWith(2, 'runtime.knowledge.request', {
      serverId: 'target',
      method: 'knowledge/job/overview',
      params: { libraryId: 'library', cursor: 'opaque-token' },
    })
  })

  test('old targets without a cursor remain a one-request compatible observation', async () => {
    vi.mocked(requestLocalExecutor).mockResolvedValue({ items: [job('old')] })
    expect(await knowledgeApi.jobs('target', 'library')).toEqual({ items: [job('old')] })
    expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
  })

  test('a later page failure or repeated cursor never returns a partial completed list', async () => {
    vi.mocked(requestLocalExecutor)
      .mockResolvedValueOnce({ items: [job('one', 'completed')], nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('disconnected'))
    await expect(knowledgeApi.jobs('target', 'library')).rejects.toThrow('disconnected')
    vi.mocked(requestLocalExecutor)
      .mockResolvedValueOnce({ items: [job('one', 'completed')], nextCursor: 'repeated' })
      .mockResolvedValueOnce({ items: [], nextCursor: 'repeated' })
    await expect(knowledgeApi.jobs('target', 'library')).rejects.toThrow('cursor did not advance')
  })

  test('account invalidation discards the complete round without crossing to another principal', async () => {
    vi.mocked(requestLocalExecutor).mockImplementationOnce(async () => {
      notifyAccountContextChange('account-target')
      return { items: [job('private-old')], nextCursor: 'private-cursor' }
    })
    await expect(knowledgeApi.jobs('account-target', 'library')).rejects.toThrow()
    expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
  })

  test('a stopped view does not request further pages or publish partial observations', async () => {
    let live = true
    vi.mocked(requestLocalExecutor).mockImplementationOnce(async () => {
      live = false
      return { items: [job('obsolete')], nextCursor: 'must-not-follow' }
    })
    await expect(knowledgeApi.jobs('target', 'library', () => live)).rejects.toThrow()
    expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
    vi.mocked(requestLocalExecutor).mockClear()
    await expect(knowledgeApi.jobs('target', 'library', () => false)).rejects.toThrow()
    expect(requestLocalExecutor).not.toHaveBeenCalled()
  })

  test('poll cancellation reaches every overview page and cannot continue to another cursor', async () => {
    const controller = new AbortController()
    vi.mocked(requestLocalExecutor).mockImplementationOnce(async (_method, _params, options) => {
      expect(options?.signal).toBe(controller.signal)
      controller.abort()
      return { items: [job('obsolete')], nextCursor: 'must-not-follow' }
    })
    await expect(
      knowledgeApi.jobs('target', 'library', () => true, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
  })
})
