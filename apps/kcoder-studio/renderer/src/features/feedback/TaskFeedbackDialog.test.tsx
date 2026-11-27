import {registerBackgroundIssue} from '@/kcoder/backgroundIssues'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TaskFeedbackDialog } from './TaskFeedbackDialog'

const { invokeMock, capabilities } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  capabilities: { runtimeLogs: true, screenshot: true },
}))

vi.mock('@/lib/runtime-commands', () => ({ invoke: invokeMock }))
vi.mock('./feedbackExport', () => ({ feedbackCapabilities: () => capabilities }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'workbench.feedback_runtime_logs': '运行日志',
        'workbench.feedback_task_info': '任务与完整对话',
        'workbench.feedback_task_info_description': '包含完整会话消息、排队与指导消息、任务状态、目标/计划和子代理状态；文本仅按常见凭证模式脱敏。',
        'workbench.feedback_screenshot_description': '当前任务界面截图；图片内容不会脱敏。',
      })[key] ?? key,
  }),
}))

describe('TaskFeedbackDialog', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    capabilities.runtimeLogs = true
    capabilities.screenshot = true
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
  })

  test('presents runtime logs as one user-facing option', () => {
    render(
      <TaskFeedbackDialog
        open
        getTaskContext={async () => ({ taskId: 'task-1' })}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('运行日志')).toBeInTheDocument()
    expect(screen.queryByText('Executor 日志')).not.toBeInTheDocument()
    expect(screen.queryByText('Gateway 日志')).not.toBeInTheDocument()
    expect(screen.getByTestId('task-feedback-runtimeLogs-checkbox')).toBeChecked()
  })

  test('discloses that task export includes the full conversation and screenshots are unchanged', () => {
    render(<TaskFeedbackDialog open getTaskContext={async () => ({})} onClose={vi.fn()} />)
    expect(screen.getByText('任务与完整对话')).toBeInTheDocument()
    expect(screen.getByText(/包含完整会话消息、排队与指导消息、任务状态、目标\/计划和子代理状态/)).toBeInTheDocument()
    expect(screen.getByText('当前任务界面截图；图片内容不会脱敏。')).toBeInTheDocument()
  })

  test('disables export when every information category is unchecked', () => {
    render(
      <TaskFeedbackDialog
        open
        getTaskContext={async () => ({ taskId: 'task-1' })}
        onClose={vi.fn()}
      />
    )
    ;['runtimeLogs', 'taskInfo', 'screenshot', 'systemInfo'].forEach(key => {
      fireEvent.click(screen.getByTestId(`task-feedback-${key}-checkbox`))
    })

    expect(screen.getByTestId('task-feedback-export-button')).toBeDisabled()
  })

  test('browser disables unavailable native sources and preserves export after cancellation', async () => {
    capabilities.runtimeLogs = false
    capabilities.screenshot = false
    invokeMock.mockResolvedValue(null)
    render(<TaskFeedbackDialog open getTaskContext={async () => ({ taskId: 'owned' })} onClose={vi.fn()} />)
    for (const key of ['runtimeLogs', 'screenshot']) {
      expect(screen.getByTestId(`task-feedback-${key}-checkbox`)).toBeDisabled()
      expect(screen.getByTestId(`task-feedback-${key}-checkbox`)).not.toBeChecked()
    }
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await waitFor(() => expect(screen.getByTestId('task-feedback-export-button')).toBeEnabled())
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('export_feedback_bundle', expect.objectContaining({ request: expect.objectContaining({
      includeRuntimeLogs: false, includeScreenshot: false,
    }) }))
    expect(screen.queryByText('workbench.feedback_exported')).not.toBeInTheDocument()
  })

  test('browser success says download requested and discloses omitted sources', async () => {
    capabilities.runtimeLogs = false
    capabilities.screenshot = false
    invokeMock.mockResolvedValue({ reportId: 'KC-owned', path: 'owned.zip', downloadStatus: 'requested', warnings: ['RUNTIME_LOGS_UNAVAILABLE'] })
    render(<TaskFeedbackDialog open getTaskContext={async () => ({})} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('task-feedback-export-button'))
    await screen.findByText('workbench.feedback_download_requested')
    expect(screen.getByText('workbench.feedback_export_partial')).toBeInTheDocument()
    expect(screen.queryByText('workbench.feedback_exported')).not.toBeInTheDocument()
  })

  test('hides the dialog while capturing and exports the complete task context', async () => {
    let resolveCapture: (value: string) => void = () => undefined
    const capture = new Promise<string>(resolve => {
      resolveCapture = resolve
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'capture_main_webview') return capture
      if (command === 'export_feedback_bundle') {
        return Promise.resolve({ reportId: 'KC-1', path: 'feedback.zip', downloadStatus: 'completed', warnings: [] })
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`))
    })
    const getTaskContext = vi.fn().mockResolvedValue({
      conversation: {
        messages: [
          { id: 'user-1', role: 'user', content: 'question' },
          { id: 'assistant-1', role: 'assistant', content: 'answer' },
        ],
      },
    })
    render(<TaskFeedbackDialog open getTaskContext={getTaskContext} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('task-feedback-export-button'))

    await waitFor(() => {
      const overlay = screen.getByTestId('task-feedback-dialog-overlay')
      expect(overlay).toHaveClass('invisible')
      expect(overlay).toHaveStyle({ visibility: 'hidden' })
    })
    await act(async () => resolveCapture('data:image/png;base64,aGVsbG8='))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('export_feedback_bundle', expect.anything())
    )
    expect(screen.getByTestId('task-feedback-dialog-overlay')).not.toHaveClass('invisible')
    expect(screen.getByTestId('task-feedback-dialog-overlay')).not.toHaveStyle({
      visibility: 'hidden',
    })
    expect(getTaskContext).toHaveBeenCalledOnce()
    expect(invokeMock).toHaveBeenCalledWith(
      'export_feedback_bundle',
      expect.objectContaining({
        request: expect.objectContaining({
          taskContext: expect.objectContaining({
            conversation: expect.objectContaining({
              messages: expect.arrayContaining([
                expect.objectContaining({ content: 'question' }),
                expect.objectContaining({ content: 'answer' }),
              ]),
            }),
          }),
        }),
      })
    )
  })
})

test('background diagnostics export only safe kind/code when task information is selected',async()=>{
 const target={deviceId:'owned',taskId:'owned-task',workspacePath:'/owned'}
 const dispose=registerBackgroundIssue({kind:'imported_history_check',code:'IMPORTED_HISTORY_READ_FAILED',target,isCurrent:()=>true,retry:vi.fn(),dismiss:vi.fn()})
 invokeMock.mockResolvedValue({reportId:'report',path:'report.zip',downloadStatus:'completed',warnings:[]})
 const view=render(<TaskFeedbackDialog open target={target} getTaskContext={async()=>({taskId:'owned-task'})} onClose={vi.fn()}/>)
 try {
  fireEvent.click(screen.getByTestId('task-feedback-screenshot-checkbox'))
  fireEvent.click(screen.getByTestId('task-feedback-export-button'))
  await waitFor(()=>expect(invokeMock).toHaveBeenCalledWith('export_feedback_bundle',expect.objectContaining({request:expect.objectContaining({taskContext:{taskId:'owned-task',backgroundIssues:[{kind:'imported_history_check',code:'IMPORTED_HISTORY_READ_FAILED'}]}})})))
  view.unmount();invokeMock.mockClear()
  render(<TaskFeedbackDialog open target={target} getTaskContext={vi.fn()} onClose={vi.fn()}/>)
  fireEvent.click(screen.getByTestId('task-feedback-taskInfo-checkbox'))
  fireEvent.click(screen.getByTestId('task-feedback-screenshot-checkbox'))
  fireEvent.click(screen.getByTestId('task-feedback-export-button'))
  await waitFor(()=>expect(invokeMock).toHaveBeenCalledWith('export_feedback_bundle',expect.objectContaining({request:expect.objectContaining({taskContext:null,includeTaskInfo:false})})))
 }finally{dispose()}
})
