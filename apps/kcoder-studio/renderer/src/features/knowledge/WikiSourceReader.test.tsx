import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { WikiSourceReader } from './WikiSourceReader'
import { knowledgeApi } from '@/kcoder/knowledgeApi'
vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: { source: vi.fn(), originalFile: vi.fn() },
}))
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:original'), revokeObjectURL: vi.fn() })
  )
  vi.mocked(knowledgeApi.source).mockResolvedValue({
    items: [{ chunkId: 'chunk-1', text: 'Model interpretation', firstLine: 1, lastLine: 1 }],
    nextAfterChunk: null,
  } as never)
  vi.mocked(knowledgeApi.originalFile).mockResolvedValue({
    filename: 'picture.png',
    blob: new Blob(['fixture'], { type: 'image/png' }),
  })
})
test('shows the actual original image separately from the interpreted source text and releases its URL', async () => {
  const current = () => true
  const props = {
    serverId: 'remote',
    libraryId: 'library',
    source: { sourceId: 'source', revisionId: 'revision', title: 'picture.png', bodyHash: 'hash' },
    isCurrent: current,
    onClose: vi.fn(),
    onChanged: vi.fn(),
    canOrganize: false,
  }
  const view = render(<WikiSourceReader {...props} />)
  await waitFor(() =>
    expect(screen.getByTestId('wiki-original-image')).toHaveAttribute('src', 'blob:original')
  )
  expect(screen.getByText('Model interpretation')).toBeInTheDocument()
  expect(screen.getByTestId('wiki-original-download')).toBeInTheDocument()
  expect(knowledgeApi.originalFile).toHaveBeenCalledWith('remote', 'library', props.source, current)
  view.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:original')
})
