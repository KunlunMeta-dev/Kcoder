import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SubagentWorkspace, type SubagentWorkspaceProps } from './SubagentWorkspace'
import type { WorkbenchMessage } from '@/types/workbench'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

// Receipt/state tests use a controlled input; native E2E covers the shared ProseMirror composer.
vi.mock('@/components/chat/composer/ComposerTextarea', () => ({
  ComposerTextarea: ({
    testId,
    value,
    onChange,
  }: {
    testId: string
    value: string
    onChange: (value: string) => void
  }) => (
    <textarea data-testid={testId} value={value} onChange={event => onChange(event.target.value)} />
  ),
}))

function props(): SubagentWorkspaceProps {
  return {
    agent: {
      id: 'agent-1',
      agentId: 'agent-1',
      agentPath: 'thread:agent-1',
      agentName: 'worker',
      status: 'running',
    },
    connected: true,
    canSteer: true,
    onReadArtifact: vi.fn().mockResolvedValue({
      content: 'public tool record',
      offset: 0,
      revision: 'r1',
      size: 18,
      truncated: false,
    }),
    onSteer: vi.fn().mockRejectedValue(new Error('socket closed')),
    onClose: vi.fn(),
  }
}

describe('SubagentWorkspace', () => {
  test('reads the selected worker and retains unknown command identity when checking authority', async () => {
    const host = props()
    host.onLookupCommand = vi.fn(async (_agentId, clientMessageId) => ({
      agentId: 'agent-1',
      clientMessageId,
      messageId: 'msg-1',
      accepted: true,
      queued: true,
      status: 'queued_live',
    }))
    render(<SubagentWorkspace {...host} />)
    await waitFor(() =>
      expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent(
        'public tool record'
      )
    )
    expect(host.onReadArtifact).toHaveBeenCalledWith('agent-1', 'transcript', 0)
    fireEvent.change(screen.getByTestId('subagent-workspace-input'), {
      target: { value: 'check the edge case' },
    })
    fireEvent.click(screen.getByTestId('subagent-workspace-send'))
    await waitFor(() =>
      expect(screen.getByTestId('subagent-workspace-commands')).toHaveTextContent(
        'subagent_command_unknown'
      )
    )
    const identity = vi.mocked(host.onSteer).mock.calls[0][2]
    expect(identity).toMatch(/^cmd:0:/)
    fireEvent.click(screen.getByText(/subagent_detail_check/))
    await waitFor(() => expect(host.onLookupCommand).toHaveBeenCalledWith('agent-1', identity))
    expect(host.onSteer).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('subagent-workspace-back'))
    expect(host.onClose).toHaveBeenCalledTimes(1)
  })

  test('disconnection preserves a draft and disables mutation; completion is separately readable', async () => {
    const host = props()
    const view = render(<SubagentWorkspace {...host} connected={false} />)
    fireEvent.change(screen.getByTestId('subagent-workspace-input'), {
      target: { value: 'still drafting' },
    })
    expect(screen.getByTestId('subagent-workspace-send')).toBeDisabled()
    expect(host.onReadArtifact).not.toHaveBeenCalled()
    view.rerender(
      <SubagentWorkspace {...host} agent={{ ...host.agent, status: 'done' }} canSteer={false} />
    )
    await waitFor(() => expect(host.onReadArtifact).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('subagent-workspace-input')).toHaveValue('still drafting')
    expect(screen.getByTestId('subagent-workspace-send')).toBeDisabled()
  })

  test('legacy history refresh is explicit and completion never simulates a live stream', async () => {
    const host = props()
    host.onReadLatest = vi.fn().mockResolvedValue({
      content: 'live preview',
      offset: 0,
      revision: 'live',
      size: 12,
      truncated: false,
    })
    const view = render(<SubagentWorkspace {...host} />)
    await waitFor(() =>
      expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent('live preview')
    )
    vi.mocked(host.onReadLatest).mockResolvedValue({
      content: 'final public output',
      offset: 0,
      revision: 'final',
      size: 20,
      truncated: false,
    })
    view.rerender(<SubagentWorkspace {...host} agent={{ ...host.agent, status: 'done' }} />)
    expect(host.onReadLatest).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('subagent-workspace-refresh'))
    await waitFor(() =>
      expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent(
        'final public output'
      )
    )
    expect(host.onReadLatest).toHaveBeenCalledTimes(2)
  })

  test('structured streaming uses the ordinary message area and composer without artifact polling', async () => {
    const host = props()
    const message = {
      id: 'assistant-1',
      subtaskId: 'assistant-1',
      role: 'assistant' as const,
      content: 'First chunk',
      status: 'streaming' as const,
      createdAt: '',
    }
    const view = render(
      <SubagentWorkspace {...host} conversationMessages={[message]} conversationActive />
    )
    expect(screen.getByTestId('subagent-workspace-scroll')).toBeInTheDocument()
    expect(screen.getByTestId('project-chat-composer')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent('First chunk')
    expect(screen.queryByTestId('model-selector')).not.toBeInTheDocument()
    expect(screen.queryByTestId('subagent-workspace-refresh')).not.toBeInTheDocument()
    expect(screen.queryByTestId('send-mode-menu-button')).not.toBeInTheDocument()
    view.rerender(
      <SubagentWorkspace
        {...host}
        conversationMessages={[{ ...message, content: 'First chunk plus delta' }]}
        conversationActive
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent(
        'First chunk plus delta'
      )
    )
    view.rerender(
      <SubagentWorkspace
        {...host}
        conversationMessages={[{ ...message, content: 'Final answer', status: 'done' }]}
        conversationActive={false}
      />
    )
    expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent('Final answer')
    expect(host.onReadArtifact).not.toHaveBeenCalled()
  })

  test('a structured snapshot preserves initial text blocks while tools stream and after reopening', async () => {
    const host = props()
    const narrative: NonNullable<WorkbenchMessage['blocks']>[number] = {
      id: 'text-first',
      subtaskId: 'assistant-live',
      type: 'text',
      content: 'S03_LIVE_VISIBLE',
      status: 'done',
      createdAt: 1000,
    }
    const message: WorkbenchMessage = {
      id: 'assistant-live',
      subtaskId: 'assistant-live',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: '',
      blocks: [narrative],
    }
    const first = render(
      <SubagentWorkspace {...host} conversationMessages={[message]} conversationActive />
    )
    expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent('S03_LIVE_VISIBLE')
    const toolMessage: WorkbenchMessage = {
      ...message,
      blocks: [
        narrative,
        {
          id: 'read-live',
          subtaskId: 'assistant-live',
          type: 'tool',
          toolName: 'read',
          toolInput: { file_path: 'src/main.rs' },
          status: 'running',
          createdAt: 1100,
        },
      ],
    }
    first.rerender(
      <SubagentWorkspace {...host} conversationMessages={[toolMessage]} conversationActive />
    )
    await waitFor(() =>
      expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent('S03_LIVE_VISIBLE')
    )
    expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
    first.unmount()
    render(<SubagentWorkspace {...host} conversationMessages={[toolMessage]} conversationActive />)
    expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent('S03_LIVE_VISIBLE')
    expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
    expect(host.onReadArtifact).not.toHaveBeenCalled()
  })

  test('authoritative applied user identity removes optimistic command duplication', async () => {
    const host = props()
    host.onSteer = vi.fn(async (_agentId, _message, clientMessageId) => ({
      agentId: 'agent-1',
      clientMessageId,
      messageId: 'user-ack',
      accepted: true,
      queued: true,
      status: 'queued_live',
    }))
    const view = render(<SubagentWorkspace {...host} conversationMessages={[]} />)
    fireEvent.change(screen.getByTestId('subagent-workspace-input'), {
      target: { value: 'instruction exactly once' },
    })
    fireEvent.click(screen.getByTestId('subagent-workspace-send'))
    await waitFor(() => expect(host.onSteer).toHaveBeenCalledTimes(1))
    const clientMessageId = vi.mocked(host.onSteer).mock.calls[0][2]
    view.rerender(
      <SubagentWorkspace
        {...host}
        conversationMessages={[
          {
            id: 'user-ack',
            role: 'user',
            content: 'instruction exactly once',
            status: 'done',
            createdAt: '',
          },
        ]}
        commandHistory={[
          {
            clientMessageId,
            messageId: 'user-ack',
            message: 'instruction exactly once',
            status: 'applied',
          },
        ]}
      />
    )
    expect(screen.getAllByText('instruction exactly once')).toHaveLength(1)
  })

  test('a client identity arriving before its receipt prevents duplicates across the acknowledgement', async () => {
    const host = props()
    let acknowledge: (receipt: Awaited<ReturnType<typeof host.onSteer>>) => void = () => {}
    host.onSteer = vi.fn(
      () =>
        new Promise(resolve => {
          acknowledge = resolve
        })
    )
    const view = render(<SubagentWorkspace {...host} conversationMessages={[]} />)
    fireEvent.change(screen.getByTestId('subagent-workspace-input'), {
      target: { value: 'early applied instruction' },
    })
    fireEvent.click(screen.getByTestId('subagent-workspace-send'))
    await waitFor(() => expect(host.onSteer).toHaveBeenCalledTimes(1))
    const clientMessageId = vi.mocked(host.onSteer).mock.calls[0][2]
    view.rerender(
      <SubagentWorkspace
        {...host}
        conversationMessages={[
          {
            id: clientMessageId,
            role: 'user',
            content: 'early applied instruction',
            status: 'done',
            createdAt: '',
            source: { source: 'subagent-command', clientMessageId },
          },
        ]}
      />
    )
    expect(screen.getAllByText('early applied instruction')).toHaveLength(1)
    await act(async () =>
      acknowledge({
        agentId: 'agent-1',
        clientMessageId,
        messageId: 'receipt-id',
        accepted: true,
        queued: true,
        status: 'queued_live',
      })
    )
    expect(screen.getAllByText('early applied instruction')).toHaveLength(1)
  })
  test('completion cannot replace the user selected historical page', async () => {
    const host = props()
    host.onReadLatest = vi.fn().mockResolvedValue({
      content: 'live preview',
      offset: 0,
      revision: 'live',
      size: 12,
      truncated: false,
    })
    const view = render(<SubagentWorkspace {...host} />)
    await waitFor(() => expect(host.onReadLatest).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('subagent-workspace-history'))
    await waitFor(() =>
      expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent(
        'public tool record'
      )
    )
    view.rerender(<SubagentWorkspace {...host} agent={{ ...host.agent, status: 'done' }} />)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    expect(host.onReadLatest).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent('public tool record')
  })
  test('reviews target receipt history and archives exactly its current epoch', async () => {
    const host = props()
    host.commandEpoch = 7
    host.commandHistory = [
      {
        clientMessageId: 'cmd:7:old',
        messageId: 'msg-old',
        message: 'previous command preview',
        status: 'applied',
      },
    ]
    host.retainedCommandCount = 1
    host.canArchiveCommands = true
    host.onArchiveCommands = vi.fn().mockResolvedValue(true)
    render(<SubagentWorkspace {...host} />)
    expect(screen.getByTestId('subagent-workspace-commands')).toHaveTextContent(
      'previous command preview'
    )
    fireEvent.click(screen.getByTestId('subagent-workspace-archive'))
    await waitFor(() => expect(host.onArchiveCommands).toHaveBeenCalledWith(['msg-old'], 7))
    expect(host.onSteer).not.toHaveBeenCalled()
  })

  test('keyboard focus stays in the detail view and a partial journal cannot be archived', () => {
    const host = props()
    host.commandHistory = [
      { clientMessageId: 'cmd:0:old', messageId: 'msg-old', message: 'command', status: 'applied' },
    ]
    host.retainedCommandCount = 2
    host.canArchiveCommands = true
    host.onArchiveCommands = vi.fn()
    render(<SubagentWorkspace {...host} />)
    expect(screen.getByTestId('subagent-workspace-archive')).toBeDisabled()
    const first = screen.getByTestId('subagent-workspace-back')
    expect(first).toHaveFocus()
    fireEvent.change(screen.getByTestId('subagent-workspace-input'), { target: { value: 'draft' } })
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(screen.getByTestId('subagent-workspace-send')).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId('subagent-workspace-send'), { key: 'Tab' })
    expect(first).toHaveFocus()
  })

  test('observes the live tail without replacing manually selected history', async () => {
    const host = props()
    host.onReadLatest = vi.fn().mockResolvedValue({
      content: 'latest tool progress',
      offset: 1000,
      revision: 'live',
      size: 1020,
      truncated: false,
    })
    host.onReadArtifact = vi.fn().mockResolvedValue({
      content: 'historical beginning',
      offset: 0,
      revision: 'history',
      size: 20,
      truncated: false,
    })
    render(<SubagentWorkspace {...host} />)
    await waitFor(() =>
      expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent(
        'latest tool progress'
      )
    )
    fireEvent.click(screen.getByTestId('subagent-workspace-history'))
    await waitFor(() =>
      expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent(
        'historical beginning'
      )
    )
    await new Promise(resolve => setTimeout(resolve, 2100))
    expect(host.onReadLatest).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent(
      'historical beginning'
    )
    fireEvent.click(screen.getByTestId('subagent-workspace-refresh'))
    await waitFor(() => expect(host.onReadLatest).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent(
      'latest tool progress'
    )
  })

  test('stop is a separate supported action and unknown cleanup never settles the agent locally', async () => {
    const host = props()
    host.runId = 'run-1'
    host.canStop = true
    host.onStop = vi.fn().mockResolvedValue({ stopped: false, status: 'cleanup_unknown' })
    const view = render(<SubagentWorkspace {...host} />)
    fireEvent.click(screen.getByTestId('subagent-workspace-stop'))
    await waitFor(() => expect(host.onStop).toHaveBeenCalledWith('agent-1'))
    expect(screen.getByTestId('subagent-workspace-stop-status')).toHaveTextContent(
      'subagent_stop_cleanup_unknown'
    )
    expect(host.onSteer).not.toHaveBeenCalled()
    view.rerender(<SubagentWorkspace {...host} runId="run-2" />)
    expect(screen.queryByTestId('subagent-workspace-stop-status')).not.toBeInTheDocument()
    view.rerender(<SubagentWorkspace {...host} canStop={false} />)
    expect(screen.queryByTestId('subagent-workspace-stop')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('subagent-workspace-back'))
    expect(host.onStop).toHaveBeenCalledTimes(1)
  })

  test('old targets only request output and never request a private transcript', async () => {
    const host = props()
    render(<SubagentWorkspace {...host} canReadTranscript={false} canSteer={false} />)
    await waitFor(() => expect(host.onReadArtifact).toHaveBeenCalledWith('agent-1', 'output', 0))
    expect(screen.queryByText('workbench.subagent_detail_transcript')).not.toBeInTheDocument()
    expect(screen.getByTestId('subagent-workspace-send')).toBeDisabled()
  })

  test('failure to save a client recovery handle prevents sending and preserves the draft', async () => {
    const host = props()
    host.onCommandIntent = vi.fn().mockRejectedValue(new Error('storage quota'))
    render(<SubagentWorkspace {...host} />)
    fireEvent.change(screen.getByTestId('subagent-workspace-input'), {
      target: { value: 'preserve this intent' },
    })
    fireEvent.click(screen.getByTestId('subagent-workspace-send'))
    await waitFor(() =>
      expect(screen.getByTestId('subagent-workspace-commands')).toHaveTextContent(
        'local_intent_unavailable'
      )
    )
    expect(host.onSteer).not.toHaveBeenCalled()
    expect(screen.getByTestId('subagent-workspace-input')).toHaveValue('preserve this intent')
  })
})
