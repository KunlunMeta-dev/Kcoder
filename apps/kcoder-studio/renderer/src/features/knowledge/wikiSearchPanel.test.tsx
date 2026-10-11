import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { WikiSearch } from './WikiSearch'
import { knowledgeApi } from '@/kcoder/knowledgeApi'

vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: { search: vi.fn(), page: vi.fn() },
}))
beforeEach(() => vi.resetAllMocks())
const current = () => true
const props = {
  serverId: 'local',
  libraryId: 'one',
  isCurrent: current,
  onPage: vi.fn(),
  onSource: vi.fn(),
}
const hit = (documentId: string, title: string) => ({
  documentId,
  revisionId: 'revision-current',
  title,
  excerpt: '实际命中的数据库事务片段',
  bm25: -1,
})

test('groups source chunks and opens the displayed exact revision', async () => {
  vi.mocked(knowledgeApi.search).mockResolvedValue({
    items: [hit('source:one:chunk-2', '真实资料'), hit('source:one:chunk-1', '重复块')],
  } as never)
  const onSource = vi.fn()
  render(<WikiSearch {...props} onSource={onSource} />)
  fireEvent.change(screen.getByTestId('wiki-search'), { target: { value: '数据库事务' } })
  await screen.findByText('真实资料')
  expect(screen.queryByText('重复块')).not.toBeInTheDocument()
  expect(screen.getByText(/revision-current/)).toBeInTheDocument()
  expect(screen.getByText('实际命中的数据库事务片段')).toBeInTheDocument()
  fireEvent.click(screen.getByText('真实资料'))
  expect(onSource).toHaveBeenCalledWith({
    sourceId: 'one',
    revisionId: 'revision-current',
    title: '真实资料',
    bodyHash: '',
  })
})

test('rejects a late response from the previous library and renders the new one', async () => {
  let finishOld!: (value: never) => void
  vi.mocked(knowledgeApi.search)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishOld = resolve
        })
    )
    .mockResolvedValueOnce({ items: [hit('new-page', '新资料')] } as never)
  const view = render(<WikiSearch {...props} />)
  fireEvent.change(screen.getByTestId('wiki-search'), { target: { value: '事务' } })
  await waitFor(() => expect(knowledgeApi.search).toHaveBeenCalledTimes(1))
  view.rerender(<WikiSearch {...props} libraryId="two" />)
  await act(async () => {
    finishOld({ items: [hit('old-page', '旧资料')] } as never)
  })
  expect(screen.queryByText('旧资料')).not.toBeInTheDocument()
  await screen.findByText('新资料')
  expect(knowledgeApi.search).toHaveBeenLastCalledWith('local', 'two', '事务')
})

test('failed search ends loading and a new query recovers', async () => {
  vi.mocked(knowledgeApi.search)
    .mockRejectedValueOnce(new Error('search-failed'))
    .mockResolvedValueOnce({ items: [hit('recovered-page', '恢复资料')] } as never)
  render(<WikiSearch {...props} />)
  fireEvent.change(screen.getByTestId('wiki-search'), { target: { value: '失败' } })
  await screen.findByText('search-failed')
  expect(screen.queryByText(/Loading|正在加载/)).not.toBeInTheDocument()
  fireEvent.change(screen.getByTestId('wiki-search'), { target: { value: '恢复' } })
  await screen.findByText('恢复资料')
  expect(screen.queryByText('search-failed')).not.toBeInTheDocument()
})
