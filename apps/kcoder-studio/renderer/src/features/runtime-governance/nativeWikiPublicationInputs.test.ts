import { expect, test, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ libraries: vi.fn(), pages: vi.fn() }))
vi.mock('@/kcoder/knowledgeApi', () => ({ knowledgeApi: fixture }))
import { nativeWikiPublicationInputs } from './nativeWikiPublicationInputs'

test('requests ten actual rows and preserves the native cursor and exact page revision', async () => {
  fixture.libraries.mockResolvedValue({ items: [{ id: 'native-library', name: 'Selected library', archived: false }], nextAfterId: 'native-library-cursor' })
  fixture.pages.mockResolvedValue({ items: [{ pageId: 'native-page', revisionId: 'fixed-r1', title: 'Fixed page' }], nextAfterId: 'native-page-cursor' })
  const provider = nativeWikiPublicationInputs('native-owner', 'chosen-target', () => true)
  const signal = new AbortController().signal
  expect(await provider.listLibraries({ limit: 10, signal })).toEqual({ items: [{ id: 'native-library', title: 'Selected library', archived: false }], nextCursor: 'native-library-cursor' })
  expect(await provider.listPages({ libraryId: 'native-library', after: 'previous-page', limit: 10, signal })).toEqual({ items: [{ title: 'Fixed page', source: { libraryId: 'native-library', pageId: 'native-page', pageRevision: 'fixed-r1' } }], nextCursor: 'native-page-cursor' })
  expect(fixture.libraries).toHaveBeenLastCalledWith('chosen-target', undefined, 10, { signal })
  expect(fixture.pages).toHaveBeenLastCalledWith('chosen-target', 'native-library', 'previous-page', 10, { signal })
})

test('a response arriving after native owner invalidation is rejected', async () => {
  let finish!: (value: unknown) => void
  fixture.libraries.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  let current = true
  const provider = nativeWikiPublicationInputs('native-owner', 'chosen-target', () => current)
  const pending = provider.listLibraries({ limit: 10, signal: new AbortController().signal })
  current = false
  finish({ items: [{ id: 'old-library', name: 'Old owner' }], nextAfterId: null })
  await expect(pending).rejects.toMatchObject({ code: 'KNOWLEDGE_OWNER_CHANGED' })
})
