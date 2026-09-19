import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import {
  fetchGatewayServersWithHealth,
  GatewayRpcError,
  removeGatewayServer,
  saveGatewayServer,
  testGatewayServer,
  type GatewayServer,
} from '@/kcoder/gatewayRpc'
import { KCoderServersSettingsPage } from '../KCoderServersSettingsPage'

vi.mock('@/kcoder/gatewayRpc', async importOriginal => {
  const actual = await importOriginal<typeof import('@/kcoder/gatewayRpc')>()
  return {
    ...actual,
    fetchGatewayServersWithHealth: vi.fn(),
    removeGatewayServer: vi.fn(),
    saveGatewayServer: vi.fn(),
    testGatewayServer: vi.fn(),
  }
})

const configuredServers: GatewayServer[] = [
  {
    id: 'local',
    label: '当前虚拟机',
    description: '本机',
    runtime: 'kcoder',
    transport: 'local',
    status: 'online',
    latencyMs: 8,
  },
  {
    id: 'gpu-01',
    label: 'GPU 服务器',
    description: 'SSH',
    runtime: 'kcoder',
    transport: 'ssh',
    host: '100.64.0.21',
    status: 'offline',
    latencyMs: 10003,
    error: 'Connection timed out',
  },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function renderLoaded() {
  const user = userEvent.setup()
  render(<KCoderServersSettingsPage />)
  await screen.findByText('GPU 服务器')
  return user
}

async function openValidCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('runtime-target-add'))
  await user.type(screen.getByTestId('runtime-target-label'), '构建机')
  await user.type(screen.getByTestId('runtime-target-id'), 'build-01')
  await user.type(screen.getByTestId('runtime-target-host'), '100.64.0.22')
}

describe('KCoderServersSettingsPage', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage('zh-CN')
    vi.mocked(fetchGatewayServersWithHealth).mockResolvedValue(configuredServers)
    vi.mocked(saveGatewayServer).mockImplementation(async server => ({
      ...server,
      status: 'unknown',
    }))
    vi.mocked(testGatewayServer).mockResolvedValue({ ok: true, protocolVersion: '2026-07-27' })
    vi.mocked(removeGatewayServer).mockResolvedValue()
  })

  afterEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  test('shows configuration, health, and a compact localized target list', async () => {
    await renderLoaded()

    expect(screen.getByRole('heading', { name: '运行目标' })).toBeInTheDocument()
    expect(screen.getByText('离线 · 10003 ms')).toBeInTheDocument()
    expect(screen.getByText('Connection timed out')).toBeInTheDocument()
    expect(screen.queryByText('KCoder')).not.toBeInTheDocument()
  })

  test('blocks a duplicate id in create mode instead of overwriting the existing target', async () => {
    const user = await renderLoaded()
    await user.click(screen.getByTestId('runtime-target-add'))
    await user.type(screen.getByTestId('runtime-target-label'), '重复目标')
    await user.type(screen.getByTestId('runtime-target-id'), 'gpu-01')
    await user.type(screen.getByTestId('runtime-target-host'), '100.64.0.22')
    await user.click(screen.getByTestId('runtime-target-save'))

    expect(await screen.findByText('此运行目标 ID 已存在')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-target-id')).toHaveFocus()
    expect(saveGatewayServer).not.toHaveBeenCalled()
  })

  test('keeps edit identity fixed to originalId and saves an edited target once', async () => {
    const user = await renderLoaded()
    await user.click(screen.getByTestId('runtime-target-edit-gpu-01'))

    expect(screen.getByTestId('runtime-target-id')).toBeDisabled()
    expect(screen.getByTestId('runtime-target-id')).toHaveValue('gpu-01')
    await user.clear(screen.getByTestId('runtime-target-label'))
    await user.type(screen.getByTestId('runtime-target-label'), 'GPU 编辑后')
    await user.click(screen.getByTestId('runtime-target-save'))

    await waitFor(() => expect(saveGatewayServer).toHaveBeenCalledTimes(1))
    expect(saveGatewayServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gpu-01',
        label: 'GPU 编辑后',
      })
    )
  })

  test('applies a confirmed dirty switch to the selected target', async () => {
    const user = await renderLoaded()
    await openValidCreate(user)
    await user.click(screen.getByTestId('runtime-target-edit-gpu-01'))
    const dialog = await screen.findByRole('dialog', { name: '放弃未保存的修改？' })
    await user.click(within(dialog).getByRole('button', { name: '放弃修改' }))

    expect(screen.getByTestId('runtime-target-id')).toHaveValue('gpu-01')
    expect(screen.getByTestId('runtime-target-label')).toHaveValue('GPU 服务器')
  })

  test.each([
    ['close', 'runtime-target-close'],
    ['add', 'runtime-target-add'],
    ['switch', 'runtime-target-edit-gpu-01'],
  ])('confirms dirty %s navigation and preserves values when cancelled', async (_, testId) => {
    const user = await renderLoaded()
    await openValidCreate(user)
    await user.click(screen.getByTestId(testId))

    const dialog = await screen.findByRole('dialog', { name: '放弃未保存的修改？' })
    await user.click(within(dialog).getByRole('button', { name: '继续编辑' }))
    expect(screen.getByTestId('runtime-target-label')).toHaveValue('构建机')
    expect(screen.getByTestId(testId)).toHaveFocus()
  })

  test('ignores a deferred connection result after the draft revision changes', async () => {
    const pending = deferred<Awaited<ReturnType<typeof testGatewayServer>>>()
    vi.mocked(testGatewayServer).mockReturnValue(pending.promise)
    const user = await renderLoaded()
    await openValidCreate(user)
    await user.click(screen.getByTestId('runtime-target-test'))
    await user.type(screen.getByTestId('runtime-target-label'), ' 新版本')
    pending.resolve({ ok: true, protocolVersion: 'stale-version' })

    await waitFor(() => expect(testGatewayServer).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/stale-version/)).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-target-label')).toHaveValue('构建机 新版本')
  })

  test('does not close a newer draft revision when a deferred save returns', async () => {
    const pending = deferred<GatewayServer>()
    vi.mocked(saveGatewayServer).mockReturnValue(pending.promise)
    const user = await renderLoaded()
    await openValidCreate(user)
    await user.click(screen.getByTestId('runtime-target-save'))
    await user.type(screen.getByTestId('runtime-target-label'), ' 新草稿')
    pending.resolve({
      id: 'build-01',
      label: '构建机',
      description: 'SSH KCoder app-server',
      runtime: 'kcoder',
      transport: 'ssh',
      host: '100.64.0.22',
    })

    await waitFor(() => expect(saveGatewayServer).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('runtime-target-label')).toHaveValue('构建机 新草稿')
    expect(screen.getByTestId('runtime-target-form')).toBeInTheDocument()
  })

  test('validates every required and formatted field inline, preserving values and focusing the first error', async () => {
    const user = await renderLoaded()
    await user.click(screen.getByTestId('runtime-target-add'))
    await user.type(screen.getByTestId('runtime-target-id'), 'bad id!')
    await user.click(screen.getByTestId('runtime-target-save'))

    expect(screen.getByText('请输入名称')).toBeInTheDocument()
    expect(screen.getByText(/只能包含字母/)).toBeInTheDocument()
    expect(screen.getByText('请输入 SSH 主机')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-target-label')).toHaveFocus()
    expect(screen.getByTestId('runtime-target-id')).toHaveValue('bad id!')
  })

  test.each(['0', '65536', '22.5', 'abc'])('rejects invalid SSH port %s', async value => {
    const user = await renderLoaded()
    await openValidCreate(user)
    await user.click(screen.getByTestId('runtime-target-advanced-toggle'))
    fireEvent.change(screen.getByTestId('runtime-target-port'), { target: { value } })
    await user.click(screen.getByTestId('runtime-target-save'))

    expect(await screen.findByText('端口必须是 1 到 65535 之间的整数')).toBeInTheDocument()
    expect(saveGatewayServer).not.toHaveBeenCalled()
  })

  test('validates advanced command and path fields and focuses the first advanced error', async () => {
    const user = await renderLoaded()
    await openValidCreate(user)
    await user.click(screen.getByTestId('runtime-target-advanced-toggle'))
    await user.clear(screen.getByTestId('runtime-target-command'))
    await user.type(screen.getByTestId('runtime-target-settings-file'), 'relative.json')
    await user.click(screen.getByTestId('runtime-target-save'))

    expect(await screen.findByText('请输入 app-server 命令')).toBeInTheDocument()
    expect(screen.getByText('Settings 文件必须是绝对路径')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-target-command')).toHaveFocus()
  })

  test('clears stale SSH-only values when switching to a local target', async () => {
    const user = await renderLoaded()
    await openValidCreate(user)
    await user.click(screen.getByTestId('runtime-target-advanced-toggle'))
    await user.type(screen.getByTestId('runtime-target-user'), 'devuser')
    await user.type(screen.getByTestId('runtime-target-port'), '2222')
    await user.click(screen.getByTestId('runtime-target-accept-host-key'))
    await user.selectOptions(screen.getByTestId('runtime-target-transport'), 'local')
    await user.click(screen.getByTestId('runtime-target-save'))

    await waitFor(() => expect(saveGatewayServer).toHaveBeenCalledTimes(1))
    expect(saveGatewayServer).toHaveBeenCalledWith(
      expect.not.objectContaining({
        host: expect.anything(),
        user: expect.anything(),
        port: expect.anything(),
        acceptNewHostKey: expect.anything(),
      })
    )
  })

  test('submits once with Enter and blocks duplicate submission while pending', async () => {
    const pending = deferred<GatewayServer>()
    vi.mocked(saveGatewayServer).mockReturnValue(pending.promise)
    const user = await renderLoaded()
    await openValidCreate(user)
    await user.type(screen.getByTestId('runtime-target-host'), '{Enter}')
    fireEvent.submit(screen.getByTestId('runtime-target-form'))

    expect(saveGatewayServer).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('runtime-target-save')).toBeDisabled()
    pending.resolve({
      id: 'build-01',
      label: '构建机',
      description: 'SSH KCoder app-server',
      runtime: 'kcoder',
      transport: 'ssh',
      host: '100.64.0.22',
      status: 'unknown',
    })
    await waitFor(() => expect(screen.queryByTestId('runtime-target-form')).not.toBeInTheDocument())
  })

  test('keeps advanced fields out of the interaction tree until expanded and preserves them when collapsed', async () => {
    const user = await renderLoaded()
    await openValidCreate(user)
    expect(screen.queryByTestId('runtime-target-command')).not.toBeInTheDocument()

    const toggle = screen.getByTestId('runtime-target-advanced-toggle')
    toggle.focus()
    await user.keyboard('{Enter}')
    await user.clear(screen.getByTestId('runtime-target-command'))
    await user.type(screen.getByTestId('runtime-target-command'), '/opt/kcoder')
    await user.click(toggle)
    expect(screen.queryByTestId('runtime-target-command')).not.toBeInTheDocument()
    await user.click(toggle)
    expect(screen.getByTestId('runtime-target-command')).toHaveValue('/opt/kcoder')
  })

  test('requires an explicit danger confirmation before enabling Chromium no-sandbox', async () => {
    const user = await renderLoaded()
    await openValidCreate(user)
    await user.click(screen.getByTestId('runtime-target-advanced-toggle'))
    await user.click(screen.getByTestId('runtime-target-no-sandbox'))

    const dialog = await screen.findByRole('dialog', { name: '关闭 Chromium 沙箱？' })
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.getByTestId('runtime-target-no-sandbox')).not.toBeChecked()
    await user.click(screen.getByTestId('runtime-target-no-sandbox'))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '我了解风险，继续' })
    )
    expect(screen.getByTestId('runtime-target-no-sandbox')).toBeChecked()
    expect(screen.getByRole('alert')).toHaveTextContent('Chromium 沙箱已关闭')
    await user.click(screen.getByTestId('runtime-target-save'))
    await waitFor(() =>
      expect(saveGatewayServer).toHaveBeenCalledWith(
        expect.objectContaining({ chromiumNoSandbox: true })
      )
    )
  })

  test('shows the no-sandbox warning for an existing target and allows turning it off without confirmation', async () => {
    vi.mocked(fetchGatewayServersWithHealth).mockResolvedValue([
      configuredServers[0],
      { ...configuredServers[1], chromiumNoSandbox: true },
    ])
    const user = await renderLoaded()
    await user.click(screen.getByTestId('runtime-target-edit-gpu-01'))

    expect(screen.getByRole('alert')).toHaveTextContent('Chromium 沙箱已关闭')
    await user.click(screen.getByTestId('runtime-target-advanced-toggle'))
    await user.click(screen.getByTestId('runtime-target-no-sandbox'))
    expect(screen.queryByRole('dialog', { name: '关闭 Chromium 沙箱？' })).not.toBeInTheDocument()
    await user.click(screen.getByTestId('runtime-target-save'))
    await waitFor(() => expect(saveGatewayServer).toHaveBeenCalledTimes(1))
    expect(saveGatewayServer).toHaveBeenCalledWith(
      expect.not.objectContaining({ chromiumNoSandbox: true })
    )
  })

  test('deletes only the confirmed row once and keeps a failed target with a nearby retryable error', async () => {
    const pending = deferred<void>()
    vi.mocked(removeGatewayServer).mockReturnValueOnce(pending.promise)
    const user = await renderLoaded()
    await user.click(screen.getByTestId('runtime-target-delete-gpu-01'))
    const dialog = await screen.findByRole('dialog', { name: '删除“GPU 服务器”？' })
    await user.click(within(dialog).getByRole('button', { name: '删除运行目标' }))
    await user.click(within(dialog).getByRole('button', { name: '删除运行目标' }))
    expect(removeGatewayServer).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('runtime-target-delete-gpu-01')).toBeDisabled()
    pending.reject(new Error('disk is read-only'))

    expect(await screen.findByText('disk is read-only')).toBeInTheDocument()
    expect(screen.getByText('GPU 服务器')).toBeInTheDocument()
  })

  test('restores delete focus on cancel and emits one registry event after success', async () => {
    const eventListener = vi.fn()
    window.addEventListener('kcoder:servers-changed', eventListener)
    const user = await renderLoaded()
    const trigger = screen.getByTestId('runtime-target-delete-gpu-01')
    await user.click(trigger)
    await user.click(
      within(await screen.findByRole('dialog', { name: '删除“GPU 服务器”？' })).getByRole(
        'button',
        { name: '取消' }
      )
    )
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    await user.click(
      within(await screen.findByRole('dialog', { name: '删除“GPU 服务器”？' })).getByRole(
        'button',
        { name: '删除运行目标' }
      )
    )

    await waitFor(() => expect(screen.queryByText('GPU 服务器')).not.toBeInTheDocument())
    expect(eventListener).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('runtime-target-add')).toHaveFocus()
    window.removeEventListener('kcoder:servers-changed', eventListener)
  })

  test('shows unknown and unavailable health without misreporting targets as offline and retries loading', async () => {
    vi.mocked(fetchGatewayServersWithHealth)
      .mockRejectedValueOnce(new Error('gateway timeout'))
      .mockResolvedValueOnce([
        { ...configuredServers[0], status: 'unknown' },
        {
          ...configuredServers[1],
          status: 'unavailable',
          healthError: 'status timeout',
          error: undefined,
        },
      ])
    const user = userEvent.setup()
    render(<KCoderServersSettingsPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取运行目标')
    await user.click(screen.getByTestId('runtime-target-load-retry'))

    expect(await screen.findByText('状态未知')).toBeInTheDocument()
    expect(screen.getByText('状态暂不可用')).toBeInTheDocument()
    expect(screen.queryByText('离线')).not.toBeInTheDocument()
  })

  test('renders an explicit empty state', async () => {
    vi.mocked(fetchGatewayServersWithHealth).mockResolvedValue([])
    render(<KCoderServersSettingsPage />)
    expect(await screen.findByText('还没有运行目标')).toBeInTheDocument()
  })

  test('switches all accessible copy to English without leaking hard-coded Chinese', async () => {
    await i18n.changeLanguage('en')
    render(<KCoderServersSettingsPage />)

    expect(await screen.findByRole('heading', { name: 'Runtime targets' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add runtime target' })).toBeInTheDocument()
    expect(screen.queryByText('运行目标')).not.toBeInTheDocument()
  })

  test('localizes a structured gateway HTTP error and keeps the technical status actionable', async () => {
    await i18n.changeLanguage('en')
    vi.mocked(fetchGatewayServersWithHealth).mockRejectedValue(
      new GatewayRpcError('读取服务器列表失败（HTTP 503）', 503, undefined, 'list-targets', 'http')
    )
    render(<KCoderServersSettingsPage />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Unable to load runtime targets')
    expect(alert).toHaveTextContent('The gateway returned HTTP 503')
    expect(alert).not.toHaveTextContent('读取服务器列表失败')
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
