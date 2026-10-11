import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { WikiImageImports } from './WikiImageImports'
import { knowledgeApi, type WikiImageImport } from '@/kcoder/knowledgeApi'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: {
    imageImports: vi.fn(),
    resumeImageImport: vi.fn(),
    cancelImageImport: vi.fn(),
    startJob: vi.fn(),
  },
}))
const item: WikiImageImport = {
  id: 'import',
  idempotencyKey: 'file:stable',
  title: 'one.png',
  status: 'failed',
  phase: 'validation',
  model: 'vision',
  sourceId: null,
  revisionId: null,
  errorCode: 'validation_failed',
  reservedCalls: 1,
  callLimit: 1,
  usageReportedCalls: 1,
  unknownUsageCalls: 0,
  inputTokens: 12,
  outputTokens: 7,
  textBytes: 100,
  reasoningBytes: 0,
  updatedAtMs: 1,
}
const current = () => true
const props = {
  serverId: 'target',
  libraryId: 'library',
  isCurrent: current,
  canOrganize: true,
  refreshSignal: 0,
  onChanged: vi.fn(),
}
// QA: public RPC projection, same identity recovery and disable/cancel; no model quality assertions.
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(knowledgeApi.imageImports).mockResolvedValue({
    supported: true,
    items: [item],
    nextAfterId: null,
  })
})
test('failed validation resumes the recorded import before creating its organization job', async () => {
  const source = { sourceId: 'source', revisionId: 'revision', title: item.title, bodyHash: 'body' }
  vi.mocked(knowledgeApi.resumeImageImport).mockResolvedValue(source)
  render(<WikiImageImports {...props} />)
  await waitFor(() => expect(screen.getByTestId('wiki-image-import-resume')).toBeEnabled())
  fireEvent.click(screen.getByTestId('wiki-image-import-resume'))
  await waitFor(() =>
    expect(knowledgeApi.startJob).toHaveBeenCalledWith('target', 'library', source, 'en')
  )
  expect(knowledgeApi.resumeImageImport).toHaveBeenCalledWith('target', 'library', item)
  expect(screen.getByTestId('wiki-image-import-usage')).toHaveTextContent('imageImport.usage')
})
test('disabled organization prevents resume while cancellation remains available', async () => {
  render(<WikiImageImports {...props} canOrganize={false} />)
  await waitFor(() => expect(screen.getByTestId('wiki-image-import-resume')).toBeDisabled())
  fireEvent.click(screen.getByTestId('wiki-image-import-cancel'))
  await waitFor(() =>
    expect(knowledgeApi.cancelImageImport).toHaveBeenCalledWith('target', 'library', item.id)
  )
  expect(knowledgeApi.resumeImageImport).not.toHaveBeenCalled()
})
