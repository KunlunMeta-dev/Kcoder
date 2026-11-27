import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { Activity } from 'react'
import { requestLocalExecutor } from '@/host/localExecutor'
import { openExternalUrl } from '@/lib/external-links'
import { KCoderMcpManagement } from './KCoderMcpManagement'

vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
vi.mock('@/lib/external-links', () => ({ openExternalUrl: vi.fn() }))
let authorization = 'notAuthorized'

test('enables bundled search without asking for an external service URL', async () => {
  let installed = false
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, value) => {
    const request = value as { method: string; params: unknown }
    if (request.method === 'mcp/list') return { servers: installed ? [{ name: 'searxng', transport: 'searxng', authorization: 'notApplicable' }] : [] }
    if (request.method === 'mcp/install') {
      expect(request.params).toEqual({ config: { name: 'searxng', transport: 'searxng' } })
      installed = true
    }
    return {}
  })
  render(<KCoderMcpManagement deviceId="remote" workspacePath="/remote/project" />)
  fireEvent.click(await screen.findByTestId('kcoder-searxng-enable'))
  const toggle = await screen.findByTestId('kcoder-mcp-toggle')
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(screen.queryByTestId('kcoder-searxng-enable')).not.toBeInTheDocument()
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', { deviceId: 'remote', workspacePath: '/remote/project', method: 'mcp/setEnabled', params: { name: 'searxng', enabled: true } })
})

const localTarget = {
  id: 'local',
  label: 'This computer',
  description: '',
  runtime: 'kcoder' as const,
  transport: 'local' as const,
  localMcpPresets: {
    version: 1 as const,
    playwright: { command: 'playwright-mcp', defaultBrowser: 'msedge', outputDirectory: '/private/skill-runtime/playwright-mcp-output' },
  },
}

test('writes the browser automation preset with the chosen installed browser on a local target', async () => {
  let installed = false
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, value) => {
    const request = value as { method: string; params: unknown }
    if (request.method === 'mcp/list') return { servers: installed ? [{ name: 'playwright', transport: 'stdio', authorization: 'notApplicable' }] : [] }
    if (request.method === 'mcp/install') installed = true
    return {}
  })
  render(<KCoderMcpManagement deviceId="local" workspacePath="/work" presetTarget={localTarget} />)
  const browser = await screen.findByTestId('kcoder-playwright-browser')
  expect(browser).toHaveValue('msedge')
  fireEvent.change(browser, { target: { value: 'chrome' } })
  fireEvent.click(screen.getByTestId('kcoder-playwright-enable'))
  await waitFor(() => expect(within(screen.getByTestId('kcoder-playwright-preset')).getByRole('status')).toBeInTheDocument())
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', {
    deviceId: 'local',
    workspacePath: '/work',
    method: 'mcp/install',
    params: {
      config: {
        name: 'playwright',
        transport: 'stdio',
        command: 'playwright-mcp',
        args: ['--browser', 'chrome', '--isolated', '--output-dir', '/private/skill-runtime/playwright-mcp-output', '--output-max-size', '268435456'],
      },
    },
  })
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', { deviceId: 'local', workspacePath: '/work', method: 'mcp/setEnabled', params: { name: 'playwright', enabled: true } })
  expect(screen.queryByTestId('kcoder-playwright-enable')).not.toBeInTheDocument()
})

test('an existing playwright server is shown as configured and is never rewritten', async () => {
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, value) => {
    const request = value as { method: string }
    if (request.method === 'mcp/list') return { servers: [{ name: 'playwright', transport: 'stdio', authorization: 'notApplicable', enabled: false }] }
    return {}
  })
  render(<KCoderMcpManagement deviceId="local" presetTarget={localTarget} />)
  const preset = await screen.findByTestId('kcoder-playwright-preset')
  expect(within(preset).getByRole('status')).toHaveTextContent('playwright')
  expect(screen.queryByTestId('kcoder-playwright-enable')).not.toBeInTheDocument()
  expect(vi.mocked(requestLocalExecutor).mock.calls.map(([, value]) => (value as { method: string }).method)).toEqual(['mcp/list'])
})

test('the browser automation preset is disabled with an explanation outside local same-account targets', async () => {
  vi.mocked(requestLocalExecutor).mockImplementation(async () => ({ servers: [] }))
  const view = render(<KCoderMcpManagement deviceId="remote" presetTarget={{ ...localTarget, id: 'remote', transport: 'ssh', localMcpPresets: undefined }} />)
  expect(await screen.findByTestId('kcoder-playwright-preset-unavailable')).toHaveTextContent(/same-account|同账户/)
  expect(screen.getByTestId('kcoder-playwright-enable')).toBeDisabled()
  view.rerender(<KCoderMcpManagement deviceId="local" presetTarget={{ ...localTarget, localMcpPresets: undefined }} />)
  expect(await screen.findByTestId('kcoder-playwright-preset-unavailable')).toHaveTextContent(/full package|完整版本/)
  expect(screen.getByTestId('kcoder-playwright-enable')).toBeDisabled()
  fireEvent.click(screen.getByTestId('kcoder-playwright-enable'))
  expect(vi.mocked(requestLocalExecutor).mock.calls.some(([, value]) => (value as { method: string }).method === 'mcp/install')).toBe(false)
})

test('toggles a plugin MCP independently, keeps it listed, and reloads the saved state', async () => {
  let enabled = true
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, value) => {
    const request = value as { method: string; params: { enabled: boolean } }
    if (request.method === 'mcp/list') return { servers: [{ name: 'plugin.demo.search', pluginId: 'demo', transport: 'stdio', authorization: 'notApplicable', enabled }] }
    if (request.method === 'mcp/setEnabled') enabled = request.params.enabled
    return {}
  })
  render(<KCoderMcpManagement deviceId="remote" workspacePath="/remote/project" />)
  const toggle = await screen.findByTestId('kcoder-mcp-toggle')
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  expect(screen.getByText('plugin.demo.search')).toBeInTheDocument()
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', { deviceId: 'remote', workspacePath: '/remote/project', method: 'mcp/setEnabled', params: { name: 'plugin.demo.search', pluginId: 'demo', enabled: false } })
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
})

test('failed activation does not pretend that the server was disabled', async () => {
  const original = vi.mocked(requestLocalExecutor).getMockImplementation()!
  vi.mocked(requestLocalExecutor).mockImplementation((method, value) => {
    if ((value as { method: string }).method === 'mcp/setEnabled') return Promise.reject(new Error('settings write failed'))
    return original(method, value)
  })
  render(<KCoderMcpManagement />)
  const toggle = await screen.findByTestId('kcoder-mcp-toggle')
  fireEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveTextContent('settings write failed')
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(toggle).not.toBeDisabled()
})

test('an activation finishing after target navigation cannot overwrite the new target', async () => {
  let finish!: () => void
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, value) => {
    const request = value as { method: string; deviceId: string }
    if (request.method === 'mcp/list') return { servers: [{ name: request.deviceId, transport: 'stdio', authorization: 'notApplicable' }] }
    if (request.method === 'mcp/setEnabled') await new Promise<void>(resolve => { finish = resolve })
    return {}
  })
  const view = render(<KCoderMcpManagement deviceId="alpha" />)
  fireEvent.click(await screen.findByTestId('kcoder-mcp-toggle'))
  view.rerender(<KCoderMcpManagement deviceId="beta" />)
  await screen.findByText('beta')
  await act(async () => { finish() })
  expect(screen.queryByText('alpha')).not.toBeInTheDocument()
  expect(screen.getByTestId('kcoder-mcp-toggle')).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByTestId('kcoder-mcp-toggle')).not.toBeDisabled()
})
beforeEach(() => {
  vi.clearAllMocks()
  authorization = 'notAuthorized'
  vi.mocked(openExternalUrl).mockResolvedValue(true)
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, value) => {
    const params = value as { method: string }
    if (params.method === 'mcp/list')
      return {
        servers: [
          { name: 'Remote MCP', transport: 'http', pluginId: 'demo@market', authorization },
        ],
      }
    if (params.method === 'gateway/mcp/login')
      return { flowId: 'owned-flow', authorizationUrl: 'https://auth.example.test/authorize' }
    if (params.method === 'mcp/logout') authorization = 'notAuthorized'
    return {}
  })
})

test('authorizes on the selected target, handles completion, and signs out', async () => {
  render(<KCoderMcpManagement deviceId="remote" workspacePath="/remote/project" />)
  await screen.findByText('Remote MCP')
  fireEvent.click(screen.getByRole('button', { name: /Authorize|授权登录/ }))
  await waitFor(() =>
    expect(openExternalUrl).toHaveBeenCalledWith('https://auth.example.test/authorize', {
      target: 'system',
    })
  )
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', {
    deviceId: 'remote',
    workspacePath: '/remote/project',
    method: 'gateway/mcp/login',
    params: { server: { name: 'Remote MCP', pluginId: 'demo@market' } },
  })
  await screen.findByRole('button', { name: /Cancel authorization|取消授权/ })
  authorization = 'authorized'
  act(() =>
    window.dispatchEvent(
      new CustomEvent('kcoder:mcp-authorization-changed', {
        detail: { flowId: 'other-flow', status: 'authorized' },
      })
    )
  )
  expect(screen.getByRole('button', { name: /Cancel authorization|取消授权/ })).toBeInTheDocument()
  act(() =>
    window.dispatchEvent(
      new CustomEvent('kcoder:mcp-authorization-changed', {
        detail: { flowId: 'owned-flow', status: 'authorized', deviceId: 'remote' },
      })
    )
  )
  fireEvent.click(await screen.findByRole('button', { name: /Sign out|注销授权/ }))
  await screen.findByRole('button', { name: /Authorize|授权登录/ })
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', {
    deviceId: 'remote',
    workspacePath: '/remote/project',
    method: 'mcp/logout',
    params: { name: 'Remote MCP', pluginId: 'demo@market' },
  })
})

test('leaving the panel cancels pending authorization on the original target', async () => {
  const view = render(<KCoderMcpManagement deviceId="remote" workspacePath="/remote/project" />)
  fireEvent.click(await screen.findByRole('button', { name: /Authorize|授权登录/ }))
  await screen.findByRole('button', { name: /Cancel authorization|取消授权/ })
  view.unmount()
  await waitFor(() =>
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', {
      deviceId: 'remote',
      workspacePath: '/remote/project',
      method: 'mcp/cancel',
      params: { flowId: 'owned-flow' },
    })
  )
})

test('the management refresh event reloads authorization status', async () => {
  render(<KCoderMcpManagement deviceId="remote" workspacePath="/remote/project" />)
  await screen.findByRole('button', { name: /Authorize|授权登录/ })
  authorization = 'authorized'
  act(() => window.dispatchEvent(new Event('kcoder:mcp-refresh')))
  await screen.findByRole('button', { name: /Sign out|注销授权/ })
})

test('browser launch failure remains recoverable and clears after authorization succeeds', async () => {
  vi.mocked(openExternalUrl).mockRejectedValue(new Error('private native IPC diagnostic'))
  render(<KCoderMcpManagement deviceId="remote" workspacePath="/remote/project" />)
  fireEvent.click(await screen.findByRole('button', { name: /Authorize|授权登录/ }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).not.toContain('private native IPC diagnostic')
  expect(screen.getByTestId('kcoder-mcp-open-authorization')).toHaveAttribute(
    'href',
    'https://auth.example.test/authorize'
  )
  authorization = 'authorized'
  act(() =>
    window.dispatchEvent(
      new CustomEvent('kcoder:mcp-authorization-changed', {
        detail: { flowId: 'owned-flow', status: 'authorized' },
      })
    )
  )
  await screen.findByRole('button', { name: /Sign out|注销授权/ })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('an unknown authorization state is labelled, not leaked as a raw i18n key', async () => {
  // The runtime can add states this build has never heard of. Interpolating the
  // value into an i18n key would surface `workbench.mcp_status_...` verbatim.
  authorization = 'someFutureState'
  render(<KCoderMcpManagement deviceId="remote" workspacePath="/remote/project" />)

  const status = await screen.findByRole('status')
  expect(status.textContent ?? '').not.toContain('mcp_status_')
  expect(status.textContent?.trim()).not.toBe('')
})

test('removes only standalone configuration after confirmation on the selected target', async () => {
  let present = true
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, value) => {
    const params = value as { method: string }
    if (params.method === 'mcp/list')
      return {
        servers: present
          ? [{ name: 'Standalone', transport: 'stdio', authorization: 'notApplicable' }]
          : [],
      }
    if (params.method === 'mcp/remove') present = false
    return {}
  })
  render(<KCoderMcpManagement deviceId="remote" workspacePath="/remote/project" />)
  await screen.findByText('Standalone')
  fireEvent.click(screen.getByTestId('kcoder-mcp-remove'))
  const dialog = screen.getByRole('alertdialog')
  expect(dialog).toHaveTextContent('Standalone')
  expect(requestLocalExecutor).not.toHaveBeenCalledWith(
    'runtime.plugins.request',
    expect.objectContaining({ method: 'mcp/remove' })
  )
  fireEvent.click(within(dialog).getByRole('button', { name: /^Remove$|^删除$/ }))
  await waitFor(() => expect(screen.queryByText('Standalone')).not.toBeInTheDocument())
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', {
    deviceId: 'remote',
    workspacePath: '/remote/project',
    method: 'mcp/remove',
    params: { name: 'Standalone' },
  })
})

test('connection failure stays distinct from saved authorization and unknown states stay readable', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue({
    servers: [
      {
        name: 'Authorized but offline',
        transport: 'http',
        authorization: 'authorized',
        lastConnectionAttempt: 'unavailable',
      },
      {
        name: 'Future connection state',
        transport: 'stdio',
        authorization: 'notApplicable',
        lastConnectionAttempt: 'future-state',
      },
    ],
  })
  render(<KCoderMcpManagement deviceId="remote" />)
  await screen.findByText('Authorized but offline')
  const labels = screen.getAllByTestId('kcoder-mcp-connection-status').map(node => node.textContent)
  expect(labels[0]).toMatch(/上次连接失败|Last connection attempt failed/)
  expect(labels[1]).toMatch(/尚无此配置|No connection result/)
  expect(labels.join(' ')).not.toContain('workbench.')
  expect(screen.getByRole('button', { name: /注销授权|Sign out/ })).toBeInTheDocument()
})


test('MCP settings announce the selected target after a confirmed change', async () => {
  const changed = vi.fn()
  window.addEventListener('kcoder:tools-catalog-invalidated', changed)
  const page = render(<KCoderMcpManagement deviceId="mcp-target" />)
  try {
    fireEvent.click(await screen.findByTestId('kcoder-mcp-toggle'))
    await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ detail: { deviceId: 'mcp-target' } })
    ))
  } finally { page.unmount(); window.removeEventListener('kcoder:tools-catalog-invalidated', changed) }
})


test.each(['locale', 'inventory-callback'] as const)(
  '%s presentation changes preserve the current authorization flow and directory read lifetime', async change => {
    const originalLanguage = i18n.language
    const firstCount = vi.fn(), currentCount = vi.fn()
    const view = render(<KCoderMcpManagement deviceId="remote" workspacePath="/remote/project" onInventoryCount={firstCount} />)
    try {
      fireEvent.click(await screen.findByRole('button', { name: /Authorize|授权登录/ }))
      const cancel = await screen.findByRole('button', { name: /Cancel authorization|取消授权/ })
      await waitFor(() => expect(cancel).not.toBeDisabled())
      const calls = vi.mocked(requestLocalExecutor).mock.calls.length
      if (change === 'locale') await act(() => i18n.changeLanguage(originalLanguage.startsWith('en') ? 'zh-CN' : 'en'))
      else view.rerender(<KCoderMcpManagement deviceId="remote" workspacePath="/remote/project" onInventoryCount={currentCount} />)
      expect(vi.mocked(requestLocalExecutor).mock.calls).toHaveLength(calls)
      expect(screen.getByRole('button', { name: /Cancel authorization|取消授权/ })).toBeInTheDocument()
      const originalCount = firstCount.mock.calls.length
      act(() => window.dispatchEvent(new CustomEvent('kcoder:mcp-authorization-changed', {
        detail: { flowId: 'owned-flow', status: 'failed' },
      })))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(i18n.t('common:workbench.mcp_authorization_failed'))
      if (change === 'inventory-callback') {
        await waitFor(() => expect(currentCount).toHaveBeenCalledWith(1))
        expect(firstCount).toHaveBeenCalledTimes(originalCount)
      }
      expect(vi.mocked(requestLocalExecutor).mock.calls.filter(([, value]) => (value as { method: string }).method === 'mcp/cancel'))
        .toHaveLength(0)
    } finally { view.unmount(); await act(() => i18n.changeLanguage(originalLanguage)) }
  }
)


test.each(['success', 'failure'] as const)('an older explicit refresh %s cannot replace the current MCP result', async outcome => {
  const view = render(<KCoderMcpManagement deviceId="remote" />)
  await screen.findByText('Remote MCP')
  let release!: (value: unknown) => void, reject!: (error: Error) => void
  const pending = new Promise((resolve, fail) => { release = resolve; reject = fail })
  vi.mocked(requestLocalExecutor).mockImplementationOnce(() => pending)
    .mockResolvedValueOnce({ servers: [{ name: 'Current result', transport: 'http', authorization: 'notAuthorized' }] })
  try {
    act(() => window.dispatchEvent(new Event('kcoder:mcp-refresh')))
    act(() => window.dispatchEvent(new Event('kcoder:mcp-refresh')))
    await screen.findByText('Current result')
    await act(async () => {
      if (outcome === 'success') release({ servers: [{ name: 'Old result', transport: 'http', authorization: 'notAuthorized' }] })
      else reject(new Error('old directory failed'))
    })
    expect(screen.getByText('Current result')).toBeVisible()
    expect(screen.queryByText('Old result')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  } finally { release({ servers: [] }); view.unmount() }
})

test('an authorization reply after retained-page reentry cancels only its old flow and preserves the new one', async () => {
  let release!: (value: unknown) => void
  const pending = new Promise(resolve => { release = resolve })
  const original = vi.mocked(requestLocalExecutor).getMockImplementation()!
  let first = true
  vi.mocked(requestLocalExecutor).mockImplementation((method, value) => {
    if ((value as { method: string }).method === 'gateway/mcp/login' && first) { first = false; return pending }
    return original(method, value)
  })
  const tree = (visible: boolean) => <Activity mode={visible ? 'visible' : 'hidden'}><KCoderMcpManagement deviceId="remote" /></Activity>
  const view = render(tree(true))
  try {
    fireEvent.click(await screen.findByRole('button', { name: /Authorize|授权登录/ }))
    view.rerender(tree(false)); view.rerender(tree(true))
    const authorize = await screen.findByRole('button', { name: /Authorize|授权登录/ })
    await waitFor(() => expect(authorize).not.toBeDisabled())
    fireEvent.click(authorize)
    const cancel = await screen.findByRole('button', { name: /Cancel authorization|取消授权/ })
    await waitFor(() => expect(cancel).not.toBeDisabled())
    await act(async () => { release({ flowId: 'old-flow', authorizationUrl: 'https://auth.example.test/old' }) })
    expect(openExternalUrl).toHaveBeenCalledTimes(1)
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.plugins.request', {
      deviceId: 'remote', workspacePath: undefined, method: 'mcp/cancel', params: { flowId: 'old-flow' },
    })
    expect(screen.getByRole('button', { name: /Cancel authorization|取消授权/ })).toBeInTheDocument()
    expect(screen.getByTestId('kcoder-mcp-open-authorization')).toHaveAttribute('href', 'https://auth.example.test/authorize')
  } finally { release({ flowId: 'old-flow', authorizationUrl: 'https://auth.example.test/old' }); view.unmount() }
})

test('a preset install accepted after page reentry cannot automatically issue its old enable step', async () => {
  let release!: (value: unknown) => void
  const pending = new Promise(resolve => { release = resolve })
  vi.mocked(requestLocalExecutor).mockImplementation(async (_method, value) => {
    const method = (value as { method: string }).method
    if (method === 'mcp/list') return { servers: [] }
    if (method === 'mcp/install') return pending
    return {}
  })
  const tree = (visible: boolean) => <Activity mode={visible ? 'visible' : 'hidden'}><KCoderMcpManagement deviceId="remote" /></Activity>
  const view = render(tree(true))
  try {
    fireEvent.click(await screen.findByTestId('kcoder-searxng-enable'))
    view.rerender(tree(false)); view.rerender(tree(true))
    await act(async () => { release({}) })
    expect(vi.mocked(requestLocalExecutor).mock.calls.filter(([, value]) => (value as { method: string }).method === 'mcp/setEnabled'))
      .toHaveLength(0)
    expect(screen.getByTestId('kcoder-searxng-enable')).not.toBeDisabled()
  } finally { release({}); view.unmount() }
})

test('a failed latest refresh does not authorize an older list to publish', async () => {
  const view = render(<KCoderMcpManagement deviceId="remote" />)
  await screen.findByText('Remote MCP')
  let release!: (value: unknown) => void
  const pending = new Promise(resolve => { release = resolve })
  vi.mocked(requestLocalExecutor).mockImplementationOnce(() => pending)
    .mockRejectedValueOnce(new Error('current directory failed'))
  try {
    act(() => window.dispatchEvent(new Event('kcoder:mcp-refresh')))
    act(() => window.dispatchEvent(new Event('kcoder:mcp-refresh')))
    expect(await screen.findByRole('alert')).toHaveTextContent('current directory failed')
    await act(async () => { release({ servers: [{ name: 'Old result', transport: 'http', authorization: 'notAuthorized' }] }) })
    expect(screen.getByRole('alert')).toHaveTextContent('current directory failed')
    expect(screen.getByText('Remote MCP')).toBeInTheDocument()
    expect(screen.queryByText('Old result')).not.toBeInTheDocument()
  } finally { release({ servers: [] }); view.unmount() }
})

test('an old cancel receipt after retained-page reentry cannot remove the new flow', async () => {
  const original = vi.mocked(requestLocalExecutor).getMockImplementation()!
  let release!: (value: unknown) => void, cancels = 0, logins = 0
  const pending = new Promise(resolve => { release = resolve })
  vi.mocked(requestLocalExecutor).mockImplementation((method, value) => {
    const request = value as { method: string }
    if (request.method === 'gateway/mcp/login') return Promise.resolve({
      flowId: ++logins === 1 ? 'old-flow' : 'new-flow', authorizationUrl: `https://auth.example.test/${logins}`,
    })
    if (request.method === 'mcp/cancel' && ++cancels === 1) return pending
    return original(method, value)
  })
  const tree = (visible: boolean) => <Activity mode={visible ? 'visible' : 'hidden'}><KCoderMcpManagement deviceId="remote" /></Activity>
  const view = render(tree(true))
  try {
    fireEvent.click(await screen.findByRole('button', { name: /Authorize|授权登录/ }))
    const cancel = await screen.findByRole('button', { name: /Cancel authorization|取消授权/ })
    await waitFor(() => expect(cancel).not.toBeDisabled())
    fireEvent.click(cancel)
    view.rerender(tree(false)); view.rerender(tree(true))
    const authorize = await screen.findByRole('button', { name: /Authorize|授权登录/ })
    await waitFor(() => expect(authorize).not.toBeDisabled())
    fireEvent.click(authorize)
    const newCancel = await screen.findByRole('button', { name: /Cancel authorization|取消授权/ })
    await waitFor(() => expect(newCancel).not.toBeDisabled())
    await act(async () => { release({}) })
    expect(screen.getByRole('button', { name: /Cancel authorization|取消授权/ })).toBeInTheDocument()
    expect(screen.getByTestId('kcoder-mcp-open-authorization')).toHaveAttribute('href', 'https://auth.example.test/2')
  } finally { release({}); view.unmount() }
})
