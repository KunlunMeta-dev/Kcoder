import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { NativeTaskWorkspace } from '../NativeTaskWorkspace'
import { installTaskWorkspaceGateway, localServer } from '../gatewayFixture.test-support'
import { taskWorkspaceResources } from '../locales'
import { taskCollaborationResources } from './locales'
vi.mock('@/kcoder/gatewayRpc', async original => ({
  ...(await original<object>()),
  fetchGatewayServers: async () => [localServer],
}))
let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  cleanup()
  await dispose?.()
  dispose = undefined
  clearTestTransports()
  vi.restoreAllMocks()
})
test('task board does not expose collaboration authoring and keeps original task reads nonexecuting', async () => {
  localStorage.clear()
  installTestTransport(() => undefined)
  const gateway = installTaskWorkspaceGateway()
  dispose = gateway.dispose
  const create = vi.fn()
  const i18n = createInstance()
  await i18n.init({
    lng: 'zh-CN',
    resources: {
      'zh-CN': {
        taskWorkspace: taskWorkspaceResources['zh-CN'],
        taskCollaboration: taskCollaborationResources['zh-CN'],
      },
    },
    interpolation: { escapeValue: false },
  })
  const target = { serverId: 'local', workspacePath: '/owned-workspace' }
  render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <NativeTaskWorkspace
          target={target}
          tasks={[
            {
              threadId: 'original-thread',
              title: 'Original task',
              workspacePath: '/owned-workspace',
            },
          ]}
          onCreateCollaboration={create}
        />
      </I18nextProvider>
    </StrictMode>
  )
  expect(screen.queryByTestId('task-workspace-create-collaboration')).toBeNull()
  expect(create).not.toHaveBeenCalled()
  expect(gateway.calls).toHaveLength(0)
  fireEvent.change(screen.getByTestId('task-workspace-thread-select'), {
    target: { value: JSON.stringify(['original-thread', '/owned-workspace']) },
  })
  await waitFor(() =>
    expect(screen.getByTestId('task-workspace-root-status')).toHaveTextContent('notLoaded')
  )
  expect(screen.queryByTestId('task-workspace-create-collaboration')).toBeNull()
  expect(create).not.toHaveBeenCalled()
  expect(
    gateway.client.requests.some(call =>
      ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)
    )
  ).toBe(false)
})
