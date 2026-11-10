import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ProviderModelDiscovery } from './ProviderModelDiscovery'
import { discoverProviderSettingsModels, type ProviderDraft } from '@/kcoder/providerSettings'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import '@/i18n'

vi.mock('@/kcoder/providerSettings', () => ({ discoverProviderSettingsModels: vi.fn() }))
const draft: ProviderDraft = {
  id: '',
  endpoint: 'https://example.invalid/v1',
  apiFormat: 'openai_chat_completions',
  apiKey: 'owned-test-key',
  model: '',
  contextWindowTokens: 0,
  maxOutputTokens: 0,
  makeDefault: false,
}
beforeEach(() => {
  vi.mocked(discoverProviderSettingsModels).mockReset()
})

test('URL and key discover models before IDs or limits exist, without implicitly selecting a model', async () => {
  vi.mocked(discoverProviderSettingsModels).mockResolvedValue({ models: ['Model-B', 'Model-A'] })
  const select = vi.fn()
  render(
    <ProviderModelDiscovery
      serverId="owned"
      draft={draft}
      enabled
      hasStoredKey={false}
      ownerScope="owner"
      onSelect={select}
    />
  )
  await waitFor(() => expect(discoverProviderSettingsModels).toHaveBeenCalledOnce())
  expect(discoverProviderSettingsModels).toHaveBeenCalledWith('owned', draft, {
    signal: expect.any(AbortSignal),
  })
  const picker = await screen.findByTestId('provider-discovered-model')
  expect(picker).toHaveValue('')
  expect(select).not.toHaveBeenCalled()
  fireEvent.change(picker, { target: { value: 'Model-B' } })
  expect(select).toHaveBeenCalledExactlyOnceWith('Model-B')
  expect(discoverProviderSettingsModels).toHaveBeenCalledOnce()
})

test('changed URLs abort old discovery and discard its late result', async () => {
  let finish!: (value: { models: string[] }) => void
  vi.mocked(discoverProviderSettingsModels)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValue({ models: ['new-endpoint-model'] })
  const props = {
    serverId: 'owned',
    draft,
    enabled: true,
    hasStoredKey: false,
    ownerScope: 'owner',
    onSelect: vi.fn(),
  }
  const view = render(<ProviderModelDiscovery {...props} />)
  await waitFor(() => expect(discoverProviderSettingsModels).toHaveBeenCalledOnce())
  const signal = vi.mocked(discoverProviderSettingsModels).mock.calls[0][2]?.signal
  view.rerender(
    <ProviderModelDiscovery {...props} draft={{ ...draft, endpoint: 'https://new.invalid/v1' }} />
  )
  expect(signal?.aborted).toBe(true)
  await act(async () => finish({ models: ['stale-model'] }))
  await screen.findByText('new-endpoint-model')
  expect(screen.queryByText('stale-model')).not.toBeInTheDocument()
})

test('account invalidation prevents an old response', async () => {
  let finish!: (value: { models: string[] }) => void
  vi.mocked(discoverProviderSettingsModels).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const props = {
    serverId: 'owned',
    draft,
    enabled: true,
    hasStoredKey: false,
    ownerScope: 'owner',
    onSelect: vi.fn(),
  }
  render(<ProviderModelDiscovery {...props} />)
  await waitFor(() => expect(discoverProviderSettingsModels).toHaveBeenCalledOnce())
  act(() => notifyAccountContextChange('owned'))
  await act(async () => finish({ models: ['old-account-model'] }))
  expect(screen.queryByText('old-account-model')).not.toBeInTheDocument()
})

test('upstream error text is never exposed', async () => {
  let reject!: (error: Error) => void
  vi.mocked(discoverProviderSettingsModels).mockImplementation(
    () =>
      new Promise((_resolve, no) => {
        reject = no
      })
  )
  render(
    <ProviderModelDiscovery
      serverId="errors"
      draft={draft}
      enabled
      hasStoredKey={false}
      ownerScope="owner"
      onSelect={vi.fn()}
    />
  )
  await waitFor(() => expect(discoverProviderSettingsModels).toHaveBeenCalledOnce())
  await act(async () => {
    reject(new Error('[provider_discovery_authentication] private-key-server-text'))
  })
  expect(await screen.findByTestId('provider-discovery-error')).toHaveTextContent('API Key')
  expect(document.body).not.toHaveTextContent('private-key-server-text')
})

test('blank keys do not trigger discovery until explicit keyless authentication is selected', async () => {
  vi.mocked(discoverProviderSettingsModels).mockResolvedValue({ models: [] })
  const props = {
    serverId: 'owned',
    enabled: true,
    hasStoredKey: false,
    ownerScope: 'owner',
    onSelect: vi.fn(),
  }
  const view = render(<ProviderModelDiscovery {...props} draft={{ ...draft, apiKey: '' }} />)
  expect(screen.getByTestId('provider-discover-models')).toBeDisabled()
  expect(discoverProviderSettingsModels).not.toHaveBeenCalled()
  view.rerender(
    <ProviderModelDiscovery
      {...props}
      draft={{ ...draft, apiKey: '', authentication: { mode: 'none' } }}
    />
  )
  fireEvent.click(screen.getByTestId('provider-discover-models'))
  expect(await screen.findByText('服务没有返回模型；可在模型 ID 中手动填写。')).toBeInTheDocument()
})
