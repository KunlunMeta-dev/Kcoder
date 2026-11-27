import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { CollaborationCreator, type CollaborationCreatorProps } from './CollaborationCreator'
import { taskCollaborationResources } from './locales'
import {
  catalog,
  definition,
  installCollaborationGateway,
  prepared,
} from './gatewayFixture.test-support'
import { localServer } from '../gatewayFixture.test-support'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'

vi.mock('@/kcoder/gatewayRpc', async original => ({
  ...(await original<object>()),
  fetchGatewayServers: async () => [localServer],
}))
const owned: { dispose(): Promise<void> }[] = []
const target = { serverId: 'local', workspacePath: '/owned-workspace' }
beforeEach(() => {
  localStorage.clear()
  installTestTransport(() => undefined)
})
afterEach(async () => {
  cleanup()
  await Promise.all(owned.splice(0).map(item => item.dispose()))
  vi.restoreAllMocks()
  clearTestTransports()
})
async function mount(props: Partial<CollaborationCreatorProps> = {}, language = 'zh-CN') {
  const i18n = createInstance()
  await i18n.init({
    lng: language,
    fallbackLng: 'en',
    resources: {
      en: { taskCollaboration: taskCollaborationResources.en },
      'zh-CN': { taskCollaboration: taskCollaborationResources['zh-CN'] },
    },
    interpolation: { escapeValue: false },
  })
  const component = (next: Partial<CollaborationCreatorProps> = {}) => (
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <CollaborationCreator target={target} {...props} {...next} />
      </I18nextProvider>
    </StrictMode>
  )
  const view = render(component())
  await waitFor(() => expect(screen.getByTestId('collaboration-prepare')).not.toBeDisabled())
  return {
    ...view,
    change(next: Partial<CollaborationCreatorProps>) {
      view.rerender(component(next))
    },
  }
}
function fill() {
  fireEvent.change(screen.getByTestId('collaboration-title'), {
    target: { value: 'Owned collaboration' },
  })
  fireEvent.change(screen.getByTestId('collaboration-objective'), {
    target: { value: 'Compare the supplied sources' },
  })
  fireEvent.change(screen.getByTestId('collaboration-criteria'), {
    target: { value: 'Cite original evidence\nCheck conclusions' },
  })
  fireEvent.click(screen.getByTestId('collaboration-inherit-model'))
}

test('StrictMode form prepares original CAS draft then saves fixed version without executing', async () => {
  const gateway = installCollaborationGateway()
  owned.push(gateway)
  const saved = vi.fn()
  await mount({ originalThreadId: 'original-thread', onSaved: saved })
  expect(screen.getByTestId('collaboration-creator')).toHaveTextContent('尚未观察到原会话模型')
  fireEvent.click(screen.getByTestId('collaboration-prepare'))
  expect(screen.getByRole('alert')).toHaveTextContent('明确选择模型继承')
  expect(gateway.calls.some(call => call.method === 'workflow/create')).toBe(false)
  fill()
  fireEvent.click(screen.getByTestId('collaboration-prepare'))
  await screen.findByTestId('collaboration-save')
  expect(screen.getByRole('status')).toHaveTextContent('草稿已准备，尚未启动任务')
  expect(gateway.calls.filter(call => call.method === 'workflow/create')).toHaveLength(1)
  const apply = gateway.calls.find(call => call.method === 'workflow/collaboration/apply')!
  expect(apply.params).toMatchObject({ id: 'original-created-draft', expectedRevision: 1 })
  expect(screen.getByTestId('collaboration-title')).toBeDisabled()
  fireEvent.click(screen.getByTestId('collaboration-save'))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已保存版本 1'))
  expect(saved).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'original-created-draft', status: 'saved', savedVersion: 1 }),
    target
  )
  expect(
    gateway.calls.some(call => call.method.includes('/run') || call.method === 'turn/start')
  ).toBe(false)
})

test('lost create acknowledgement blocks duplicate writes and offers normal library inspection', async () => {
  const gateway = installCollaborationGateway(async (method, params) => {
    if (method === 'workflow/collaboration/catalog')
      return catalog(params.threadId as string | undefined)
    throw new Error('Write response lost')
  })
  owned.push(gateway)
  const library = vi.fn()
  await mount({ onOpenLibrary: library })
  fill()
  fireEvent.click(screen.getByTestId('collaboration-prepare'))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('写入结果尚未确认'))
  expect(screen.getByTestId('collaboration-prepare')).toBeDisabled()
  expect(screen.queryByTestId('collaboration-read-original')).toBeNull()
  fireEvent.click(screen.getByTestId('collaboration-open-library'))
  expect(library).toHaveBeenCalledWith(target)
  expect(gateway.calls.filter(call => call.method === 'workflow/create')).toHaveLength(1)
  expect(
    gateway.calls.some(call => call.method === 'workflow/list' || call.method === 'workflow/read')
  ).toBe(false)
})

test('lost apply acknowledgement followed by peer graph edits stays unknown after reading the same original id', async () => {
  const peer = prepared()
  peer.revision = 3
  peer.title = 'Peer-owned different graph'
  peer.nodes[0].prompt = 'Peer replaced the task instructions'
  const gateway = installCollaborationGateway(async (method, params) => {
    if (method === 'workflow/collaboration/catalog')
      return catalog(params.threadId as string | undefined)
    if (method === 'workflow/create') return definition()
    if (method === 'workflow/collaboration/apply') throw new Error('Lost apply response')
    if (method === 'workflow/read') return peer
    throw new Error('Unexpected operation')
  })
  owned.push(gateway)
  await mount()
  fill()
  fireEvent.click(screen.getByTestId('collaboration-prepare'))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('写入结果尚未确认'))
  fireEvent.click(screen.getByTestId('collaboration-read-original'))
  await waitFor(() =>
    expect(screen.getByTestId('collaboration-original-draft')).toHaveTextContent(
      'Peer-owned different graph'
    )
  )
  expect(screen.getByTestId('collaboration-save')).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('写入结果尚未确认')
  expect(screen.getByRole('status')).toHaveTextContent('写入结果尚未确认')
  expect(gateway.calls.filter(call => call.method === 'workflow/read')[0].params).toEqual({
    id: 'original-created-draft',
  })
  expect(gateway.calls.filter(call => call.method === 'workflow/create')).toHaveLength(1)
  expect(gateway.calls.filter(call => call.method === 'workflow/collaboration/apply')).toHaveLength(
    1
  )
  expect(gateway.calls.some(call => call.method === 'workflow/save')).toBe(false)
})

test('cancel waiting after dispatch keeps unknown outcome and ignores late success', async () => {
  let complete!: (value: unknown) => void
  const gateway = installCollaborationGateway(async (method, params) => {
    if (method === 'workflow/collaboration/catalog')
      return catalog(params.threadId as string | undefined)
    if (method === 'workflow/create')
      return new Promise(done => {
        complete = done
      })
    throw new Error('Unexpected follow-up')
  })
  owned.push(gateway)
  const saved = vi.fn()
  await mount({ onSaved: saved })
  fill()
  fireEvent.click(screen.getByTestId('collaboration-prepare'))
  await waitFor(() =>
    expect(gateway.calls.some(call => call.method === 'workflow/create')).toBe(true)
  )
  fireEvent.click(screen.getByTestId('collaboration-cancel-wait'))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('写入结果尚未确认'))
  await act(async () => {
    complete(definition())
    await Promise.resolve()
  })
  expect(screen.queryByTestId('collaboration-original-draft')).toBeNull()
  expect(gateway.calls.some(call => call.method === 'workflow/collaboration/apply')).toBe(false)
  expect(saved).not.toHaveBeenCalled()
})

test('account invalidation clears original draft and never publishes stale success', async () => {
  const gateway = installCollaborationGateway()
  owned.push(gateway)
  await mount()
  fill()
  fireEvent.click(screen.getByTestId('collaboration-prepare'))
  await screen.findByTestId('collaboration-original-draft')
  act(() => notifyAccountContextChange('local'))
  await waitFor(() => expect(screen.queryByTestId('collaboration-original-draft')).toBeNull())
  expect(screen.getByTestId('collaboration-title')).toHaveValue('')
  expect(gateway.calls.filter(call => call.method === 'workflow/create')).toHaveLength(1)
})

test('English new draft distinguishes future execution model and validates concrete output paths', async () => {
  const gateway = installCollaborationGateway()
  owned.push(gateway)
  const view = await mount({}, 'en')
  expect(screen.getByTestId('collaboration-creator')).toHaveTextContent(
    'actual model is resolved from the execution conversation'
  )
  fill()
  fireEvent.change(screen.getByTestId('collaboration-scheme'), {
    target: { value: 'draft_verify' },
  })
  fireEvent.change(screen.getByTestId('collaboration-path'), { target: { value: '../outside.md' } })
  fireEvent.click(screen.getByTestId('collaboration-prepare'))
  expect(screen.getByRole('alert')).toHaveTextContent('workspace-relative path')
  expect(gateway.calls.some(call => call.method === 'workflow/create')).toBe(false)
  view.change({ originalThreadId: 'other-original' })
  await waitFor(() =>
    expect(screen.getByTestId('collaboration-creator')).toHaveTextContent(
      'No workspace default is used'
    )
  )
  expect(screen.getByTestId('collaboration-title')).toHaveValue('')
})

test('workspace change during dispatched creation cannot install the previous workspace draft', async () => {
  let complete!: (value: unknown) => void
  const gateway = installCollaborationGateway(async (method, params) => {
    if (method === 'workflow/collaboration/catalog')
      return catalog(params.threadId as string | undefined)
    if (method === 'workflow/create')
      return new Promise(done => {
        complete = done
      })
    throw new Error('Stale workspace must not apply')
  })
  owned.push(gateway)
  const saved = vi.fn()
  const view = await mount({ onSaved: saved })
  fill()
  fireEvent.click(screen.getByTestId('collaboration-prepare'))
  await waitFor(() =>
    expect(gateway.calls.some(call => call.method === 'workflow/create')).toBe(true)
  )
  view.change({ target: { serverId: 'local', workspacePath: '/other-owned-workspace' } })
  await waitFor(() => expect(screen.getByTestId('collaboration-prepare')).not.toBeDisabled())
  await act(async () => {
    complete(definition())
    await Promise.resolve()
  })
  expect(screen.queryByTestId('collaboration-original-draft')).toBeNull()
  expect(screen.getByTestId('collaboration-title')).toHaveValue('')
  expect(gateway.calls.some(call => call.method === 'workflow/collaboration/apply')).toBe(false)
  expect(saved).not.toHaveBeenCalled()
})
