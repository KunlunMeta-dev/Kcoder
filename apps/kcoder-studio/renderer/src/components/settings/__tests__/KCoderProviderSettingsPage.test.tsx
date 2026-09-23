import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { initialWorkbenchState } from '@/features/workbench/workbenchReducer'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { KCoderProviderSettingsPage } from '../KCoderProviderSettingsPage'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import {
  applyProviderSettings,
  deleteProviderSettings,
  readProviderSettings,
  readProviderTemplates,
  saveProviderSettings,
} from '@/kcoder/providerSettings'
import '@/i18n'

vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: vi.fn() }))
vi.mock('@/kcoder/configTemplates', () => ({
  listSettingsTemplates: vi.fn(async () => ({ templates: [], defaultId: undefined })),
  readSettingsTemplate: vi.fn(),
  saveSettingsTemplate: vi.fn(),
  deleteSettingsTemplate: vi.fn(),
  setDefaultSettingsTemplate: vi.fn(),
}))
vi.mock('@/kcoder/providerSettings', () => ({
  readProviderTemplates: vi.fn(),
  applyProviderSettings: vi.fn(),
  deleteProviderSettings: vi.fn(),
  readProviderSettings: vi.fn(),
  saveProviderSettings: vi.fn(),
}))

const profile = {
  id: 'custom',
  apiFormat: 'openai_chat_completions',
  endpoint: 'https://example.invalid/v1',
  model: 'user-model',
  contextWindowTokens: 32000,
  maxOutputTokens: 4096,
  apiKeyConfigured: true,
  isDefault: true,
}

test('lost save response requires reading and explicitly reviewing the target before another save', async () => {
  vi.mocked(saveProviderSettings).mockRejectedValueOnce(
    Object.assign(new Error('fixture-secret'), { reason: 'connection' })
  )
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-apiKey'), {
    target: { value: 'draft-fixture-secret' },
  })
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(await screen.findByTestId('provider-save-recovery')).toHaveTextContent('尚不能确认')
  expect(screen.getByTestId('provider-save')).toBeDisabled()
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('draft-fixture-secret')
  fireEvent.submit(screen.getByTestId('provider-form'))
  fireEvent.click(screen.getByTestId('provider-edit-custom'))
  expect(saveProviderSettings).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('provider-save')).toBeDisabled()
  vi.mocked(readProviderSettings).mockRejectedValueOnce(new Error('fixture-secret'))
  fireEvent.click(screen.getByTestId('provider-refresh'))
  await screen.findByRole('alert')
  expect(screen.getByTestId('provider-save')).toBeDisabled()
  fireEvent.click(screen.getByTestId('provider-refresh'))
  await waitFor(() =>
    expect(screen.getByTestId('provider-save-recovery')).toHaveTextContent('已读取')
  )
  expect(screen.getByTestId('provider-save')).toBeDisabled()
  fireEvent.click(screen.getByTestId('provider-edit-custom'))
  expect(screen.queryByTestId('provider-save-recovery')).not.toBeInTheDocument()
  expect(screen.getByTestId('provider-save')).toBeEnabled()
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
  expect(document.body).not.toHaveTextContent('fixture-secret')
})

test('probe timeout remains a pre-commit failure and permits correcting the draft', async () => {
  vi.mocked(saveProviderSettings).mockRejectedValueOnce(
    new Error('[provider_probe_timeout] fixture-secret')
  )
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(await screen.findByRole('alert')).toHaveTextContent('超时')
  expect(screen.queryByTestId('provider-save-recovery')).not.toBeInTheDocument()
  expect(screen.getByTestId('provider-save')).toBeEnabled()
  expect(document.body).not.toHaveTextContent('fixture-secret')
})

test('switching targets discards uncertain-save recovery and does not carry the old key', async () => {
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/work' },
    { id: 'local', label: 'Local', transport: 'local', workspacePath: '/local' },
  ])
  vi.mocked(saveProviderSettings).mockRejectedValueOnce(
    Object.assign(new Error('fixture-secret'), { reason: 'connection' })
  )
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-apiKey'), {
    target: { value: 'old-target-secret' },
  })
  fireEvent.submit(screen.getByTestId('provider-form'))
  await screen.findByTestId('provider-save-recovery')
  fireEvent.change(screen.getByTestId('provider-target'), { target: { value: 'local' } })
  await waitFor(() => expect(readProviderSettings).toHaveBeenLastCalledWith('local'))
  await waitFor(() => expect(screen.getByTestId('provider-save')).toBeEnabled())
  expect(screen.queryByTestId('provider-save-recovery')).not.toBeInTheDocument()
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
  expect(saveProviderSettings).toHaveBeenCalledTimes(1)
})

test('account replacement on the same server invalidates the previous model draft', async () => {
  const server = {
    id: 'remote',
    label: 'Remote',
    transport: 'ssh' as const,
    workspacePath: '/work',
  }
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    {
      ...server,
      authorityId: 'authority',
      accountIdentity: { principalId: 'first', username: 'first', role: 'user' },
    },
  ])
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  expect(screen.getByTestId('provider-identity')).toHaveTextContent('first')
  fireEvent.change(screen.getByTestId('provider-apiKey'), {
    target: { value: 'first-account-draft-key' },
  })
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    {
      ...server,
      authorityId: 'authority',
      accountIdentity: { principalId: 'second', username: 'second', role: 'user' },
    },
  ])
  vi.mocked(readProviderSettings).mockResolvedValue({
    profiles: [{ ...profile, id: 'second-account-api' }],
    restartRequired: false,
  })
  act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
  await screen.findByTestId('provider-edit-second-account-api')
  expect(screen.getByTestId('provider-identity')).toHaveTextContent('second')
  expect(screen.getByTestId('provider-identity')).not.toHaveTextContent('first')
  expect(screen.queryByTestId('provider-edit-custom')).not.toBeInTheDocument()
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
  expect(saveProviderSettings).not.toHaveBeenCalled()
})

test('unrelated server refresh preserves the draft only after confirming the same scope', async () => {
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-apiKey'), { target: { value: 'same-scope-draft' } })
  act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
  await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByTestId('provider-apiKey')).toHaveValue('same-scope-draft'))
  expect(saveProviderSettings).not.toHaveBeenCalled()
})

test('failed identity refresh cannot expose or save the previous account draft', async () => {
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-apiKey'), { target: { value: 'old-scope-draft' } })
  vi.mocked(fetchGatewayServers).mockRejectedValueOnce(new Error('unavailable'))
  act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
  await screen.findByRole('alert')
  expect(screen.getByTestId('provider-identity')).toHaveTextContent('尚未确认身份')
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
  expect(screen.getByTestId('provider-save')).toBeDisabled()
  expect(saveProviderSettings).not.toHaveBeenCalled()
})

test.each(['success', 'failure'] as const)(
  'late %s from the previous account cannot restore its draft or status',
  async outcome => {
    const server = {
      id: 'remote',
      label: 'Remote',
      transport: 'ssh' as const,
      workspacePath: '/work',
    }
    vi.mocked(fetchGatewayServers).mockResolvedValue([
      {
        ...server,
        authorityId: 'authority',
        accountIdentity: { principalId: 'first', username: 'first', role: 'user' },
      },
    ])
    let resolveSave!: (value: Awaited<ReturnType<typeof saveProviderSettings>>) => void
    let rejectSave!: (error: Error) => void
    vi.mocked(saveProviderSettings).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          resolveSave = resolve
          rejectSave = reject
        })
    )
    render(<KCoderProviderSettingsPage />)
    fireEvent.click(await screen.findByTestId('provider-edit-custom'))
    fireEvent.change(screen.getByTestId('provider-apiKey'), {
      target: { value: 'old-account-key' },
    })
    fireEvent.submit(screen.getByTestId('provider-form'))
    await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledTimes(1))
    vi.mocked(fetchGatewayServers).mockResolvedValue([
      {
        ...server,
        authorityId: 'authority',
        accountIdentity: { principalId: 'second', username: 'second', role: 'user' },
      },
    ])
    vi.mocked(readProviderSettings).mockResolvedValue({
      profiles: [{ ...profile, id: 'second-api' }],
      restartRequired: false,
    })
    act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
    await screen.findByTestId('provider-edit-second-api')
    await act(async () => {
      if (outcome === 'success') resolveSave({ profiles: [profile], restartRequired: true })
      else rejectSave(Object.assign(new Error('old-account-secret'), { reason: 'connection' }))
    })
    expect(screen.queryByTestId('provider-edit-custom')).not.toBeInTheDocument()
    expect(screen.getByTestId('provider-edit-second-api')).toBeVisible()
    expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
    expect(screen.queryByTestId('provider-save-recovery')).not.toBeInTheDocument()
    expect(screen.queryByTestId('provider-pending-apply')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(saveProviderSettings).toHaveBeenCalledTimes(1)
  }
)

test('adds a sibling model without replacing the API default or shared connection', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    supportsMultipleModels: true,
    profiles: [{ ...profile, isProviderDefault: true, canDelete: true }],
    restartRequired: false,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-add-model-custom'))
  expect(screen.getByTestId('provider-default')).not.toBeChecked()
  expect(screen.getByTestId('provider-id')).toBeDisabled()
  expect(screen.getByTestId('provider-endpoint')).toBeDisabled()
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'sibling-model' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() =>
    expect(saveProviderSettings).toHaveBeenCalledWith(
      'remote',
      expect.objectContaining({
        id: 'custom',
        model: 'sibling-model',
        contextWindowTokens: 100_000_000,
        maxOutputTokens: 65_536,
        makeDefault: false,
        endpoint: profile.endpoint,
      })
    )
  )
  expect(vi.mocked(saveProviderSettings).mock.calls[0][1]).not.toHaveProperty('originalModel')
})

test('multi-model edits carry the exact original model and use distinct row identities', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    supportsMultipleModels: true,
    profiles: [profile, { ...profile, model: 'second/model', isDefault: false }],
    restartRequired: false,
  })
  render(<KCoderProviderSettingsPage />)
  expect(await screen.findByTestId('provider-edit-custom::user-model')).toBeVisible()
  fireEvent.click(screen.getByTestId('provider-edit-custom::second%2Fmodel'))
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'renamed-model' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() =>
    expect(saveProviderSettings).toHaveBeenCalledWith(
      'remote',
      expect.objectContaining({
        id: 'custom',
        model: 'renamed-model',
        originalModel: 'second/model',
        makeDefault: false,
      })
    )
  )
})

test('legacy servers refuse new drafts with an existing API id rather than overwriting it', async () => {
  render(<KCoderProviderSettingsPage />)
  await screen.findByTestId('provider-edit-custom')
  fireEvent.click(screen.getByTestId('provider-new'))
  fireEvent.change(screen.getByTestId('provider-id'), { target: { value: 'custom' } })
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'another' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(saveProviderSettings).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('升级')
})

test('adding an existing model or renaming onto a sibling cannot overwrite its settings', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    supportsMultipleModels: true,
    profiles: [profile, { ...profile, model: 'second', isDefault: false }],
    restartRequired: false,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-add-model-custom'))
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'second' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(saveProviderSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('provider-edit-custom::user-model'))
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'second' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(saveProviderSettings).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('已存在')
})

test('deleting an API default model automatically selects a sibling and preserves credentials', async () => {
  const rows = [
    { ...profile, isDefault: false, isProviderDefault: true, canDelete: true },
    { ...profile, model: 'second', isDefault: false, isProviderDefault: false, canDelete: true },
  ]
  vi.mocked(readProviderSettings).mockResolvedValue({
    supportsMultipleModels: true,
    profiles: rows,
    restartRequired: false,
  })
  vi.mocked(deleteProviderSettings).mockResolvedValue({
    supportsMultipleModels: true,
    profiles: [rows[1]],
    restartRequired: true,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-delete-model-custom::user-model'))
  expect(screen.getByTestId('provider-delete-dialog-confirm')).toBeEnabled()
  expect(screen.queryByTestId('provider-delete-credentials')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('provider-delete-dialog-confirm'))
  await waitFor(() =>
    expect(deleteProviderSettings).toHaveBeenCalledWith('remote', 'custom', {
      model: 'user-model',
      removeCredentials: false,
    })
  )
  expect(await screen.findByTestId('provider-delete-model-custom::second')).toBeDisabled()
})

test('whole API deletion checks every model for default and deduplicates replacement providers', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    supportsMultipleModels: true,
    profiles: [
      { ...profile, canDelete: true },
      { ...profile, model: 'second', isDefault: false, canDelete: true },
      { ...profile, id: 'backup', isDefault: false, canDelete: true },
      { ...profile, id: 'backup', model: 'second', isDefault: false, canDelete: true },
    ],
    restartRequired: false,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-delete-custom'))
  expect(screen.getByTestId('provider-delete-dialog-confirm')).toBeEnabled()
  expect(
    screen.getByTestId('provider-delete-replacement').querySelectorAll('option[value="backup"]')
  ).toHaveLength(1)
})

test('lets users edit explicit model capabilities without changing a running model', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    profiles: [
      {
        ...profile,
        capabilities: {
          text: true,
          tools: true,
          vision: false,
          reasoning: false,
          structured_output: true,
        },
      },
    ],
    restartRequired: false,
    supportsModelCapabilities: true,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.click(screen.getByTestId('provider-capability-tools'))
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() =>
    expect(saveProviderSettings).toHaveBeenCalledWith(
      'remote',
      expect.objectContaining({
        capabilities: {
          text: true,
          tools: false,
          vision: false,
          reasoning: false,
          structured_output: true,
        },
      })
    )
  )
  expect(applyProviderSettings).not.toHaveBeenCalled()
})

const template = {
  id: 'fixture-template',
  displayName: 'Fixture service',
  apiFormat: 'openai_chat_completions',
  endpoint: 'https://template.invalid/v1',
  documentationUrl: 'https://template.invalid/docs',
}

test('template selection only pre-fills a draft and clears the previously selected model', async () => {
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-apiKey'), { target: { value: 'fixture-secret' } })
  fireEvent.change(await screen.findByTestId('provider-template'), {
    target: { value: 'fixture-template' },
  })
  expect(screen.getByTestId('provider-endpoint')).toHaveValue('https://template.invalid/v1')
  expect(screen.getByTestId('provider-model')).toHaveValue('')
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('fixture-secret')
  expect(screen.getByTestId('provider-contextWindowTokens')).toHaveValue(
    profile.contextWindowTokens
  )
  expect(screen.getByTestId('provider-maxOutputTokens')).toHaveValue(profile.maxOutputTokens)
  expect(saveProviderSettings).not.toHaveBeenCalled()
  expect(applyProviderSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('provider-new'))
  fireEvent.change(screen.getByTestId('provider-template'), {
    target: { value: 'fixture-template' },
  })
  expect(screen.getByTestId('provider-contextWindowTokens')).toHaveValue(100_000_000)
  expect(screen.getByTestId('provider-maxOutputTokens')).toHaveValue(65_536)
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readProviderTemplates).mockResolvedValue({
    templates: [template],
    supportsAuthenticationPolicy: true,
  })
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/work' },
  ])
  vi.mocked(readProviderSettings).mockResolvedValue({ profiles: [profile], restartRequired: false })
  vi.mocked(saveProviderSettings).mockResolvedValue({ profiles: [profile], restartRequired: true })
})

test('explicit no-auth clears the draft key, disables entry and saves without a fake key', async () => {
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-apiKey'), { target: { value: 'fixture-secret' } })
  fireEvent.change(await screen.findByTestId('provider-authentication'), {
    target: { value: 'none' },
  })
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
  expect(screen.getByTestId('provider-apiKey')).toBeDisabled()
  expect(saveProviderSettings).not.toHaveBeenCalled()
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() =>
    expect(saveProviderSettings).toHaveBeenCalledWith(
      'remote',
      expect.objectContaining({
        authentication: { mode: 'none' },
        apiKey: '',
      })
    )
  )
  expect(applyProviderSettings).not.toHaveBeenCalled()
})

test('local template applies no-auth, clears model and key, and changing format restores API-key mode', async () => {
  vi.mocked(readProviderTemplates).mockResolvedValue({
    supportsAuthenticationPolicy: true,
    templates: [
      {
        ...template,
        id: 'local-openai',
        endpoint: 'http://127.0.0.1:8000/v1',
        authentication: { mode: 'none' },
      },
    ],
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-apiKey'), { target: { value: 'fixture-secret' } })
  fireEvent.change(await screen.findByTestId('provider-template'), {
    target: { value: 'local-openai' },
  })
  expect(screen.getByTestId('provider-endpoint')).toHaveValue('http://127.0.0.1:8000/v1')
  expect(screen.getByTestId('provider-model')).toHaveValue('')
  expect(screen.getByTestId('provider-authentication')).toHaveValue('none')
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
  fireEvent.change(screen.getByTestId('provider-format'), {
    target: { value: 'anthropic_messages' },
  })
  expect(screen.getByTestId('provider-authentication')).toHaveValue('api_key')
  expect(screen.getByTestId('provider-apiKey')).toBeEnabled()
  expect(screen.getByRole('option', { name: '无需认证' })).toBeDisabled()
  expect(saveProviderSettings).not.toHaveBeenCalled()
})

test('rejects an empty model before issuing save RPC even on direct form submission', async () => {
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: '  ' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(saveProviderSettings).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('模型')
  expect(screen.getByTestId('provider-model')).toHaveFocus()
})

test('old servers hide authentication controls and retain manual API-key editing', async () => {
  vi.mocked(readProviderTemplates).mockResolvedValue({ templates: [] })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  expect(screen.queryByTestId('provider-template')).not.toBeInTheDocument()
  expect(screen.queryByTestId('provider-authentication')).not.toBeInTheDocument()
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'edited-model' } })
  expect(saveProviderSettings).not.toHaveBeenCalled()
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() =>
    expect(saveProviderSettings).toHaveBeenCalledWith(
      'remote',
      expect.objectContaining({ model: 'edited-model' })
    )
  )
})

test('template load failure permits manual editing and refresh retries without discarding the draft', async () => {
  vi.mocked(readProviderTemplates).mockRejectedValueOnce(new Error('fixture-secret'))
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  expect(await screen.findByText(/模板加载失败/)).toBeVisible()
  expect(document.body.textContent).not.toContain('fixture-secret')
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'manual-model' } })
  fireEvent.click(screen.getByTestId('provider-refresh'))
  await screen.findByTestId('provider-template')
  expect(screen.getByTestId('provider-model')).toHaveValue('manual-model')
  expect(screen.queryByText(/模板加载失败/)).not.toBeInTheDocument()
  expect(saveProviderSettings).not.toHaveBeenCalled()
})

test('a late template result from a previous target cannot replace the selected target catalog', async () => {
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/work' },
    { id: 'local', label: 'Local', transport: 'local', workspacePath: '/local' },
  ])
  let resolveRemote!: (value: {
    templates: (typeof template)[]
    supportsAuthenticationPolicy: boolean
  }) => void
  vi.mocked(readProviderTemplates).mockImplementation(serverId =>
    serverId === 'remote'
      ? new Promise(resolve => {
          resolveRemote = resolve
        })
      : Promise.resolve({
          templates: [{ ...template, id: 'local-template', displayName: 'Local template' }],
          supportsAuthenticationPolicy: false,
        })
  )
  render(<KCoderProviderSettingsPage />)
  await screen.findByTestId('provider-edit-custom')
  fireEvent.change(screen.getByTestId('provider-target'), { target: { value: 'local' } })
  await screen.findByRole('option', { name: 'Local template' })
  await act(async () =>
    resolveRemote({ templates: [template], supportsAuthenticationPolicy: true })
  )
  expect(screen.queryByRole('option', { name: 'Fixture service' })).not.toBeInTheDocument()
  expect(screen.queryByTestId('provider-authentication')).not.toBeInTheDocument()
  expect(saveProviderSettings).not.toHaveBeenCalled()
})

test('edits the selected target without reading back secrets and requires explicit apply', async () => {
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
  fireEvent.change(screen.getByTestId('provider-apiKey'), { target: { value: 'fixture-secret' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() =>
    expect(saveProviderSettings).toHaveBeenCalledWith(
      'remote',
      expect.objectContaining({ apiKey: 'fixture-secret', id: 'custom' })
    )
  )
  expect(await screen.findByTestId('provider-apply')).toBeVisible()
  expect(screen.getByTestId('provider-pending-apply')).toHaveTextContent('旧配置或旧密钥')
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
  expect(applyProviderSettings).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('fixture-secret')
})

test('uses an in-app plaintext confirmation and releases focus after cancel and save', async () => {
  const nativeConfirm = vi.spyOn(window, 'confirm')
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-endpoint'), {
    target: { value: 'http://10.31.6.8/v1' },
  })
  screen.getByTestId('provider-save').focus()
  fireEvent.submit(screen.getByTestId('provider-form'))
  await screen.findByTestId('provider-plaintext-dialog')
  expect(saveProviderSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('provider-plaintext-dialog-close'))
  expect(screen.queryByTestId('provider-plaintext-dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('provider-save')).toHaveFocus()
  fireEvent.submit(screen.getByTestId('provider-form'))
  fireEvent.click(await screen.findByTestId('provider-plaintext-dialog-confirm'))
  await waitFor(() =>
    expect(saveProviderSettings).toHaveBeenCalledWith(
      'remote',
      expect.objectContaining({ endpoint: 'http://10.31.6.8/v1' })
    )
  )
  await waitFor(() => expect(screen.getByTestId('provider-model')).toBeEnabled())
  screen.getByTestId('provider-model').focus()
  expect(screen.getByTestId('provider-model')).toHaveFocus()
  expect(nativeConfirm).not.toHaveBeenCalled()
  nativeConfirm.mockRestore()
})

test('settings load failure blocks saves, hides unsafe details and recovers on refresh', async () => {
  vi.mocked(readProviderSettings).mockRejectedValueOnce(new Error('fixture-secret'))
  render(<KCoderProviderSettingsPage />)
  expect(await screen.findByRole('alert')).not.toHaveTextContent('fixture-secret')
  expect(screen.getByTestId('provider-save')).toBeDisabled()
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(saveProviderSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('provider-refresh'))
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByTestId('provider-model')).toHaveValue('user-model')
  expect(screen.getByTestId('provider-save')).toBeEnabled()
})

test('a failed validation retains the key for retry and successful retry clears only the key', async () => {
  vi.mocked(saveProviderSettings).mockRejectedValueOnce(
    new Error('[provider_probe_network] fixture-secret')
  )
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'retry-model' } })
  fireEvent.change(screen.getByTestId('provider-apiKey'), { target: { value: 'fixture-secret' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(await screen.findByRole('alert')).not.toHaveTextContent('fixture-secret')
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('fixture-secret')
  expect(screen.queryByTestId('provider-apply')).not.toBeInTheDocument()
  fireEvent.submit(screen.getByTestId('provider-form'))
  await screen.findByTestId('provider-apply')
  expect(saveProviderSettings).toHaveBeenCalledTimes(2)
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
  expect(screen.getByTestId('provider-model')).toHaveValue('retry-model')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(applyProviderSettings).not.toHaveBeenCalled()
})

test('pending validation prevents duplicate saves and preserves fields until success', async () => {
  let finish!: (value: { profiles: (typeof profile)[]; restartRequired: boolean }) => void
  vi.mocked(saveProviderSettings).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-apiKey'), { target: { value: 'fixture-secret' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(screen.getByTestId('provider-save')).toBeDisabled()
  expect(screen.getByTestId('provider-save')).toHaveTextContent('验证')
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('fixture-secret')
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(saveProviderSettings).toHaveBeenCalledTimes(1)
  await act(async () => finish({ profiles: [profile], restartRequired: true }))
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
  expect(screen.getByTestId('provider-apply')).toBeVisible()
})

test('editing a stored no-auth profile does not reinterpret its retained key as active authentication', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    profiles: [{ ...profile, authentication: { mode: 'none' } }],
    restartRequired: false,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  expect(screen.getByTestId('provider-edit-custom')).toHaveTextContent('无需认证')
  expect(await screen.findByTestId('provider-authentication')).toHaveValue('none')
  expect(screen.getByTestId('provider-apiKey')).toBeDisabled()
  expect(screen.getByTestId('provider-apiKey')).toHaveValue('')
})

test('keeps edits on failure and never renders a potentially secret-bearing save error', async () => {
  vi.mocked(saveProviderSettings).mockRejectedValue(new Error('fixture-secret'))
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'changed-model' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(await screen.findByRole('alert')).not.toHaveTextContent('fixture-secret')
  expect(screen.getByTestId('provider-model')).toHaveValue('changed-model')
  expect(applyProviderSettings).not.toHaveBeenCalled()
})

test('shows a safe authentication failure without saving or clearing the edited fields', async () => {
  vi.mocked(saveProviderSettings).mockRejectedValue(
    new Error('[provider_probe_authentication] fixture-secret')
  )
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'GLM-5.3' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  expect(await screen.findByRole('alert')).toHaveTextContent('认证失败')
  expect(screen.getByRole('alert')).not.toHaveTextContent('fixture-secret')
  expect(screen.getByTestId('provider-model')).toHaveValue('GLM-5.3')
  expect(screen.queryByTestId('provider-pending-apply')).not.toBeInTheDocument()
  expect(applyProviderSettings).not.toHaveBeenCalled()
})

test('does not claim applied when an active target refuses restart', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({ profiles: [profile], restartRequired: true })
  vi.mocked(applyProviderSettings).mockResolvedValue({
    restarted: false,
    requiresConfirmation: true,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-apply'))
  expect(await screen.findByRole('alert')).toHaveTextContent('未能应用配置')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(applyProviderSettings).toHaveBeenCalledWith('remote')
})

test('does not claim applied when higher-priority settings still override the saved profile', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({ profiles: [profile], restartRequired: true })
  vi.mocked(applyProviderSettings).mockResolvedValue({
    restarted: true,
    requiresConfirmation: false,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-apply'))
  expect(await screen.findByRole('alert')).toHaveTextContent('配置与生效配置仍不一致')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('supports an optional explicit replacement and keeps secrets unless explicitly selected', async () => {
  const backup = { ...profile, id: 'backup', isDefault: false, canDelete: true }
  vi.mocked(readProviderSettings).mockResolvedValue({
    profiles: [{ ...profile, canDelete: true }, backup],
    restartRequired: false,
  })
  vi.mocked(deleteProviderSettings).mockResolvedValue({
    profiles: [{ ...backup, isDefault: true }],
    restartRequired: true,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-delete-custom'))
  expect(screen.getByTestId('provider-delete-dialog-confirm')).toBeEnabled()
  expect(deleteProviderSettings).not.toHaveBeenCalled()
  fireEvent.change(screen.getByTestId('provider-delete-replacement'), {
    target: { value: 'backup' },
  })
  fireEvent.click(screen.getByTestId('provider-delete-dialog-confirm'))
  await waitFor(() =>
    expect(deleteProviderSettings).toHaveBeenCalledWith('remote', 'custom', {
      replacementProvider: 'backup',
      removeCredentials: false,
    })
  )
  await waitFor(() => expect(screen.queryByTestId('provider-edit-custom')).not.toBeInTheDocument())
  expect(screen.getByTestId('provider-apply')).toBeVisible()
  expect(applyProviderSettings).not.toHaveBeenCalled()
})

test('deletes the last API without a replacement and leaves a usable empty settings page', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    profiles: [{ ...profile, canDelete: true }],
    restartRequired: false,
  })
  vi.mocked(deleteProviderSettings).mockResolvedValue({ profiles: [], restartRequired: true })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-delete-custom'))
  expect(screen.getByTestId('provider-delete-dialog-confirm')).toBeEnabled()
  fireEvent.click(screen.getByTestId('provider-delete-dialog-confirm'))
  await waitFor(() =>
    expect(deleteProviderSettings).toHaveBeenCalledWith('remote', 'custom', {
      removeCredentials: false,
    })
  )
  expect(await screen.findByTestId('provider-new')).toBeEnabled()
  expect(screen.queryByTestId('provider-delete-custom')).not.toBeInTheDocument()
})

test('cancel is non-mutating and credential removal is opt-in for a non-default API', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    profiles: [{ ...profile, canDelete: true, isDefault: false }],
    restartRequired: false,
  })
  vi.mocked(deleteProviderSettings).mockResolvedValue({ profiles: [], restartRequired: true })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-delete-custom'))
  fireEvent.click(screen.getByTestId('provider-delete-dialog-close'))
  expect(deleteProviderSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('provider-delete-custom'))
  fireEvent.click(screen.getByTestId('provider-delete-credentials'))
  fireEvent.click(screen.getByTestId('provider-delete-dialog-confirm'))
  await waitFor(() =>
    expect(deleteProviderSettings).toHaveBeenCalledWith('remote', 'custom', {
      removeCredentials: true,
    })
  )
})

test('never offers deletion for inherited profiles', async () => {
  render(<KCoderProviderSettingsPage />)
  await screen.findByTestId('provider-edit-custom')
  expect(screen.queryByTestId('provider-delete-custom')).not.toBeInTheDocument()
})

test('allows deleting the last default without first creating another API', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    profiles: [{ ...profile, canDelete: true }],
    restartRequired: false,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-delete-custom'))
  expect(screen.getByRole('dialog')).toHaveTextContent('将不再有 API 配置')
  expect(screen.getByTestId('provider-delete-dialog-confirm')).toBeEnabled()
  vi.mocked(deleteProviderSettings).mockResolvedValue({ profiles: [], restartRequired: true })
  fireEvent.click(screen.getByTestId('provider-delete-dialog-confirm'))
  await waitFor(() =>
    expect(deleteProviderSettings).toHaveBeenCalledWith('remote', 'custom', {
      removeCredentials: false,
    })
  )
  await waitFor(() => expect(screen.queryByTestId('provider-edit-custom')).not.toBeInTheDocument())
})

test('preserves the row on failure and does not expose secret-bearing errors', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    profiles: [{ ...profile, canDelete: true, isDefault: false }],
    restartRequired: false,
  })
  vi.mocked(deleteProviderSettings).mockRejectedValue(new Error('fixture-secret'))
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-delete-custom'))
  fireEvent.click(screen.getByTestId('provider-delete-dialog-confirm'))
  expect(await screen.findByRole('alert')).toHaveTextContent('删除失败')
  expect(screen.getByTestId('provider-edit-custom')).toBeVisible()
  expect(document.body.textContent).not.toContain('fixture-secret')
})

test('reports partial credential cleanup without pretending that configuration deletion failed', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    profiles: [{ ...profile, canDelete: true, isDefault: false }],
    restartRequired: false,
  })
  vi.mocked(deleteProviderSettings).mockResolvedValue({
    profiles: [],
    restartRequired: true,
    warning: 'fixture warning',
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-delete-custom'))
  fireEvent.click(screen.getByTestId('provider-delete-dialog-confirm'))
  expect(await screen.findByRole('status')).toHaveTextContent('密钥清理失败')
  expect(screen.queryByTestId('provider-edit-custom')).not.toBeInTheDocument()
  expect(screen.getByTestId('provider-apply')).toBeVisible()
})

test('opens provider settings for the active remote conversation when local is listed first', async () => {
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    { id: 'local', label: 'Windows', runtime: 'kcoder', transport: 'local' },
    { id: 'remote', label: 'SSH', runtime: 'kcoder', transport: 'ssh' },
  ])
  const value = {
    state: {
      ...initialWorkbenchState,
      currentRuntimeTask: {
        deviceId: 'remote',
        taskId: 'remote-task',
        workspacePath: '/remote/project',
      },
    },
  } as WorkbenchContextValue
  render(
    <WorkbenchContext.Provider value={value}>
      <KCoderProviderSettingsPage />
    </WorkbenchContext.Provider>
  )
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledWith('remote'))
  expect(screen.getByTestId('provider-target')).toHaveValue('remote')
  expect(readProviderSettings).not.toHaveBeenCalledWith('local')
})

test('saving reload-capable targets refreshes the model catalog without a restart action', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    profiles: [profile],
    supportsNewSessionReload: true,
    restartRequired: false,
  })
  vi.mocked(saveProviderSettings).mockResolvedValue({
    profiles: [profile],
    supportsNewSessionReload: true,
    restartRequired: false,
  })
  const changed = vi.fn()
  window.addEventListener('wework:local-model-settings-changed', changed)
  try {
    render(<KCoderProviderSettingsPage />)
    fireEvent.click(await screen.findByTestId('provider-edit-custom'))
    fireEvent.submit(screen.getByTestId('provider-form'))
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('status')).toHaveTextContent('新会话')
    expect(screen.queryByTestId('provider-apply')).not.toBeInTheDocument()
    expect(applyProviderSettings).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('wework:local-model-settings-changed', changed)
  }
})

test('extra body rejects non-object JSON, preserves nested parameters and allows clearing', async () => {
  vi.mocked(saveProviderSettings).mockResolvedValue({
    supportsModelExtraBody: true,
    profiles: [profile],
    restartRequired: false,
  })
  vi.mocked(readProviderSettings).mockResolvedValue({
    supportsModelExtraBody: true,
    profiles: [{ ...profile, extraBody: { thinking: { type: 'adaptive' } } }],
    restartRequired: false,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  const editor = screen.getByTestId('provider-extra-body')
  expect(JSON.parse((editor as HTMLTextAreaElement).value)).toEqual({
    thinking: { type: 'adaptive' },
  })
  for (const value of ['[]', 'null', '{invalid']) {
    fireEvent.change(editor, { target: { value } })
    fireEvent.submit(screen.getByTestId('provider-form'))
    expect(saveProviderSettings).not.toHaveBeenCalled()
  }
  fireEvent.change(editor, {
    target: { value: '{"thinking":{"type":"adaptive"},"reasoning_split":true}' },
  })
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() =>
    expect(saveProviderSettings).toHaveBeenCalledWith(
      'remote',
      expect.objectContaining({
        extraBody: { thinking: { type: 'adaptive' }, reasoning_split: true },
      })
    )
  )
  await waitFor(() => expect(screen.getByTestId('provider-save')).toBeEnabled())
  fireEvent.change(editor, { target: { value: '' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() =>
    expect(saveProviderSettings).toHaveBeenLastCalledWith(
      'remote',
      expect.objectContaining({ extraBody: {} })
    )
  )
})

test('deleting the edited API clears its model body from the new form', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    supportsModelExtraBody: true,
    profiles: [{ ...profile, canDelete: true, extraBody: { thinking: { type: 'adaptive' } } }],
    restartRequired: false,
  })
  vi.mocked(deleteProviderSettings).mockResolvedValue({
    supportsModelExtraBody: true,
    profiles: [],
    restartRequired: false,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.click(screen.getByTestId('provider-delete-custom'))
  fireEvent.click(screen.getByTestId('provider-delete-dialog-confirm'))
  await waitFor(() => expect(screen.queryByTestId('provider-edit-custom')).not.toBeInTheDocument())
  expect(screen.getByTestId('provider-extra-body')).toHaveValue('')
})

test('refresh preserves the draft revision until the model is explicitly reopened', async () => {
  const loaded = {
    supportsOptimisticConcurrency: true,
    revision: 'revision-1',
    profiles: [profile],
    restartRequired: false,
  }
  vi.mocked(readProviderSettings).mockResolvedValue(loaded)
  vi.mocked(saveProviderSettings).mockRejectedValue(
    new Error('[provider_probe_changed] stale draft')
  )
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'my-unsaved-model' } })
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() => expect(screen.getByText(/你的草稿已保留/)).toBeInTheDocument())
  expect(screen.getByTestId('provider-model')).toHaveValue('my-unsaved-model')
  expect(saveProviderSettings).toHaveBeenLastCalledWith(
    'remote',
    expect.objectContaining({ expectedRevision: 'revision-1' })
  )
  vi.mocked(readProviderSettings).mockResolvedValue({ ...loaded, revision: 'revision-2' })
  fireEvent.click(screen.getByTestId('provider-refresh'))
  await waitFor(() => expect(screen.getByTestId('provider-save')).toBeEnabled())
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledTimes(2))
  expect(saveProviderSettings).toHaveBeenLastCalledWith(
    'remote',
    expect.objectContaining({ expectedRevision: 'revision-1', model: 'my-unsaved-model' })
  )
  await waitFor(() => expect(screen.getByTestId('provider-save')).toBeEnabled())
  fireEvent.click(screen.getByTestId('provider-edit-custom'))
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledTimes(3))
  expect(saveProviderSettings).toHaveBeenLastCalledWith(
    'remote',
    expect.objectContaining({ expectedRevision: 'revision-2', model: profile.model })
  )
})

test('a successful save binds its own receipt rather than a later list revision', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({
    supportsOptimisticConcurrency: true,
    revision: 'read-1',
    profiles: [profile],
    restartRequired: false,
  })
  vi.mocked(saveProviderSettings).mockResolvedValue({
    supportsOptimisticConcurrency: true,
    revision: 'another-writer-3',
    savedRevision: 'our-save-2',
    profiles: [profile],
    restartRequired: false,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.getByTestId('provider-save')).toBeEnabled())
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() => expect(saveProviderSettings).toHaveBeenCalledTimes(2))
  expect(saveProviderSettings).toHaveBeenLastCalledWith(
    'remote',
    expect.objectContaining({ expectedRevision: 'our-save-2' })
  )
})

test('turn-refresh capability explains the current-turn snapshot and next-turn application', async () => {
  const settings = {
    supportsTurnModelReload: true,
    supportsNewSessionReload: true,
    profiles: [profile],
    restartRequired: false,
  }
  vi.mocked(readProviderSettings).mockResolvedValue(settings)
  vi.mocked(saveProviderSettings).mockResolvedValue(settings)
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  expect(screen.getByTestId('provider-session-reload')).toHaveTextContent('下一轮')
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('当前轮次的模型参数保持不变')
  )
})

test('account target without authenticated identity is not labeled shared', async () => {
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    {
      id: 'remote',
      transport: 'ssh',
      security: { identity: { mode: 'kcoder-account', username: 'requested-name' } },
    },
  ])
  render(<KCoderProviderSettingsPage />)
  await waitFor(() =>
    expect(screen.getByTestId('provider-identity')).toHaveTextContent('尚未登录此目标')
  )
  expect(screen.getByTestId('provider-identity')).not.toHaveTextContent('requested-name')
  expect(screen.getByTestId('provider-identity')).not.toHaveTextContent('共享运行账号')
})

test('compatibility targets explicitly show shared runtime configuration scope', async () => {
  render(<KCoderProviderSettingsPage />)
  await waitFor(() =>
    expect(screen.getByTestId('provider-identity')).toHaveTextContent('共享运行账号')
  )
})

test('file overrides remain visible and saving does not claim the overridden value applied', async () => {
  const sourced = {
    ...profile,
    availableInCurrentConfig: true,
    fileSources: {
      extra_body: ['project'],
      endpoint: ['user'],
      'private-field': ['private-source'],
    },
  }
  vi.mocked(readProviderSettings).mockResolvedValue({
    profiles: [sourced],
    restartRequired: false,
    supportsTurnModelReload: true,
  })
  vi.mocked(saveProviderSettings).mockResolvedValue({
    profiles: [sourced],
    restartRequired: false,
    supportsTurnModelReload: true,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  expect(screen.getByTestId('provider-file-sources')).toHaveTextContent('项目配置')
  expect(screen.getByTestId('provider-file-sources')).not.toHaveTextContent('private')
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('部分字段仍由更高优先级配置覆盖')
  )
  expect(screen.getByRole('status')).not.toHaveTextContent('下一轮自动读取更新')
})

test('models removed by a higher configuration layer are not presented as ready after save', async () => {
  const sourced = { ...profile, availableInCurrentConfig: false }
  vi.mocked(readProviderSettings).mockResolvedValue({ profiles: [sourced], restartRequired: false })
  vi.mocked(saveProviderSettings).mockResolvedValue({
    profiles: [sourced],
    restartRequired: false,
    supportsTurnModelReload: true,
  })
  render(<KCoderProviderSettingsPage />)
  fireEvent.click(await screen.findByTestId('provider-edit-custom'))
  expect(screen.getByTestId('provider-source-unavailable')).toHaveTextContent('不在当前合并配置中')
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('尚不能用于新轮次'))
})

test('initial read and failed retry cannot create a draft without its target revision', async () => {
  let rejectRead!: (error: Error) => void
  vi.mocked(readProviderSettings).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectRead = reject
      })
  )
  render(<KCoderProviderSettingsPage />)
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalled())
  expect(screen.getByTestId('provider-new')).toBeDisabled()
  expect(screen.getByTestId('provider-id')).toBeDisabled()
  expect(screen.getByTestId('provider-save')).toBeDisabled()
  await act(async () => rejectRead(new Error('fixture-read-failed')))
  expect(await screen.findByRole('alert')).toBeVisible()
  expect(screen.getByTestId('provider-new')).toBeDisabled()
  expect(screen.getByTestId('provider-id')).toBeDisabled()
  expect(saveProviderSettings).not.toHaveBeenCalled()
  vi.mocked(readProviderSettings).mockResolvedValueOnce({
    profiles: [],
    restartRequired: false,
    supportsOptimisticConcurrency: true,
    revision: 'loaded-revision',
  })
  fireEvent.click(screen.getByTestId('provider-refresh'))
  await waitFor(() => expect(screen.getByTestId('provider-new')).toBeEnabled())
  fireEvent.click(screen.getByTestId('provider-new'))
  fireEvent.change(screen.getByTestId('provider-id'), { target: { value: 'fresh' } })
  fireEvent.change(screen.getByTestId('provider-model'), { target: { value: 'fresh-model' } })
  fireEvent.change(screen.getByTestId('provider-endpoint'), {
    target: { value: 'https://example.invalid/v1' },
  })
  fireEvent.submit(screen.getByTestId('provider-form'))
  await waitFor(() =>
    expect(saveProviderSettings).toHaveBeenCalledWith(
      'remote',
      expect.objectContaining({ expectedRevision: 'loaded-revision', id: 'fresh' })
    )
  )
})
