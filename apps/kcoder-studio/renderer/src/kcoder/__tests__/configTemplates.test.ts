import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/tauri/localExecutor', () => ({
  requestLocalExecutor: vi.fn(async () => ({ templates: [], defaultId: undefined })),
}))

import { requestLocalExecutor } from '@/tauri/localExecutor'
import {
  deleteSettingsTemplate,
  listSettingsTemplates,
  readSettingsTemplate,
  saveSettingsTemplate,
  setDefaultSettingsTemplate,
} from '@/kcoder/configTemplates'

const request = vi.mocked(requestLocalExecutor)

describe('settings template service', () => {
  beforeEach(() => request.mockClear())

  it('addresses the settings template catalog through the runtime envelope', async () => {
    await listSettingsTemplates('server-1')
    expect(request).toHaveBeenLastCalledWith('runtime.settings.request', {
      serverId: 'server-1',
      method: 'settings/templates/list',
      params: {},
    })
  })

  it('sends drafts, reads, deletes and default switches with their ids', async () => {
    await saveSettingsTemplate('server-1', { name: 'Fast local', content: '{}\n' })
    expect(request).toHaveBeenLastCalledWith('runtime.settings.request', {
      serverId: 'server-1',
      method: 'settings/templates/save',
      params: { name: 'Fast local', content: '{}\n' },
    })

    await readSettingsTemplate('server-1', 'fast-local')
    expect(request).toHaveBeenLastCalledWith('runtime.settings.request', {
      serverId: 'server-1',
      method: 'settings/templates/read',
      params: { id: 'fast-local' },
    })

    await deleteSettingsTemplate('server-1', 'fast-local')
    expect(request).toHaveBeenLastCalledWith('runtime.settings.request', {
      serverId: 'server-1',
      method: 'settings/templates/delete',
      params: { id: 'fast-local' },
    })

    await setDefaultSettingsTemplate('server-1', null)
    expect(request).toHaveBeenLastCalledWith('runtime.settings.request', {
      serverId: 'server-1',
      method: 'settings/templates/default',
      params: { id: null },
    })
  })
})
