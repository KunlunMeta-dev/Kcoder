import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { openExternalUrl } from '@/lib/external-links'
import { KCoderMcpManagement } from './KCoderMcpManagement'

vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
vi.mock('@/lib/external-links', () => ({ openExternalUrl: vi.fn() }))
let authorization = 'notAuthorized'
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
