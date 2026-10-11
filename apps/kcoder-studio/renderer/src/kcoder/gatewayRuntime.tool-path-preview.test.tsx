import '@/i18n'
import { act, render, screen } from '@testing-library/react'
import { listen } from '@tauri-apps/api/event'
import { describe, expect, test } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'

describe.each([Runtime, InstalledRuntime])(
  'real runtime transient preview projection',
  RuntimeClass => {
    test('renders only scoped transient text, rejects reordering, clears terminals and view switches', async () => {
      const client = new FakeGatewayClient('thread')
      const runtime = new RuntimeClass('token', {
        loadServers: async () => [localGatewayServer({ id: 'local' })],
        createClient: () => client,
      })
      const events: unknown[] = []
      const unlisten = await listen('local-executor:event', event => events.push(event.payload))
      const created = (await runtime.request('runtime.tasks.create', {
        taskId: 'draft',
        executionRequest: { prompt: 'edit' },
      })) as { taskId: string }
      const view = render(
        <ScrollableMessageArea
          messages={[]}
          toolsCatalogTaskId={created.taskId}
          toolsCatalogServerId="local"
        />
      )
      const send = async (
        method: string,
        sequence: number,
        extra: Record<string, unknown> = {}
      ) => {
        await act(async () => {
          client.emitNotification(method, {
            serverId: 'instance',
            threadId: 'thread',
            turnId: 'thread-turn',
            sequence,
            ...extra,
          })
          await new Promise(resolve => setTimeout(resolve, 0))
        })
      }
      const preview = (sequence: number, path: string | null, attempt = 'a') =>
        send('item/event', sequence, {
          event: { type: 'tool_path_preview', attempt_id: attempt, id: 'tool', path },
        })
      try {
        await send('turn/started', 1)
        events.splice(0)
        const storageBefore = JSON.stringify(localStorage)
        await preview(2, '<img src=x onerror=alert(1)>\nfile')
        expect(screen.getByTestId('tool-path-preview')).toHaveTextContent(
          '准备修改 <img src=x onerror=alert(1)>\\u000afile'
        )
        expect(view.container.querySelector('img')).toBeNull()
        expect(events).toEqual([])
        expect(JSON.stringify(localStorage)).toBe(storageBefore)
        await preview(4, 'new.ts', 'b')
        await preview(3, null)
        await preview(5, null)
        expect(screen.getByTestId('tool-path-preview')).toHaveTextContent('new.ts')
        await preview(6, null, 'b')
        expect(screen.queryByTestId('tool-path-preview')).toBeNull()
        await preview(7, 'visible.ts', 'b')
        view.rerender(
          <ScrollableMessageArea
            messages={[]}
            toolsCatalogTaskId={created.taskId}
            toolsCatalogServerId="remote"
          />
        )
        expect(screen.queryByTestId('tool-path-preview')).toBeNull()
        await preview(8, 'late.ts', 'b')
        view.rerender(
          <ScrollableMessageArea
            messages={[]}
            toolsCatalogTaskId={created.taskId}
            toolsCatalogServerId="local"
          />
        )
        expect(screen.queryByTestId('tool-path-preview')).toBeNull()
        await send('turn/started', 9, { turnId: 'next' })
        await send('item/event', 10, {
          turnId: 'next',
          event: {
            type: 'tool_path_preview',
            attempt_id: 'c',
            id: 'tool',
            path: 'next.ts',
          },
        })
        expect(screen.getByTestId('tool-path-preview')).toHaveTextContent('next.ts')
        await send('turn/completed', 11, {
          turnId: 'next',
          turn: { id: 'next', status: 'completed' },
        })
        await send('item/event', 12, {
          turnId: 'next',
          event: {
            type: 'tool_path_preview',
            attempt_id: 'c',
            id: 'tool',
            path: 'late.ts',
          },
        })
        expect(screen.queryByTestId('tool-path-preview')).toBeNull()
        await send('turn/started', 13, { turnId: 'third' })
        await send('item/event', 14, {
          turnId: 'third',
          event: {
            type: 'tool_path_preview',
            attempt_id: 'd',
            id: 'tool',
            path: 'third.ts',
          },
        })
        expect(screen.getByTestId('tool-path-preview')).toHaveTextContent('third.ts')
        await send('server/disconnected', 15)
        expect(screen.queryByTestId('tool-path-preview')).toBeNull()
        await send('item/event', 16, {
          turnId: 'third',
          event: {
            type: 'tool_path_preview',
            attempt_id: 'd',
            id: 'tool',
            path: 'late.ts',
          },
        })
        expect(screen.queryByTestId('tool-path-preview')).toBeNull()
      } finally {
        view.unmount()
        unlisten()
        await act(async () => {
          await runtime.dispose()
        })
      }
    })

    test('does not project previews from a server without the capability', async () => {
      const client = new FakeGatewayClient('thread')
      client.supportsExperimental = () => false
      const runtime = new RuntimeClass('token', {
        loadServers: async () => [localGatewayServer({ id: 'local' })],
        createClient: () => client,
      })
      try {
        const created = (await runtime.request('runtime.tasks.create', {
          taskId: 'draft',
          executionRequest: { prompt: 'edit' },
        })) as { taskId: string }
        const view = render(
          <ScrollableMessageArea
            messages={[]}
            toolsCatalogTaskId={created.taskId}
            toolsCatalogServerId="local"
          />
        )
        await act(async () => {
          client.emitNotification('turn/started', {
            serverId: 'instance',
            threadId: 'thread',
            turnId: 'thread-turn',
            sequence: 1,
          })
          client.emitNotification('item/event', {
            serverId: 'instance',
            threadId: 'thread',
            turnId: 'thread-turn',
            sequence: 2,
            event: { type: 'tool_path_preview', attempt_id: 'a', id: 'tool', path: 'hidden.ts' },
          })
          await new Promise(resolve => setTimeout(resolve, 0))
        })
        expect(screen.queryByTestId('tool-path-preview')).toBeNull()
        view.unmount()
      } finally {
        await act(async () => {
          await runtime.dispose()
        })
      }
    })
  }
)
