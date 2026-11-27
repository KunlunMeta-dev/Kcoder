import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from '@/i18n'
import type {
  RuntimeTaskAddress,
  RuntimeTaskCreationReadResponse,
  RuntimeTaskSummary,
} from '@/types/api'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { FailedTaskRecovery } from './FailedTaskRecovery'

function task(overrides: Partial<RuntimeTaskSummary> = {}): RuntimeTaskSummary {
  return {
    taskId: 'draft-a',
    title: 'Failed draft',
    runtime: 'kcoder',
    workspacePath: '/workspace/a',
    status: 'failed',
    error: 'Fixture creation error',
    ...overrides,
  }
}

function address(
  value: RuntimeTaskSummary,
  deviceId = 'device-a',
  workspacePath = value.workspacePath
): RuntimeTaskAddress {
  return { deviceId, taskId: value.taskId, workspacePath }
}

function readyResult(initialMessage: 'unknown' | 'completed' = 'unknown'):
  RuntimeTaskCreationReadResponse {
  return {
    status: 'ready',
    address: {
      deviceId: 'device-a',
      taskId: 'kcoder:device-a:thread-a',
      threadId: 'thread-a',
      workspacePath: '/workspace/a',
    },
    initialMessage: { status: initialMessage },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('FailedTaskRecovery', () => {
  test('keeps the failure time separate from the latest target status without replaying', () => {
    const failedTask = task({
      updatedAt: '2026-11-13T12:00:00.000Z',
      creationRequest: {
        clientRequestId: 'creation-a',
        clientMessageId: 'message-a',
        outcome: 'unknown',
        failedAt: '2026-11-13T10:00:00.000Z',
      },
    })
    const onRecover = vi.fn()
    const view = render(
      <FailedTaskRecovery task={failedTask} address={address(failedTask)} available={false}
        deviceStatus="offline" onRecover={onRecover} />
    )
    expect(screen.getByText(/^失败于/)).toHaveAttribute('datetime', '2026-11-13T10:00:00.000Z')
    expect(screen.getByTestId('failed-task-target-health')).toHaveTextContent('离线')
    expect(screen.getByRole('button', { name: '查询创建状态' })).toBeDisabled()

    view.rerender(
      <FailedTaskRecovery task={failedTask} address={address(failedTask)} available
        deviceStatus="online" onRecover={onRecover} />
    )
    expect(screen.getByTestId('failed-task-target-health')).toHaveTextContent('在线')
    expect(screen.getByTestId('failed-task-target-health')).toHaveTextContent('此前的发送错误')
    expect(screen.getByText(/^失败于/)).toHaveAttribute('datetime', '2026-11-13T10:00:00.000Z')
    expect(screen.getByRole('button', { name: '查询创建状态' })).toBeEnabled()
    expect(onRecover).not.toHaveBeenCalled()
  })

  test.each([
    [undefined, true, '尚未确认'],
    ['busy', true, '忙碌'],
    ['online', false, '工作区当前不可用'],
  ] as const)('uses reported target status %s and workspace availability %s independently', (deviceStatus, available, text) => {
    const failedTask = task()
    render(<FailedTaskRecovery task={failedTask} address={address(failedTask)} available={available} deviceStatus={deviceStatus} />)
    expect(screen.getByTestId('failed-task-target-health')).toHaveTextContent(text)
  })

  test('does not issue a second lookup while the original query is pending', async () => {
    const pending = deferred<RuntimeTaskCreationReadResponse>()
    const failedTask = task()
    const failedAddress = address(failedTask)
    const onRecover = vi.fn<(address: RuntimeTaskAddress, open?: boolean) => Promise<RuntimeTaskCreationReadResponse>>(() => pending.promise)
    const user = userEvent.setup()
    render(
      <FailedTaskRecovery
        task={failedTask}
        address={failedAddress}
        available
        onRecover={onRecover}
      />
    )

    await user.click(screen.getByRole('button', { name: '查询创建状态' }))
    const queryButton = screen.getByRole('button', { name: '正在查询…' })
    expect(queryButton).toBeDisabled()
    fireEvent.click(queryButton)
    expect(onRecover).toHaveBeenCalledTimes(1)
    expect(onRecover).toHaveBeenCalledWith(failedAddress, false)

    await act(async () => {
      pending.resolve({ status: 'unknown' })
      await pending.promise
    })
    expect(await screen.findByText('创建结果尚未确认。可以稍后再查询，请勿重复发送。'))
      .toBeInTheDocument()
  })

  test.each([
    ['unknown', '创建结果尚未确认。可以稍后再查询，请勿重复发送。'],
    ['unavailable', '该运行目标不支持创建记录查询。请检查会话历史，勿重复发送。'],
  ] as const)('%s lookup outcome stays non-openable', async (status, message) => {
    const failedTask = task()
    const onRecover = vi.fn(async () => ({ status }) as RuntimeTaskCreationReadResponse)
    const user = userEvent.setup()
    render(
      <FailedTaskRecovery
        task={failedTask}
        address={address(failedTask)}
        available
        onRecover={onRecover}
      />
    )

    await user.click(screen.getByRole('button', { name: '查询创建状态' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开原会话' })).not.toBeInTheDocument()
    expect(onRecover).toHaveBeenCalledWith(address(failedTask), false)
  })

  test('keeps unknown initial-message acceptance visible and opens only after an explicit click', async () => {
    const failedTask = task()
    const failedAddress = address(failedTask)
    const onRecover = vi.fn(async () => readyResult('unknown'))
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(
      <FailedTaskRecovery
        task={failedTask}
        address={failedAddress}
        available
        onRecover={onRecover}
        onNavigate={onNavigate}
      />
    )

    await user.click(screen.getByRole('button', { name: '查询创建状态' }))
    expect(
      await screen.findByText(
        '已找到原会话，但首条消息是否接收尚未确认。请打开后先核对内容。'
      )
    ).toBeInTheDocument()
    expect(onRecover).toHaveBeenCalledTimes(1)
    expect(onRecover).toHaveBeenNthCalledWith(1, failedAddress, false)
    expect(onNavigate).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '打开原会话' }))
    await waitFor(() => expect(onNavigate).toHaveBeenCalledOnce())
    expect(onRecover).toHaveBeenNthCalledWith(2, failedAddress, true)
  })

  test('keeps long errors inside a closed details disclosure', async () => {
    const longError = `fixture-long-error:${'stack-frame '.repeat(300)}`
    const failedTask = task({ error: 'short task error' })
    const onRecover = vi.fn(async () => {
      throw new Error(longError)
    })
    const user = userEvent.setup()
    render(
      <FailedTaskRecovery
        task={failedTask}
        address={address(failedTask)}
        available
        onRecover={onRecover}
      />
    )

    await user.click(screen.getByRole('button', { name: '查询创建状态' }))
    expect(await screen.findByText('暂时无法核对原操作。草稿已保留，请检查连接后再查询。'))
      .toBeInTheDocument()
    const details = screen.getByText('创建失败详情').closest('details')!
    expect(details).not.toHaveAttribute('open')
    const rawError = details.querySelector('p')!
    expect(details).toContainElement(rawError)
    expect(rawError.textContent).toBe(longError)
    expect(rawError).not.toBeVisible()
  })

  test('does not apply an older task/device lookup result to the new owner', async () => {
    const oldTask = task()
    const oldAddress = address(oldTask)
    const oldLookup = deferred<RuntimeTaskCreationReadResponse>()
    const newTask = task({
      taskId: 'draft-b',
      workspacePath: '/workspace/b',
      error: 'Second task error',
    })
    const newAddress = address(newTask, 'device-b')
    const onRecover = vi.fn((target: RuntimeTaskAddress) =>
      target.taskId === oldTask.taskId ? oldLookup.promise : Promise.resolve({ status: 'unknown' })
    )
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    const view = render(
      <FailedTaskRecovery
        task={oldTask}
        address={oldAddress}
        available
        onRecover={onRecover}
        onNavigate={onNavigate}
      />
    )

    await user.click(screen.getByRole('button', { name: '查询创建状态' }))
    view.rerender(
      <FailedTaskRecovery
        task={newTask}
        address={newAddress}
        available
        onRecover={onRecover}
        onNavigate={onNavigate}
      />
    )
    await act(async () => {
      oldLookup.resolve(readyResult('completed'))
      await oldLookup.promise
    })

    expect(screen.getByTestId('runtime-task-creation-error-draft-b')).toBeInTheDocument()
    expect(screen.queryByText('已找到原会话，可以打开核对消息与执行状态。'))
      .not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开原会话' })).not.toBeInTheDocument()
    expect(onNavigate).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '查询创建状态' }))
    expect(onRecover).toHaveBeenNthCalledWith(2, newAddress, false)
    expect(await screen.findByText('创建结果尚未确认。可以稍后再查询，请勿重复发送。'))
      .toBeInTheDocument()
  })

  test('uses mobile touch targets and avoids nested live roles in a 320px host', async () => {
    const failedTask = task()
    const onRecover = vi.fn(async () => ({ status: 'unknown' }) as RuntimeTaskCreationReadResponse)
    const user = userEvent.setup()
    render(
      <div data-testid="mobile-sidebar-host" style={{ width: '320px' }}>
        <FailedTaskRecovery
          task={failedTask}
          address={address(failedTask)}
          available
          onRecover={onRecover}
        />
      </div>
    )

    expect(screen.getByTestId('mobile-sidebar-host')).toHaveStyle({ width: '320px' })
    const queryButton = screen.getByRole('button', { name: '查询创建状态' })
    const connectionButton = screen.getByRole('button', { name: '检查连接' })
    expect(queryButton).toHaveClass('min-h-11')
    expect(connectionButton).toHaveClass('min-h-11')
    expect(screen.getByTestId('runtime-task-creation-error-draft-a')).toHaveClass('break-words')

    await user.click(queryButton)
    const alert = screen.getByRole('alert')
    expect(alert.querySelector('[role="alert"], [role="status"]')).toBeNull()
  })
})
