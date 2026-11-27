import { expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from './accountContextEvents'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'

test('Wiki requests use the explicit SSH target and never silently use local', async () => {
  const client = new FakeGatewayClient(null)
  const connections: string[] = []
  const request = vi.spyOn(client, 'request').mockResolvedValue({ enabled: false } as never)
  const capability = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name === 'knowledgeCatalogV1')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [
      { id: 'local', label: 'Local', description: '', transport: 'local', workspacePath: '/local' },
      {
        id: 'remote',
        label: 'Remote',
        description: '',
        transport: 'ssh',
        host: 'remote.test',
        workspacePath: '/remote',
      },
    ],
    createClient: id => {
      connections.push(id)
      return client
    },
  })
  try {
    await expect(
      runtime.request('runtime.knowledge.request', {
        serverId: 'remote',
        method: 'knowledge/status',
      })
    ).resolves.toEqual({ enabled: false })
    expect(connections).toEqual(['remote'])
    expect(request).toHaveBeenCalledWith('knowledge/status', {})
    const controller = new AbortController()
    await runtime.request(
      'runtime.knowledge.request',
      {
        serverId: 'remote',
        method: 'knowledge/status',
      },
      { signal: controller.signal }
    )
    expect(request).toHaveBeenLastCalledWith('knowledge/status', {}, { signal: controller.signal })
    request.mockClear()
    await expect(
      runtime.request('runtime.knowledge.request', {
        serverId: 'remote',
        method: 'knowledge/source/importAttachment',
        params: {
          title: 'source.HTML',
          attachmentPath: '/staged/source',
          libraryId: 'wiki',
          idempotencyKey: 'html',
        },
      })
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    capability.mockImplementation(
      name => name === 'knowledgeCatalogV1' || name === 'knowledgeHtmlV1'
    )
    await runtime.request('runtime.knowledge.request', {
      serverId: 'remote',
      method: 'knowledge/source/importAttachment',
      params: {
        title: 'source.htm',
        attachmentPath: '/staged/source',
        libraryId: 'wiki',
        idempotencyKey: 'html',
      },
    })
    expect(request).toHaveBeenCalledWith(
      'knowledge/source/importAttachment',
      expect.objectContaining({ title: 'source.htm' })
    )
    request.mockClear()
    capability.mockReturnValue(false)
    await expect(
      runtime.request('runtime.knowledge.request', {
        serverId: 'remote',
        method: 'knowledge/configure',
        params: { enabled: true },
      })
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    await expect(
      runtime.request('runtime.knowledge.request', { method: 'knowledge/status' })
    ).rejects.toThrow()
  } finally {
    await runtime.dispose()
  }
})

test('account switch while opening a Wiki connection prevents dispatch', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const client = new FakeGatewayClient(null)
  const request = vi.spyOn(client, 'request')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => {
      await gate
      return [
        {
          id: 'wiki-owner',
          label: 'Wiki',
          description: '',
          transport: 'local',
          workspacePath: '/wiki',
        },
      ]
    },
    createClient: () => client,
  })
  try {
    const pending = runtime.request('runtime.knowledge.request', {
      serverId: 'wiki-owner',
      method: 'knowledge/create',
      params: { name: 'Private' },
    })
    const rejected = expect(pending).rejects.toThrow()
    notifyAccountContextChange('wiki-owner')
    release()
    await rejected
    expect(request.mock.calls.some(([method]) => method === 'knowledge/create')).toBe(false)
  } finally {
    await runtime.dispose()
  }
})

test('durable image import recovery is explicitly capability gated on the selected target', async () => {
  const client = new FakeGatewayClient(null)
  const request = vi
    .spyOn(client, 'request')
    .mockResolvedValue({ supported: true, items: [], nextAfterId: null } as never)
  const capability = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name === 'knowledgeCatalogV1')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [
      { id: 'local', label: 'Local', description: '', transport: 'local', workspacePath: '/local' },
    ],
    createClient: () => client,
  })
  try {
    await expect(
      runtime.request('runtime.knowledge.request', {
        serverId: 'local',
        method: 'knowledge/imageImport/list',
        params: { libraryId: 'library' },
      })
    ).resolves.toEqual({ supported: false, items: [], nextAfterId: null })
    await expect(
      runtime.request('runtime.knowledge.request', {
        serverId: 'local',
        method: 'knowledge/imageImport/resume',
        params: { libraryId: 'library', importId: 'same' },
      })
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    capability.mockImplementation(name =>
      ['knowledgeCatalogV1', 'knowledgeImageImportV1'].includes(name)
    )
    await runtime.request('runtime.knowledge.request', {
      serverId: 'local',
      method: 'knowledge/imageImport/resume',
      params: { libraryId: 'library', importId: 'same', additionalCallBudget: 0 },
    })
    expect(request).toHaveBeenCalledWith('knowledge/imageImport/resume', {
      libraryId: 'library',
      importId: 'same',
      additionalCallBudget: 0,
    })
  } finally {
    await runtime.dispose()
  }
})

test('verification findings and pending units stay off targets without the capability', async () => {
  const client = new FakeGatewayClient(null)
  const request = vi
    .spyOn(client, 'request')
    .mockResolvedValue({ items: [], nextAfterId: null } as never)
  const capability = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => ['knowledgeCatalogV1', 'knowledgeIngestV1'].includes(name))
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [
      { id: 'local', label: 'Local', description: '', transport: 'local', workspacePath: '/local' },
    ],
    createClient: () => client,
  })
  const call = (method: string, params: Record<string, unknown>) =>
    runtime.request('runtime.knowledge.request', { serverId: 'local', method, params })
  try {
    for (const method of ['knowledge/findings/list', 'knowledge/pending/list'])
      await expect(call(method, { libraryId: 'wiki' })).resolves.toEqual({
        supported: false,
        items: [],
        nextAfterId: null,
      })
    await expect(
      call('knowledge/findings/decide', {
        libraryId: 'wiki',
        findingId: 'f',
        expectedRevision: 'r',
        decision: 'confirm',
        idempotencyKey: 'k',
      })
    ).rejects.toThrow()
    await expect(
      call('knowledge/pending/organize', {
        libraryId: 'wiki',
        pendingIds: ['p'],
        idempotencyKey: 'k',
        language: 'en',
      })
    ).rejects.toThrow()
    await expect(
      call('knowledge/job/resume', { libraryId: 'wiki', jobId: 'j', rebindOrganizationModel: true })
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    // The legacy two-field resume keeps working on older targets.
    await call('knowledge/job/resume', { libraryId: 'wiki', jobId: 'j' })
    expect(request).toHaveBeenLastCalledWith('knowledge/job/resume', {
      libraryId: 'wiki',
      jobId: 'j',
    })
    capability.mockImplementation(name =>
      ['knowledgeCatalogV1', 'knowledgeIngestV1', 'knowledgeVerificationFindingsV1'].includes(name)
    )
    await call('knowledge/findings/list', { libraryId: 'wiki', pageId: 'p', limit: 20 })
    expect(request).toHaveBeenLastCalledWith('knowledge/findings/list', {
      libraryId: 'wiki',
      pageId: 'p',
      limit: 20,
    })
    await call('knowledge/job/resume', { libraryId: 'wiki', jobId: 'j', reorganize: true })
    expect(request).toHaveBeenLastCalledWith('knowledge/job/resume', {
      libraryId: 'wiki',
      jobId: 'j',
      reorganize: true,
    })
  } finally {
    await runtime.dispose()
  }
})
