import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { StudioWorkModeSwitcher } from './StudioWorkModeSwitcher'
import { DesktopEmptyTaskLauncher } from './DesktopEmptyTaskLauncher'
import { readStudioWorkMode, setStudioWorkMode } from '@/features/workbench/studioWorkMode'

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

test('blank-task mode switch preserves the composer and selects office suggestions', async () => {
  const onNewChat = vi.fn()
  render(
    <>
      <StudioWorkModeSwitcher onNewChat={onNewChat} />
      <DesktopEmptyTaskLauncher
        projectName="demo"
        onOpenProjectSelector={vi.fn()}
        onSelectSuggestion={vi.fn()}
        composer={<input data-testid="chat-message-input" defaultValue="保留草稿" />}
      />
    </>
  )
  const input = screen.getByTestId('chat-message-input')
  await userEvent.click(screen.getByRole('button', { name: 'KWorker' }))
  expect(readStudioWorkMode()).toBe('kworker')
  expect(onNewChat).not.toHaveBeenCalled()
  expect(input).toBe(screen.getByTestId('chat-message-input'))
  expect(input).toHaveValue('保留草稿')
  expect(screen.getByRole('heading')).toHaveTextContent('今天有什么工作需要帮忙？')
  expect(screen.getByTestId('task-suggestion-category-documents')).toHaveTextContent('整理文档')
  expect(screen.getByTestId('task-suggestion-category-sheets')).toHaveTextContent('分析表格')
  expect(screen.queryByTestId('task-suggestion-category-explore')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'KCoder', exact: true }))
  expect(screen.getByTestId('task-suggestion-category-explore')).toBeInTheDocument()
  expect(input).toHaveValue('保留草稿')
})

test('existing task mode overrides the next-task preference and changing it opens a new task', async () => {
  const onNewChat = vi.fn()
  act(() => setStudioWorkMode('kworker'))
  const address = {
    deviceId: 'ssh-server',
    taskId: 'existing',
    runtimeHandle: { studioWorkMode: 'kcoder' },
  }
  render(<StudioWorkModeSwitcher address={address} onNewChat={onNewChat} />)
  expect(screen.getByRole('button', { name: 'KCoder', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await userEvent.click(screen.getByRole('button', { name: 'KWorker' }))
  expect(onNewChat).toHaveBeenCalledOnce()
  expect(address.runtimeHandle.studioWorkMode).toBe('kcoder')
})

test('home transitions retain focused composer controls, selection and attachments', () => {
  render(
    <>
      <StudioWorkModeSwitcher onNewChat={vi.fn()} />
      <DesktopEmptyTaskLauncher
        projectName="demo"
        onOpenProjectSelector={vi.fn()}
        onSelectSuggestion={vi.fn()}
        composer={
          <div>
            <input data-testid="chat-message-input" defaultValue="办公草稿内容" />
            <select aria-label="Model" defaultValue="chosen-model">
              <option value="chosen-model">Chosen model</option>
            </select>
            <select aria-label="Target" defaultValue="chosen-target">
              <option value="chosen-target">Chosen target</option>
            </select>
            <span data-testid="attachment">report.pdf</span>
          </div>
        }
      />
    </>
  )
  const composer = screen.getByTestId('chat-message-input') as HTMLInputElement
  const model = screen.getByRole('combobox', { name: 'Model' })
  const target = screen.getByRole('combobox', { name: 'Target' })
  const attachment = screen.getByTestId('attachment')
  const heading = screen.getByRole('heading')
  const officeButton = screen.getByRole('button', { name: 'KWorker' })
  composer.focus()
  composer.setSelectionRange(1, 4)
  for (const mode of ['kworker', 'kcoder', 'kworker'] as const) {
    act(() => setStudioWorkMode(mode))
    expect(screen.getByTestId('chat-message-input')).toBe(composer)
    expect(composer).toHaveFocus()
    expect(composer).toHaveValue('办公草稿内容')
    expect([composer.selectionStart, composer.selectionEnd]).toEqual([1, 4])
    expect(screen.getByRole('combobox', { name: 'Model' })).toBe(model)
    expect(model).toHaveValue('chosen-model')
    expect(screen.getByRole('combobox', { name: 'Target' })).toBe(target)
    expect(target).toHaveValue('chosen-target')
    expect(screen.getByTestId('attachment')).toBe(attachment)
    expect(screen.getByRole('heading')).toBe(heading)
    expect(screen.getByRole('button', { name: 'KWorker' })).toBe(officeButton)
  }
})
