import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import {
  deleteSshConnection,
  listSshConnections,
  saveSshConnection,
  type SshConnectionProfile,
} from '@/kcoder/sshTerminal'
import { SshConnectionsSettingsPage } from '../SshConnectionsSettingsPage'

vi.mock('@/kcoder/sshTerminal', () => ({
  deleteSshConnection: vi.fn(),
  listSshConnections: vi.fn(),
  saveSshConnection: vi.fn(),
}))

const profile: SshConnectionProfile = {
  id: 'build',
  label: '构建主机',
  host: 'build.example.test',
  port: 22,
  username: 'dev',
  authMethod: 'password',
}

async function loaded() {
  render(<SshConnectionsSettingsPage />)
  await screen.findByText('构建主机')
  return userEvent.setup()
}

async function createValid(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('ssh-connection-add'))
  await user.type(screen.getByLabelText('连接名称'), 'Build')
  await user.type(screen.getByLabelText('主机名或 IP 地址'), 'build2.example.test')
  await user.type(screen.getByLabelText('用户名'), 'dev')
}

// Mock only the Gateway persistence boundary; these cases do not involve model behavior.
describe('SshConnectionsSettingsPage', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage('zh-CN')
    vi.mocked(listSshConnections).mockResolvedValue([profile])
    vi.mocked(saveSshConnection).mockImplementation(async value => value)
    vi.mocked(deleteSshConnection).mockResolvedValue()
  })

  afterEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  test('loads a separate terminal connection list and explains the runtime boundary', async () => {
    await loaded()
    expect(screen.getByRole('heading', { name: 'SSH 连接' })).toBeInTheDocument()
    expect(screen.getByText(/不会改变智能体的运行目标/)).toBeInTheDocument()
    expect(screen.getByText('dev@build.example.test:22 · 密码')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-target-add')).not.toBeInTheDocument()
  })

  test('updates and clears passwords without receiving plaintext from the server', async () => {
    vi.mocked(listSshConnections).mockResolvedValue([{ ...profile, passwordSaved: true }])
    vi.mocked(saveSshConnection).mockResolvedValue({ ...profile, passwordSaved: true })
    const user = await loaded()
    await user.click(screen.getByTestId('ssh-connection-edit-build'))
    expect(screen.getByTestId('ssh-connection-password')).toHaveValue('')
    await user.type(screen.getByTestId('ssh-connection-password'), 'new-secret')
    await user.click(screen.getByTestId('ssh-connection-save'))
    await screen.findByText('SSH 连接已保存。')
    expect(saveSshConnection).toHaveBeenLastCalledWith({ ...profile, password: 'new-secret' })
    await user.click(screen.getByTestId('ssh-connection-edit-build'))
    expect(screen.getByTestId('ssh-connection-password')).toHaveValue('')
    await user.click(screen.getByTestId('ssh-connection-clear-password'))
    await user.click(screen.getByTestId('ssh-connection-save'))
    await screen.findByText('SSH 连接已保存。')
    expect(saveSshConnection).toHaveBeenLastCalledWith({ ...profile, password: null })
  })

  test('toggles password visibility with the registered selector without losing input', async () => {
    const user = await loaded()
    await user.click(screen.getByTestId('ssh-connection-add'))
    const password = screen.getByTestId('ssh-connection-password')
    const toggle = screen.getByTestId('ssh-connection-password-toggle')
    expect(password).toHaveAttribute('type', 'password')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAttribute('aria-label', '显示密码')
    await user.type(password, 'sec')
    await user.click(toggle)
    expect(password).toHaveAttribute('type', 'text')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('aria-label', '隐藏密码')
    expect(password).toHaveValue('sec')
    await user.click(toggle)
    expect(password).toHaveAttribute('type', 'password')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(password).toHaveValue('sec')
  })

  test('creates a connection with a unique friendly id and optional password', async () => {
    const user = await loaded()
    const changed = vi.fn()
    window.addEventListener('kcoder:ssh-connections-changed', changed)
    try {
      await createValid(user)
      expect(screen.getByText(/在此保存密码后/)).toBeInTheDocument()
      expect(screen.getByTestId('ssh-connection-password')).toHaveAttribute('type', 'password')
      await user.click(screen.getByTestId('ssh-connection-save'))
      await screen.findByText('SSH 连接已保存。')
      expect(saveSshConnection).toHaveBeenCalledWith({
        id: 'build-2',
        label: 'Build',
        host: 'build2.example.test',
        port: 22,
        username: 'dev',
        authMethod: 'password',
      })
      expect(changed).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId('ssh-connection-form')).not.toBeInTheDocument()
      await waitFor(() => expect(screen.getByTestId('ssh-connection-add')).toHaveFocus())
    } finally {
      window.removeEventListener('kcoder:ssh-connections-changed', changed)
    }
  })

  test('validates required fields, host, username, and integer port while preserving input', async () => {
    const user = await loaded()
    await user.click(screen.getByTestId('ssh-connection-add'))
    await user.click(screen.getByTestId('ssh-connection-save'))
    expect(screen.getByText('请输入连接名称。')).toBeInTheDocument()
    expect(screen.getByLabelText('连接名称')).toHaveFocus()
    await user.type(screen.getByLabelText('连接名称'), 'QA')
    await user.type(screen.getByLabelText('主机名或 IP 地址'), 'ssh://example.test')
    await user.type(screen.getByLabelText('用户名'), '-option')
    for (const port of ['0', '65536', '22.5', '']) {
      fireEvent.change(screen.getByLabelText('端口'), { target: { value: port } })
      await user.click(screen.getByTestId('ssh-connection-save'))
      expect(screen.getByText('请输入 1 至 65535 之间的整数端口。')).toBeInTheDocument()
    }
    expect(screen.getByLabelText('主机名或 IP 地址')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('用户名')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('连接名称')).toHaveValue('QA')
    expect(saveSshConnection).not.toHaveBeenCalled()
  })

  test('edits the original identity and requires a key path on the Gateway host', async () => {
    const stored = { ...profile, hostFingerprint: 'SHA256:read-only-test-fingerprint' }
    vi.mocked(listSshConnections).mockResolvedValue([stored])
    const user = await loaded()
    await user.click(screen.getByTestId('ssh-connection-edit-build'))
    await user.clear(screen.getByLabelText('连接名称'))
    await user.type(screen.getByLabelText('连接名称'), 'Renamed')
    await user.selectOptions(screen.getByLabelText('认证方式'), 'key')
    await user.click(screen.getByTestId('ssh-connection-save'))
    expect(screen.getByText('请输入 Gateway 主机上的私钥路径。')).toBeInTheDocument()
    expect(screen.getByLabelText('私钥路径')).toHaveFocus()
    expect(screen.getByText(/不是浏览器所在电脑的路径/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('私钥路径'), '~/.ssh/id_ed25519')
    await user.click(screen.getByTestId('ssh-connection-save'))
    expect(screen.getByText('请输入 Gateway 主机上的私钥绝对路径。')).toBeInTheDocument()
    expect(saveSshConnection).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText('私钥路径'))
    await user.type(screen.getByLabelText('私钥路径'), '/srv/ssh/test-key')
    await user.click(screen.getByTestId('ssh-connection-save'))
    await screen.findByText('SSH 连接已保存。')
    expect(saveSshConnection).toHaveBeenCalledWith({
      ...profile,
      label: 'Renamed',
      authMethod: 'key',
      privateKeyPath: '/srv/ssh/test-key',
    })
  })

  test('omits the old key path when changing authentication to SSH agent', async () => {
    vi.mocked(listSshConnections).mockResolvedValue([
      { ...profile, authMethod: 'key', privateKeyPath: '/srv/ssh/test-key' },
    ])
    const user = await loaded()
    await user.click(screen.getByTestId('ssh-connection-edit-build'))
    await user.selectOptions(screen.getByLabelText('认证方式'), 'agent')
    expect(screen.getByText(/使用 Gateway 进程可访问的 SSH agent/)).toBeInTheDocument()
    expect(screen.queryByLabelText('私钥路径')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('ssh-connection-save'))
    await screen.findByText('SSH 连接已保存。')
    expect(saveSshConnection).toHaveBeenCalledWith({ ...profile, authMethod: 'agent' })
  })

  test('preserves a failed save for retry and prevents duplicate pending submissions', async () => {
    const user = await loaded()
    await createValid(user)
    let rejectSave!: (error: Error) => void
    vi.mocked(saveSshConnection).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject
        })
    )
    await user.click(screen.getByTestId('ssh-connection-save'))
    expect(screen.getByTestId('ssh-connection-save')).toBeDisabled()
    expect(screen.getByLabelText('连接名称')).toBeDisabled()
    fireEvent.submit(screen.getByTestId('ssh-connection-form'))
    expect(saveSshConnection).toHaveBeenCalledTimes(1)
    rejectSave(new Error('network failure'))
    expect(await screen.findByRole('alert')).toHaveTextContent('已保留填写内容')
    expect(screen.getByLabelText('连接名称')).toHaveValue('Build')
    await user.click(screen.getByTestId('ssh-connection-save'))
    await screen.findByText('SSH 连接已保存。')
    expect(saveSshConnection).toHaveBeenCalledTimes(2)
  })

  test('requires confirmation before deleting, allows cancellation, and notifies terminal menus', async () => {
    const user = await loaded()
    const changed = vi.fn()
    window.addEventListener('kcoder:ssh-connections-changed', changed)
    try {
      await user.click(screen.getByTestId('ssh-connection-delete-build'))
      let dialog = screen.getByRole('dialog', { name: '删除 SSH 连接？' })
      expect(dialog).toHaveTextContent('构建主机')
      expect(deleteSshConnection).not.toHaveBeenCalled()
      await user.click(within(dialog).getByRole('button', { name: '取消' }))
      await waitFor(() => expect(screen.getByTestId('ssh-connection-delete-build')).toHaveFocus())
      await user.click(screen.getByTestId('ssh-connection-delete-build'))
      dialog = screen.getByRole('dialog', { name: '删除 SSH 连接？' })
      await user.click(within(dialog).getByRole('button', { name: '删除连接' }))
      await screen.findByText('SSH 连接已删除。')
      expect(deleteSshConnection).toHaveBeenCalledWith('build')
      expect(screen.queryByText('构建主机')).not.toBeInTheDocument()
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('kcoder:ssh-connections-changed', changed)
    }
  })

  test('retains the connection after deletion failure and supports retry', async () => {
    const user = await loaded()
    vi.mocked(deleteSshConnection).mockRejectedValueOnce(new Error('offline'))
    await user.click(screen.getByTestId('ssh-connection-delete-build'))
    await user.click(screen.getByTestId('ssh-connection-delete-dialog-confirm'))
    expect(await screen.findByRole('alert')).toHaveTextContent('连接仍保留在列表中')
    expect(screen.getByText('构建主机')).toBeInTheDocument()
    await user.click(screen.getByTestId('ssh-connection-delete-build'))
    await user.click(screen.getByTestId('ssh-connection-delete-dialog-confirm'))
    await screen.findByText('SSH 连接已删除。')
  })

  test('retries load errors instead of showing an empty success state', async () => {
    vi.mocked(listSshConnections).mockRejectedValueOnce(new Error('offline'))
    render(<SshConnectionsSettingsPage />)
    const user = userEvent.setup()
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载 SSH 连接')
    expect(screen.queryByText(/暂无 SSH 连接/)).not.toBeInTheDocument()
    expect(screen.getByTestId('ssh-connection-add')).toBeDisabled()
    await user.click(screen.getByTestId('ssh-connections-retry'))
    await screen.findByText('构建主机')
    expect(listSshConnections).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('ssh-connection-add')).toBeEnabled()
  })

  test('asks before discarding form input and restores the editor on cancellation', async () => {
    const user = await loaded()
    await createValid(user)
    await user.click(screen.getByTestId('ssh-connection-cancel'))
    const dialog = screen.getByRole('dialog', { name: '放弃未保存的修改？' })
    await user.click(within(dialog).getByRole('button', { name: '继续编辑' }))
    expect(screen.getByLabelText('连接名称')).toHaveValue('Build')
    await user.click(screen.getByTestId('ssh-connection-cancel'))
    await user.click(screen.getByTestId('ssh-connection-discard-dialog-confirm'))
    expect(screen.queryByTestId('ssh-connection-form')).not.toBeInTheDocument()
    expect(saveSshConnection).not.toHaveBeenCalled()
  })

  test('localizes the page and form in English', async () => {
    await i18n.changeLanguage('en')
    const user = await loaded()
    expect(screen.getByRole('heading', { name: 'SSH connections' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add SSH connection' }))
    expect(screen.getByLabelText('Connection name')).toBeInTheDocument()
    expect(screen.getByText(/Save a password here to reuse it/)).toBeInTheDocument()
  })

  test('accepts IPv6 and generates an id from the host for a Chinese connection name', async () => {
    const user = await loaded()
    await user.click(screen.getByTestId('ssh-connection-add'))
    await user.type(screen.getByLabelText('连接名称'), '测试主机')
    await user.type(screen.getByLabelText('主机名或 IP 地址'), '::1')
    await user.type(screen.getByLabelText('用户名'), 'dev')
    await user.click(screen.getByTestId('ssh-connection-save'))
    await screen.findByText('SSH 连接已保存。')
    expect(saveSshConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: '::1', id: '1' })
    )
  })

  test('rejects malformed host labels and oversized connection names before saving', async () => {
    const user = await loaded()
    await createValid(user)
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: '机'.repeat(41) } })
    for (const host of [
      'example..test',
      '-example.test',
      'example-.test',
      'x'.repeat(64) + '.test',
      'a:b',
    ]) {
      fireEvent.change(screen.getByLabelText('主机名或 IP 地址'), { target: { value: host } })
      await user.click(screen.getByTestId('ssh-connection-save'))
      expect(screen.getByLabelText('主机名或 IP 地址')).toHaveAttribute('aria-invalid', 'true')
    }
    expect(screen.getByText(/UTF-8 长度不能超过 120 字节/)).toBeInTheDocument()
    expect(saveSshConnection).not.toHaveBeenCalled()
  })
})
