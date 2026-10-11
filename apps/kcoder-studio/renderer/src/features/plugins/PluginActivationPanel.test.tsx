import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PluginActivationPanel } from './PluginActivationPanel'
import type { PluginActivationSnapshot } from './pluginLifecycle'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: unknown) =>
      typeof fallback === 'string'
        ? fallback
        : ((fallback as { defaultValue?: string })?.defaultValue ?? _key),
  }),
}))
const initial = {
  generation: 1,
  operationId: 'operation-example',
  phase: 'credentials_required',
  components: [
    { kind: 'mcp', name: 'demo', phase: 'credentials_required', missingNames: ['TOKEN'] },
  ],
}

describe('private plugin credential boundary', () => {
  it('sends only named private fields, clears controls, and does not display backend secret echoes', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const configure = vi.fn().mockRejectedValue(new Error('Bearer private-secret'))
    const { container } = render(
      <PluginActivationPanel
        pluginId="demo@market"
        enabled
        api={{ configurePluginCredentials: configure }}
        initial={initial}
      />
    )
    const field = screen.getByLabelText('TOKEN') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'private-secret' } })
    fireEvent.submit(screen.getByTestId('plugin-private-credentials'))
    expect(field.value).toBe('')
    await waitFor(() =>
      expect(configure).toHaveBeenCalledWith(
        'demo@market',
        expect.any(Object),
        expect.objectContaining({ expectedGeneration: 1, expectedOperationId: 'operation-example' })
      )
    )
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(container.textContent).not.toContain('private-secret')
    expect(storage).not.toHaveBeenCalled()
    storage.mockRestore()
  })
  it('uses target activation facts and states that changes take effect next turn', async () => {
    const read = vi.fn().mockResolvedValue({
      generation: 2,
      phase: 'usable',
      components: [{ kind: 'mcp', name: 'demo', phase: 'usable', toolCount: 2 }],
    })
    const onConfigured = vi.fn()
    const configure = vi
      .fn()
      .mockResolvedValue({ missingNames: [], effectiveFrom: 'next_turn', generation: 2 })
    render(
      <PluginActivationPanel
        pluginId="demo@market"
        enabled
        api={{ configurePluginCredentials: configure, readPluginActivation: read }}
        initial={initial}
        onConfigured={onConfigured}
      />
    )
    fireEvent.change(screen.getByLabelText('TOKEN'), { target: { value: 'test-only' } })
    fireEvent.submit(screen.getByTestId('plugin-private-credentials'))
    await waitFor(() => expect(read).toHaveBeenCalledWith('demo@market'))
    expect(await screen.findByText(/next turn or connection/)).toBeInTheDocument()
    expect(onConfigured).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('plugin-private-credentials')).not.toBeInTheDocument()
  })
  it('does not offer private entry or silently install when the target lacks capability', () => {
    render(<PluginActivationPanel pluginId="demo@market" enabled api={{}} initial={initial} />)
    expect(screen.getByTestId('plugin-activation-check')).toBeDisabled()
    expect(screen.queryByLabelText('TOKEN')).not.toBeInTheDocument()
  })
  it('does not publish stale facts after switching the selected plugin', async () => {
    let resolve!: (value: PluginActivationSnapshot) => void
    const read = vi.fn(
      () =>
        new Promise<PluginActivationSnapshot>(resolveResult => {
          resolve = resolveResult
        })
    )
    const targetApi = { readPluginActivation: read }
    const { rerender } = render(
      <PluginActivationPanel pluginId="first@market" enabled api={targetApi} initial={initial} />
    )
    fireEvent.click(screen.getByTestId('plugin-activation-check'))
    await waitFor(() => expect(read).toHaveBeenCalledWith('first@market'))
    rerender(
      <PluginActivationPanel pluginId="second@market" enabled api={targetApi} initial={initial} />
    )
    resolve({
      generation: 3,
      threadId: 'first-thread',
      phase: 'usable',
      components: [{ kind: 'mcp', name: 'stale-first-tools', phase: 'usable', toolCount: 2 }],
    })
    await waitFor(() => expect(screen.getByTestId('plugin-activation-check')).toBeEnabled())
    expect(screen.queryByText(/stale-first-tools/)).not.toBeInTheDocument()
  })
  it('keeps private entry disabled until the target confirms a source identity', async () => {
    const configure = vi
      .fn()
      .mockResolvedValue({ missingNames: [], effectiveFrom: 'next_turn', generation: 2 })
    const scope = 'a'.repeat(64)
    const unscoped = { ...initial, operationId: undefined }
    const read = vi.fn().mockResolvedValue({ ...unscoped, generation: 2, credentialScope: scope })
    render(
      <PluginActivationPanel
        pluginId="demo@market"
        enabled
        api={{ configurePluginCredentials: configure, readPluginActivation: read }}
        initial={unscoped}
      />
    )
    expect(screen.getByLabelText('TOKEN')).toBeDisabled()
    fireEvent.click(screen.getByTestId('plugin-activation-check'))
    await waitFor(() => expect(screen.getByLabelText('TOKEN')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('TOKEN'), { target: { value: 'test-only' } })
    fireEvent.submit(screen.getByTestId('plugin-private-credentials'))
    await waitFor(() =>
      expect(configure).toHaveBeenCalledWith('demo@market', expect.any(Object), {
        expectedCredentialScope: scope,
      })
    )
  })
  it('carries the original operation CAS and clears the form when that operation changes concurrently', async () => {
    let reject!: (error: Error) => void
    const configure = vi.fn(
      () =>
        new Promise<{ missingNames: string[]; effectiveFrom: 'next_turn'; generation: number }>(
          (_resolve, rejectResult) => {
            reject = rejectResult
          }
        )
    )
    const targetApi = { configurePluginCredentials: configure }
    const { rerender } = render(
      <PluginActivationPanel pluginId="demo@market" enabled api={targetApi} initial={initial} />
    )
    fireEvent.change(screen.getByLabelText('TOKEN'), { target: { value: 'test-only' } })
    fireEvent.submit(screen.getByTestId('plugin-private-credentials'))
    await waitFor(() =>
      expect(configure).toHaveBeenCalledWith('demo@market', expect.any(Object), {
        expectedGeneration: 1,
        expectedOperationId: 'operation-example',
      })
    )
    rerender(
      <PluginActivationPanel
        pluginId="demo@market"
        enabled
        api={targetApi}
        initial={{ ...initial, generation: 2, operationId: 'replacement-operation' }}
      />
    )
    reject(new Error('scope_changed'))
    await waitFor(() => expect((screen.getByLabelText('TOKEN') as HTMLInputElement).value).toBe(''))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(configure).toHaveBeenCalledTimes(1)
  })
})

it('checks the chosen real conversation rather than an unscoped bootstrap', async () => {
  const configured = vi.fn()
  const read = vi.fn().mockResolvedValue({ generation: 1, phase: 'unknown', components: [] })
  const api = {
    readPluginActivation: read,
    listActivationConversations: vi
      .fn()
      .mockResolvedValue([{ taskId: 'owned-task', title: 'Existing work' }]),
    configurePluginCredentials: vi
      .fn()
      .mockResolvedValue({ generation: 1, missingNames: [], effectiveFrom: 'next_turn' }),
  }
  render(
    <PluginActivationPanel
      pluginId="demo@market"
      enabled
      api={api}
      initial={initial}
      onConfigured={configured}
    />
  )
  await screen.findByRole('option', { name: 'Existing work' })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'owned-task' } })
  fireEvent.click(screen.getByTestId('plugin-activation-check'))
  await waitFor(() => expect(read).toHaveBeenCalledWith('demo@market', { taskId: 'owned-task' }))
})

describe('MCP activation repair guidance', () => {
  it.each([
    ['mcp_protocol_failed', 'failed', 'server compatibility'],
    ['mcp_connection_failed', 'failed', 'server command or endpoint'],
    ['mcp_authorization_required', 'authorization_required', 'MCP settings'],
    ['mcp_no_tools', 'mounted', 'server tool list'],
    ['mcp_timeout', 'failed', 'server availability'],
    ['mcp_unavailable', 'failed', 'server configuration'],
  ])('explains %s with a specific next action', (errorCode, phase, hint) => {
    render(
      <PluginActivationPanel
        pluginId="fixture"
        enabled
        api={{}}
        initial={{
          generation: 1,
          threadId: 't',
          phase,
          components: [{ kind: 'mcp', name: 'fixture', phase, toolCount: 0, errorCode }],
        }}
      />
    )
    expect(screen.getByTestId('plugin-activation-mcp-reason')).toHaveTextContent(hint)
    expect(screen.queryByText(errorCode)).not.toBeInTheDocument()
  })
})
