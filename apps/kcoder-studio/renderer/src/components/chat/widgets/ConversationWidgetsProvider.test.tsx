import { useContext } from 'react'
import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WidgetRequest } from '@/kcoder/widgetApi'
import { ConversationWidgetsProvider } from './ConversationWidgetsProvider'
import { ConversationWidgetsContext } from './widgetContext'

const request = vi.fn(async () => ({ widgets: [], nextOffset: null })) as WidgetRequest
const address: RuntimeTaskAddress = {
  deviceId: 'local',
  taskId: 'owned-task',
  threadId: 'owned-thread',
  workspacePath: `D:/${'deep-owned-workspace/'.repeat(30)}`,
}

function Witness({ name }: { name: string }) {
  const context = useContext(ConversationWidgetsContext)!
  return <output data-testid={name} data-panel-id={context.hostPanelId} data-scope={context.key} />
}

function Pane({ name, owner = address }: { name: string; owner?: RuntimeTaskAddress }) {
  return (
    <ConversationWidgetsProvider address={owner} messages={[]} request={request} onSendPrompt={() => {}}>
      <Witness name={name} />
    </ConversationWidgetsProvider>
  )
}

test('deep workspace panes keep bounded native ownership IDs and independent peer mounts', () => {
  render(<><Pane name="one" /><Pane name="two" /></>)
  const first = screen.getByTestId('one')
  const second = screen.getByTestId('two')
  const firstPanel = first.getAttribute('data-panel-id')!
  const secondPanel = second.getAttribute('data-panel-id')!
  expect(first.getAttribute('data-scope')).toBe(`local:owned-task:owned-thread:${address.workspacePath}`)
  expect(first.getAttribute('data-scope')!.length).toBeGreaterThan(256)
  expect(`${firstPanel}:probe`.length).toBeLessThanOrEqual(256)
  expect(`${secondPanel}:probe`.length).toBeLessThanOrEqual(256)
  expect(firstPanel).not.toBe(secondPanel)
  expect(firstPanel).not.toContain(address.workspacePath!)
  expect(second.getAttribute('data-scope')).toBe(first.getAttribute('data-scope'))
})

test('native mount identity stays stable for the same owner and rotates on thread or target changes', () => {
  const { rerender } = render(<Pane name="one" />)
  const initial = screen.getByTestId('one').getAttribute('data-panel-id')
  rerender(<Pane name="one" owner={{ ...address }} />)
  expect(screen.getByTestId('one').getAttribute('data-panel-id')).toBe(initial)
  rerender(<Pane name="one" owner={{ ...address, threadId: 'peer-thread' }} />)
  const peer = screen.getByTestId('one').getAttribute('data-panel-id')
  expect(peer).not.toBe(initial)
  expect(screen.getByTestId('one').getAttribute('data-scope')).toBe(`local:owned-task:peer-thread:${address.workspacePath}`)
  rerender(<Pane name="one" owner={{ ...address, deviceId: 'peer-target', threadId: 'peer-thread' }} />)
  expect(screen.getByTestId('one').getAttribute('data-panel-id')).not.toBe(peer)
  expect(screen.getByTestId('one').getAttribute('data-scope')).toBe(`peer-target:owned-task:peer-thread:${address.workspacePath}`)
})
