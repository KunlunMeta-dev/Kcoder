import '@/i18n'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { SubagentWorkspace, type SubagentWorkspaceProps } from './SubagentWorkspace'
import {
  ConversationWidgetsContext,
  type ConversationWidgetsValue,
} from '@/components/chat/widgets/widgetContext'
import type { InlineWidgetHostProps } from '@/features/widgets/InlineWidgetHost'
import type { WidgetRef } from '../../../../shared/generated/contracts'
vi.mock('@/features/widgets/InlineWidgetHost', async () => {
  const { WidgetStreamPreview } = await import('@/features/widgets/WidgetStreamPreview')
  return {
    WidgetStreamPreview,
    InlineWidgetHost: (props: InlineWidgetHostProps) => (
      <button
        data-testid="forbidden-widget-host"
        onClick={() => props.onSendPrompt?.('must not reach parent')}
      >
        Execute widget prompt
      </button>
    ),
  }
})
afterEach(() => {
  cleanup()
  clearTestTransports()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function props(): SubagentWorkspaceProps {
  return {
    readOnly: true,
    agent: {
      id: 'child',
      agentId: 'child',
      agentPath: 'child',
      agentName: 'Original member',
      status: 'done',
    },
    connected: true,
    runId: 'original-run',
    canSteer: true,
    canStop: true,
    canArchiveCommands: true,
    onSteer: vi.fn(),
    onStop: vi.fn(),
    onArchiveCommands: vi.fn(),
    onReadArtifact: vi.fn(),
    onClose: vi.fn(),
    conversationMessages: [],
    conversationActive: false,
  }
}
test('readonly blocks composer, stop, archive and injected approval controls even if host callbacks exist', () => {
  installTestTransport(() => undefined)
  const host = props()
  host.interactions = <button data-testid="forbidden-approval">Approve execution</button>
  render(<SubagentWorkspace {...host} />)
  expect(screen.queryByTestId('subagent-workspace-input')).toBeNull()
  expect(screen.queryByTestId('subagent-workspace-send')).toBeNull()
  expect(screen.queryByTestId('subagent-workspace-stop')).toBeNull()
  expect(screen.queryByTestId('subagent-workspace-archive')).toBeNull()
  expect(screen.queryByTestId('forbidden-approval')).toBeNull()
  fireEvent.click(screen.getByTestId('subagent-workspace-back'))
  expect(host.onClose).toHaveBeenCalledOnce()
  expect(host.onStop).not.toHaveBeenCalled()
  expect(host.onSteer).not.toHaveBeenCalled()
  expect(host.onArchiveCommands).not.toHaveBeenCalled()
})
test('readonly member masks parent widget/MCP context so inline prompts cannot target another conversation', async () => {
  installTestTransport(() => undefined)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    toJSON() {
      return {}
    },
  })

  const sendPrompt = vi.fn(),
    content = vi.fn(),
    read = vi.fn(),
    invoke = vi.fn()
  const widget: WidgetRef = {
    widgetId: 'parent-widget',
    threadId: 'parent-thread',
    turnId: 'turn',
    attemptId: 'attempt',
    toolCallId: 'call',
    revision: 1,
    title: 'Parent widget',
    summary: 'Parent-owned',
    format: 'svg',
    executionMode: 'managed',
    libraries: [],
    bytes: 1,
    sha256: 'a'.repeat(64),
    createdAtMs: 1,
  }
  const parent = {
    key: 'other-parent-context',
    hostPanelId: 'parent-panel',
    threadId: 'parent-thread',
    references: [widget],
    previews: [],
    api: { read, content },
    mcpApps: { invoke },
    invalidated: false,
    listingStatus: 'loaded',
    reload: vi.fn(),
    isCurrent: () => true,
    addReference: vi.fn(),
    sendPrompt,
  } as unknown as ConversationWidgetsValue
  const host = props()
  host.conversationMessages = [
    {
      id: 'original-answer',
      subtaskId: 'attempt',
      attemptId: 'attempt',
      turnId: 'turn',
      role: 'assistant',
      content: 'Original member answer\n::kcoder-widget{widget_id="parent-widget" revision=1}',
      status: 'done',
      createdAt: '',
    },
  ]
  render(
    <ConversationWidgetsContext.Provider value={parent}>
      <SubagentWorkspace {...host} />
    </ConversationWidgetsContext.Provider>
  )
  await waitFor(() =>
    expect(screen.getByTestId('subagent-workspace-records')).toHaveTextContent(
      'Original member answer'
    )
  )
  expect(await screen.findByTestId('widget-unavailable')).toBeInTheDocument()
  expect(screen.queryByTestId('forbidden-widget-host')).toBeNull()
  expect(sendPrompt).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
  expect(content).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

test('readonly closed observer shows the exact host unavailable reason without promising automatic reconnect',()=>{
 installTestTransport(()=>undefined)
 const host=props();host.connected=false;host.conversationError='Original exact member run is unavailable.'
 render(<SubagentWorkspace {...host}/>)
 expect(screen.getByTestId('subagent-workspace')).toHaveTextContent('Original exact member run is unavailable.')
 expect(screen.getByTestId('subagent-workspace')).not.toHaveTextContent('正在重新连接')
})
