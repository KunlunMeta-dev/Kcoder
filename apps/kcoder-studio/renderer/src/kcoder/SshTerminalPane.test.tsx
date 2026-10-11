import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { SshTerminalPane } from './SshTerminalPane'

const mock = vi.hoisted(() => ({ connect: vi.fn(), dispose: vi.fn(), remoteProps: vi.fn() }))
vi.mock('./sshTerminal', () => ({
  SshTerminalConnection: class {
    connect = mock.connect
    dispose = mock.dispose
    createTerminalClient = vi.fn()
  },
}))
vi.mock('@/components/layout/workspace-panels/RemoteTerminal', () => ({
  RemoteTerminal: (props: unknown) => {
    mock.remoteProps(props)
    return <div data-testid="terminal-fixture" />
  },
}))
const profile = {
  id: 'test',
  label: 'Test',
  host: 'localhost',
  port: 22,
  username: 'tester',
  authMethod: 'password' as const,
}
beforeEach(() => {
  vi.clearAllMocks()
})

test('uses saved passwords without passing plaintext back from the UI', async () => {
  mock.connect.mockResolvedValue({ status: 'connected' })
  render(<SshTerminalPane profile={{ ...profile, passwordSaved: true }} active sessionId="saved" />)
  expect(screen.getByTestId('ssh-password')).not.toBeRequired()
  fireEvent.click(screen.getByTestId('ssh-connect'))
  await waitFor(() => expect(mock.connect).toHaveBeenCalledWith('test', {}))
  expect(screen.getByTestId('terminal-fixture')).toBeInTheDocument()
})

test('requires explicit fingerprint approval and keeps terminal output detached from task context', async () => {
  mock.connect
    .mockResolvedValueOnce({
      status: 'host-key-required',
      fingerprint: 'SHA256:fixture',
      host: 'localhost',
      port: 22,
    })
    .mockResolvedValueOnce({ status: 'connected' })
  render(<SshTerminalPane profile={profile} active sessionId="ssh-test" />)
  expect(mock.connect).not.toHaveBeenCalled()
  fireEvent.change(screen.getByTestId('ssh-password'), { target: { value: 'secret-fixture' } })
  fireEvent.click(screen.getByTestId('ssh-connect'))
  expect(await screen.findByTestId('ssh-host-fingerprint')).toHaveTextContent('SHA256:fixture')
  expect(mock.connect).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByTestId('ssh-confirm-host'))
  await screen.findByTestId('terminal-fixture')
  expect(mock.connect).toHaveBeenLastCalledWith('test', {
    password: 'secret-fixture',
    acceptFingerprint: 'SHA256:fixture',
  })
  const props = mock.remoteProps.mock.lastCall?.[0]
  expect(props.taskId).toBeUndefined()
  expect(props.workspacePath).toBeUndefined()
  fireEvent.click(screen.getByTestId('ssh-disconnect'))
  expect(screen.getByTestId('ssh-password')).toHaveValue('')
})

test('cancel closes a pending connection and ignores its late response', async () => {
  let complete!: (value: unknown) => void
  mock.connect.mockImplementation(
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )
  const { unmount } = render(<SshTerminalPane profile={profile} active sessionId="ssh-test" />)
  fireEvent.change(screen.getByTestId('ssh-password'), { target: { value: 'secret-fixture' } })
  fireEvent.click(screen.getByTestId('ssh-connect'))
  fireEvent.click(screen.getByTestId('ssh-disconnect'))
  complete({ status: 'connected' })
  await waitFor(() => expect(screen.getByTestId('ssh-password')).toHaveValue(''))
  expect(screen.queryByTestId('terminal-fixture')).not.toBeInTheDocument()
  expect(mock.dispose).toHaveBeenCalled()
  unmount()
})
