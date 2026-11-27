import { expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
import { notifyAccountContextChange } from './accountContextEvents'

const target = {
  id: 'remote',
  label: 'Remote',
  runtime: 'kcoder' as const,
  description: '',
  transport: 'ssh' as const,
  host: 'remote.test',
  workspacePath: '/owned',
}

test('background batch execution and historical selections require their negotiated capability', async () => {
  const client = new FakeGatewayClient(null)
  const supports = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(capability => capability !== 'migrationBatchWorkersV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  try {
    for (const [method, params] of [
      ['migration/batch/read', { jobId: 'job' }],
      [
        'migration/batch/run',
        { jobId: 'job', planId: 'plan', requestId: 'owned', expectedSequence: 3, mode: 'resume' },
      ],
      [
        'migration/batch/scan',
        { sourceIds: [], historySources: [{ catalogId: 'catalog', sourceHandle: 'selection' }] },
      ],
    ] as const)
      await expect(
        runtime.request('runtime.migration.request', { deviceId: 'remote', method, params })
      ).rejects.toThrow('migration_batch_workers_update_required')
    expect(request).not.toHaveBeenCalled()
    supports.mockReturnValue(true)
    const options = { signal: new AbortController().signal }
    await runtime.request(
      'runtime.migration.request',
      { deviceId: 'remote', method: 'migration/batch/read', params: { jobId: 'job' } },
      options
    )
    expect(request).toHaveBeenLastCalledWith('migration/batch/read', { jobId: 'job' }, options)
  } finally {
    await runtime.dispose()
  }
})

test('history search requires its independent capability before contacting an older host', async () => {
  const client = new FakeGatewayClient(null)
  const supports = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(capability => capability !== 'migrationHistorySearchV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({ items: [] } as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const params = { jobId: 'source', viewId: null, query: 'long body', cursor: null, limit: 10 }
  try {
    await expect(
      runtime.request('runtime.migration.request', {
        deviceId: 'remote',
        method: 'migration/history/search',
        params,
      })
    ).rejects.toThrow('migration_history_search_update_required')
    expect(request).not.toHaveBeenCalled()
    await runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method: 'migration/history/transcript',
      params: { jobId: 'source' },
    })
    expect(request).toHaveBeenLastCalledWith('migration/history/transcript', { jobId: 'source' })
    supports.mockReturnValue(true)
    await runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method: 'migration/history/search',
      params,
    })
    expect(request).toHaveBeenLastCalledWith('migration/history/search', params)
  } finally {
    await runtime.dispose()
  }
})

test('history search forwards branch identity, sealed continuation and AbortSignal as a read', async () => {
  const client = new FakeGatewayClient(null)
  const capabilities = new Set([
    'migrationProvidersV1',
    'migrationHistoryJobsV1',
    'migrationHistorySearchV1',
  ])
  vi.spyOn(client, 'supportsExperimental').mockImplementation(capability =>
    capabilities.has(capability)
  )
  const result = {
    items: [{ position: 3, record: 19, bodyCursor: 'sealed-body' }],
    nextCursor: 'sealed-next',
  }
  const request = vi.spyOn(client, 'request').mockResolvedValue(result as never)
  const connections: string[] = []
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: (id, _token, _channel, workspace) => {
      connections.push(`${id}:${workspace}`)
      return client
    },
  })
  const options = { signal: new AbortController().signal }
  const params = {
    jobId: 'source',
    viewId: 'selected-branch',
    query: '正文😀',
    caseSensitive: true,
    cursor: 'sealed-next',
    limit: 2,
  }
  try {
    await expect(
      runtime.request(
        'runtime.migration.request',
        {
          deviceId: 'remote',
          workspacePath: '/owned/project',
          method: 'migration/history/search',
          params,
        },
        options
      )
    ).resolves.toBe(result)
    expect(connections).toEqual(['remote:/owned/project'])
    expect(request).toHaveBeenCalledExactlyOnceWith('migration/history/search', params, options)
    expect(params.cursor).toBe('sealed-next')
  } finally {
    await runtime.dispose()
  }
})

test('a search response cannot cross an account replacement and is not replayed', async () => {
  const client = new FakeGatewayClient(null)
  let finish!: (value: object) => void
  const request = vi.spyOn(client, 'request').mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve as typeof finish
      }) as never
  )
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  try {
    const pending = runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method: 'migration/history/search',
      params: { jobId: 'source', query: 'private' },
    })
    const rejected = expect(pending).rejects.toThrow(
      /migration_scope_changed|Workspace scan invalidated|网关运行时已关闭/
    )
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    notifyAccountContextChange('remote')
    finish({ items: [{ matched: 'PRIVATE_OLD_ACCOUNT_BODY' }], nextCursor: null })
    await rejected
    expect(request).toHaveBeenCalledTimes(1)
  } finally {
    await runtime.dispose()
  }
})

test('a host missing the advertised search method fails without a legacy read or retry fallback', async () => {
  const client = new FakeGatewayClient(null)
  const request = vi
    .spyOn(client, 'request')
    .mockRejectedValue(new Error('Method not found: migration/history/search'))
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  try {
    await expect(
      runtime.request('runtime.migration.request', {
        deviceId: 'remote',
        method: 'migration/history/search',
        params: { jobId: 'source', query: 'needle' },
      })
    ).rejects.toThrow('Method not found')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe('migration/history/search')
  } finally {
    await runtime.dispose()
  }
})

test('continuation creation is separately negotiated and only receipt observations are abortable', async () => {
  const client = new FakeGatewayClient(null),
    supports = vi
      .spyOn(client, 'supportsExperimental')
      .mockImplementation(name => name !== 'migrationContinuationV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [target],
      createClient: () => client,
    }),
    options = { signal: new AbortController().signal }
  const invoke = (operation: string) =>
    runtime.request(
      'runtime.migration.request',
      {
        deviceId: 'remote',
        method: `migration/history/continuation/${operation}`,
        params: { jobId: 'job' },
      },
      options
    )
  try {
    for (const operation of ['create', 'read', 'run', 'resume', 'cancel'])
      await expect(invoke(operation)).rejects.toThrow('migration_continuation_update_required')
    expect(request).not.toHaveBeenCalled()
    supports.mockReturnValue(true)
    await invoke('read')
    expect(request.mock.calls.at(-1)).toEqual([
      'migration/history/continuation/read',
      { jobId: 'job' },
      options,
    ])
    for (const operation of ['create', 'run', 'resume', 'cancel']) {
      await invoke(operation)
      expect(request.mock.calls.at(-1)).toHaveLength(2)
    }
  } finally {
    await runtime.dispose()
  }
})

test('history archives require their own capability and only observations accept AbortSignal', async () => {
  const client = new FakeGatewayClient(null)
  const supports = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(capability => capability !== 'migrationHistoryJobsV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const options = { signal: new AbortController().signal }
  const send = (method: string) =>
    runtime.request(
      'runtime.migration.request',
      { deviceId: 'remote', method, params: {} },
      options
    )
  try {
    await expect(send('migration/history/create')).rejects.toThrow('migration_update_required')
    expect(request.mock.calls.some(call => call[0].startsWith('migration/history/'))).toBe(false)
    supports.mockReturnValue(true)
    for (const name of ['discover', 'sources', 'read', 'jobs']) {
      await send(`migration/history/${name}`)
      expect(request).toHaveBeenLastCalledWith(`migration/history/${name}`, {}, options)
    }
    for (const name of ['create', 'run', 'resume', 'cancel']) {
      await send(`migration/history/${name}`)
      expect(request).toHaveBeenLastCalledWith(`migration/history/${name}`, {})
    }
  } finally {
    await runtime.dispose()
  }
})

test('transcript viewing is separately negotiated and never turns an archive job capability into content access', async () => {
  const client = new FakeGatewayClient(null)
  const supports = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name !== 'migrationHistoryReadV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const options = { signal: new AbortController().signal }
  const send = (name: string) =>
    runtime.request(
      'runtime.migration.request',
      { deviceId: 'remote', method: `migration/history/${name}`, params: { jobId: 'job' } },
      options
    )
  try {
    for (const name of ['transcript', 'blocks', 'text'])
      await expect(send(name)).rejects.toThrow('migration_history_read_update_required')
    expect(
      request.mock.calls.some(call =>
        [
          'migration/history/transcript',
          'migration/history/blocks',
          'migration/history/text',
        ].includes(call[0])
      )
    ).toBe(false)
    supports.mockReturnValue(true)
    for (const name of ['transcript', 'blocks', 'text']) {
      await send(name)
      expect(request).toHaveBeenLastCalledWith(
        `migration/history/${name}`,
        { jobId: 'job' },
        options
      )
    }
  } finally {
    await runtime.dispose()
  }
})

test('branch derivation has its own capability and persistent controls keep unknown-outcome semantics', async () => {
  const client = new FakeGatewayClient(null)
  const supports = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name !== 'migrationHistoryBranchesV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const options = { signal: new AbortController().signal }
  const send = (name: string) =>
    runtime.request(
      'runtime.migration.request',
      { deviceId: 'remote', method: `migration/history/branch/${name}`, params: { jobId: 'job' } },
      options
    )
  try {
    await expect(send('prepare')).rejects.toThrow('migration_branch_update_required')
    expect(request.mock.calls.some(call => call[0].startsWith('migration/history/branch/'))).toBe(
      false
    )
    supports.mockReturnValue(true)
    for (const name of ['read', 'page', 'blocks', 'text']) {
      await send(name)
      expect(request).toHaveBeenLastCalledWith(
        `migration/history/branch/${name}`,
        { jobId: 'job' },
        options
      )
    }
    for (const name of ['prepare', 'run', 'cancel', 'resume']) {
      await send(name)
      expect(request).toHaveBeenLastCalledWith(`migration/history/branch/${name}`, { jobId: 'job' })
    }
  } finally {
    await runtime.dispose()
  }
})

test('historical tool correlation requires a separate capability and only its observations are abortable', async () => {
  const client = new FakeGatewayClient(null)
  const supports = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name !== 'migrationBranchToolsV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const options = { signal: new AbortController().signal }
  const send = (name: string) =>
    runtime.request(
      'runtime.migration.request',
      {
        deviceId: 'remote',
        method: `migration/history/branch/tools/${name}`,
        params: { jobId: 'job', viewId: 'view' },
      },
      options
    )
  try {
    await expect(send('run')).rejects.toThrow('migration_branch_tools_update_required')
    expect(
      request.mock.calls.some(call => call[0].startsWith('migration/history/branch/tools/'))
    ).toBe(false)
    supports.mockReturnValue(true)
    for (const name of ['read', 'page']) {
      await send(name)
      expect(request).toHaveBeenLastCalledWith(
        `migration/history/branch/tools/${name}`,
        { jobId: 'job', viewId: 'view' },
        options
      )
    }
    for (const name of ['run', 'resume', 'cancel']) {
      await send(name)
      expect(request).toHaveBeenLastCalledWith(`migration/history/branch/tools/${name}`, {
        jobId: 'job',
        viewId: 'view',
      })
    }
  } finally {
    await runtime.dispose()
  }
})

test('batch MCP private choices require separate capability and empty choices preserve legacy plans', async () => {
  const client = new FakeGatewayClient(null)
  const supports = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(capability => capability !== 'migrationBatchMcpCredentialsV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const params = {
    jobId: 'job',
    expectedSequence: 1,
    choices: [],
    mcpCredentials: [
      {
        itemId: 'mcp',
        fields: [{ kind: 'environment', name: 'TOKEN' }],
        consentPrivateValues: true,
      },
    ],
  }
  const send = (method: string, params: object, options?: { signal?: AbortSignal }) =>
    runtime.request('runtime.migration.request', { deviceId: 'remote', method, params }, options)
  try {
    await expect(send('migration/batch/plan', params)).rejects.toThrow('migration_update_required')
    await expect(send('migration/batch/mcp/credential/read', { jobId: 'job' })).rejects.toThrow(
      'migration_update_required'
    )
    expect(request.mock.calls.some(call => call[0].startsWith('migration/'))).toBe(false)
    await send('migration/batch/plan', { ...params, mcpCredentials: [] })
    expect(request).toHaveBeenLastCalledWith('migration/batch/plan', {
      jobId: 'job',
      expectedSequence: 1,
      choices: [],
    })
    supports.mockReturnValue(true)
    await send('migration/batch/plan', params)
    expect(request).toHaveBeenLastCalledWith('migration/batch/plan', params)
    const options = { signal: new AbortController().signal }
    await send('migration/batch/mcp/credential/read', { jobId: 'job' }, options)
    expect(request).toHaveBeenLastCalledWith(
      'migration/batch/mcp/credential/read',
      { jobId: 'job' },
      options
    )
  } finally {
    await runtime.dispose()
  }
})

test('template reuse requires its own capability while legacy template imports and Provider reuse stay available', async () => {
  const client = new FakeGatewayClient(null)
  vi.spyOn(client, 'supportsExperimental').mockImplementation(
    capability => capability !== 'migrationTemplateReuseV1'
  )
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const template = {
    kind: 'template',
    itemId: 'template',
    targetName: 'review',
    providerItemId: 'provider',
  }
  const plan = (choices: object[], reuseExisting: boolean) =>
    runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method: 'migration/batch/plan',
      params: { jobId: 'job', expectedSequence: 1, choices, reuseExisting },
    })
  try {
    await expect(plan([template], true)).rejects.toThrow('migration_template_reuse_update_required')
    expect(request.mock.calls.some(call => call[0] === 'migration/batch/plan')).toBe(false)
    await plan([template], false)
    await plan(
      [
        {
          kind: 'provider',
          itemId: 'provider',
          targetName: 'Office',
          contextWindowTokens: 64000,
          outputHeadroomTokens: 8192,
          maxOutputTokens: 8192,
        },
      ],
      true
    )
    await runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method: 'migration/batch/item/plan',
      params: { jobId: 'job', itemId: 'provider', includeTemplate: true },
    })
    expect(request).toHaveBeenLastCalledWith('migration/batch/item/plan', {
      jobId: 'job',
      itemId: 'provider',
    })
    expect(request.mock.calls.filter(call => call[0] === 'migration/batch/plan')).toHaveLength(2)
  } finally {
    await runtime.dispose()
  }
})

test('legacy targets keep ordinary item browsing while rejecting template mutations before send', async () => {
  const client = new FakeGatewayClient(null)
  vi.spyOn(client, 'supportsExperimental').mockImplementation(
    capability => capability !== 'migrationTemplatesV1'
  )
  const request = vi.spyOn(client, 'request').mockResolvedValue({ items: [] } as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  try {
    await runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method: 'migration/items',
      params: { jobId: 'job', pageIndex: 0, includeTemplates: true },
    })
    expect(request).toHaveBeenCalledWith('migration/items', { jobId: 'job', pageIndex: 0 })
    await expect(
      runtime.request('runtime.migration.request', {
        deviceId: 'remote',
        method: 'migration/batch/plan',
        params: {
          jobId: 'job',
          expectedSequence: 1,
          choices: [
            {
              kind: 'template',
              itemId: 'template',
              targetName: 'review',
              providerItemId: 'provider',
            },
          ],
        },
      })
    ).rejects.toThrow('migration_update_required')
    expect(request.mock.calls.some(call => call[0] === 'migration/batch/plan')).toBe(false)
  } finally {
    await runtime.dispose()
  }
})

test('capable targets receive explicit template candidates and choices without rewriting them', async () => {
  const client = new FakeGatewayClient(null)
  vi.spyOn(client, 'supportsExperimental').mockReturnValue(true)
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  try {
    const params = { jobId: 'job', pageIndex: 1, includeTemplates: true }
    await runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method: 'migration/items',
      params,
    })
    expect(request).toHaveBeenCalledWith('migration/items', params)
    const preview = { jobId: 'job', itemId: 'template', includeTemplate: true }
    await runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method: 'migration/batch/item/plan',
      params: preview,
    })
    expect(request).toHaveBeenLastCalledWith('migration/batch/item/plan', preview)
  } finally {
    await runtime.dispose()
  }
})

test('batch API key consent requires its own negotiated capability before sending a mutation', async () => {
  const client = new FakeGatewayClient(null)
  vi.spyOn(client, 'supportsExperimental').mockImplementation(
    capability => capability !== 'migrationBatchCredentialsV1'
  )
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  try {
    await expect(
      runtime.request('runtime.migration.request', {
        deviceId: 'remote',
        method: 'migration/batch/plan',
        params: {
          jobId: 'job',
          expectedSequence: 1,
          choices: [],
          credentials: [{ itemId: 'provider', source: 'configuration', consentApiKey: true }],
        },
      })
    ).rejects.toThrow('migration_update_required')
    expect(request.mock.calls.some(call => call[0] === 'migration/batch/plan')).toBe(false)
  } finally {
    await runtime.dispose()
  }
})
test('migration uses the explicitly selected target and rejects runtimes without the capability', async () => {
  const client = new FakeGatewayClient(null)
  const connections: string[] = []
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: (id, _token, _channel, workspace) => {
      connections.push(`${id}:${workspace}`)
      return client
    },
  })
  const request = vi.spyOn(client, 'request').mockResolvedValue({ sources: [] } as never)
  try {
    await runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      workspacePath: '/owned/project',
      method: 'migration/discover',
      params: { sources: ['codex'] },
    })
    expect(connections).toEqual(['remote:/owned/project'])
    expect(request).toHaveBeenCalledWith('migration/discover', { sources: ['codex'] })
    vi.spyOn(client, 'supportsExperimental').mockReturnValue(false)
    await expect(
      runtime.request('runtime.migration.request', {
        deviceId: 'remote',
        method: 'migration/provider/apply',
        params: {},
      })
    ).rejects.toThrow('migration_update_required')
    expect(request.mock.calls.some(call => call[0] === 'migration/provider/apply')).toBe(false)
  } finally {
    await runtime.dispose()
  }
})

test('a late mutation response cannot enter a replacement account and is never replayed', async () => {
  const client = new FakeGatewayClient(null)
  let finish!: (value: object) => void
  const request = vi.spyOn(client, 'request').mockImplementation(async method =>
    method === 'migration/provider/apply'
      ? (new Promise(resolve => {
          finish = resolve as typeof finish
        }) as never)
      : ({} as never)
  )
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  try {
    const pending = runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method: 'migration/provider/apply',
      params: { jobId: 'job', planId: 'plan', expectedSequence: 4 },
    })
    const rejected = expect(pending).rejects.toThrow(
      /migration_scope_changed|Workspace scan invalidated|网关运行时已关闭/
    )
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    notifyAccountContextChange('remote')
    finish({ status: 'committed' })
    await rejected
    expect(request.mock.calls.filter(call => call[0] === 'migration/provider/apply')).toHaveLength(
      1
    )
  } finally {
    await runtime.dispose()
  }
})

test('MCP private-field RPCs require their own capability and preserve legacy MCP browsing', async () => {
  const client = new FakeGatewayClient(null)
  const support = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(capability => capability !== 'migrationMcpCredentialsV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const invoke = (method: string) =>
    runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method,
      params: { jobId: 'job', expectedSequence: 1, planId: 'plan' },
    })
  try {
    for (const operation of ['read', 'plan', 'apply', 'undo']) {
      await expect(invoke(`migration/mcp/credential/${operation}`)).rejects.toThrow(
        'migration_update_required'
      )
    }
    expect(request).not.toHaveBeenCalled()
    await invoke('migration/read')
    support.mockReturnValue(true)
    await invoke('migration/mcp/credential/read')
    await invoke('migration/mcp/credential/apply')
    expect(request.mock.calls.map(call => call[0])).toEqual([
      'migration/read',
      'migration/mcp/credential/read',
      'migration/mcp/credential/apply',
    ])
  } finally {
    await runtime.dispose()
  }
})

test('historical attachment methods negotiate their own capability and keep chunk reads read-only', async () => {
  const client = new FakeGatewayClient(null)
  const support = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(value => value !== 'migrationHistoryAttachmentsV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const options = { signal: new AbortController().signal }
  const params = { selection: { jobId: 'job', position: 0, blockIndex: 0 } }
  const invoke = (method: string) =>
    runtime.request('runtime.migration.request', { deviceId: 'remote', method, params }, options)
  try {
    await expect(invoke('migration/history/attachment/read')).rejects.toThrow(
      'migration_history_attachments_update_required'
    )
    expect(request).not.toHaveBeenCalled()
    support.mockReturnValue(true)
    for (const operation of ['read', 'chunk', 'run', 'resume', 'cancel'])
      await invoke(`migration/history/attachment/${operation}`)
    expect(request.mock.calls.map(v => v[0])).toEqual(
      ['read', 'chunk', 'run', 'resume', 'cancel'].map(v => `migration/history/attachment/${v}`)
    )
    expect(request.mock.calls[0]).toEqual(['migration/history/attachment/read', params, options])
    expect(request.mock.calls[1]).toEqual(['migration/history/attachment/chunk', params, options])
    expect(request.mock.calls[2]).toEqual(['migration/history/attachment/run', params])
  } finally {
    await runtime.dispose()
  }
})

test('tool-result collections need a separate capability before any source work starts', async () => {
  const client = new FakeGatewayClient(null),
    supports = vi
      .spyOn(client, 'supportsExperimental')
      .mockImplementation(value => value !== 'migrationHistoryToolAttachmentsV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [target],
      createClient: () => client,
    }),
    options = { signal: new AbortController().signal }
  const invoke = (operation: string) =>
    runtime.request(
      'runtime.migration.request',
      {
        deviceId: 'remote',
        method: `migration/history/tool-attachments/${operation}`,
        params: { selection: { jobId: 'job', position: 1, blockIndex: 0 } },
      },
      options
    )
  try {
    for (const operation of ['read', 'run', 'resume', 'cancel', 'chunk', 'items'])
      await expect(invoke(operation)).rejects.toThrow(
        'migration_history_tool_attachments_update_required'
      )
    expect(request).not.toHaveBeenCalled()
    supports.mockReturnValue(true)
    for (const operation of ['read', 'items', 'chunk']) {
      await invoke(operation)
      expect(request.mock.calls.at(-1)?.[2]).toBe(options)
    }
    for (const operation of ['run', 'resume', 'cancel']) {
      await invoke(operation)
      expect(request.mock.calls.at(-1)).toHaveLength(2)
    }
  } finally {
    await runtime.dispose()
  }
})

test('native conversation provenance negotiates separately and remains an abortable read', async () => {
  const client = new FakeGatewayClient(null),
    supports = vi
      .spyOn(client, 'supportsExperimental')
      .mockImplementation(value => value !== 'migrationContinuationSourceV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({ source: null } as never)
  const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [target],
      createClient: () => client,
    }),
    options = { signal: new AbortController().signal }
  const params = { threadId: 'Ab123' },
    invoke = () =>
      runtime.request(
        'runtime.migration.request',
        { deviceId: 'remote', method: 'migration/history/continuation/source', params },
        options
      )
  try {
    await expect(invoke()).rejects.toThrow('migration_continuation_source_update_required')
    expect(request).not.toHaveBeenCalled()
    supports.mockReturnValue(true)
    await invoke()
    expect(request).toHaveBeenLastCalledWith(
      'migration/history/continuation/source',
      params,
      options
    )
  } finally {
    await runtime.dispose()
  }
})

test('undo capability is independent and mutations never inherit a read AbortSignal', async () => {
  const client = new FakeGatewayClient(null)
  const supports = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(capability => capability !== 'migrationContinuationUndoV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const options = { signal: new AbortController().signal }
  try {
    await expect(
      runtime.request(
        'runtime.migration.request',
        {
          deviceId: 'remote',
          method: 'migration/history/undo/lookup',
          params: { continuationJobId: 'source' },
        },
        options
      )
    ).rejects.toThrow('migration_history_undo_update_required')
    expect(request).not.toHaveBeenCalled()
    supports.mockReturnValue(true)
    for (const action of ['lookup', 'preview', 'read']) {
      await runtime.request(
        'runtime.migration.request',
        {
          deviceId: 'remote',
          method: `migration/history/undo/${action}`,
          params: { jobId: 'owned' },
        },
        options
      )
      expect(request).toHaveBeenLastCalledWith(
        `migration/history/undo/${action}`,
        { jobId: 'owned' },
        options
      )
    }
    for (const action of ['create', 'run', 'cancel']) {
      await runtime.request(
        'runtime.migration.request',
        {
          deviceId: 'remote',
          method: `migration/history/undo/${action}`,
          params: { jobId: 'owned' },
        },
        options
      )
      expect(request).toHaveBeenLastCalledWith(`migration/history/undo/${action}`, {
        jobId: 'owned',
      })
    }
  } finally {
    await runtime.dispose()
  }
})

test('plugin batch choices require their separate capability before mutation dispatch', async () => {
  const client = new FakeGatewayClient(null)
  const supports = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name !== 'migrationBatchPluginsV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const params = {
    jobId: 'job',
    expectedSequence: 1,
    choices: [{ kind: 'plugin', itemId: 'plugin', targetName: 'office-helper' }],
  }
  try {
    await expect(
      runtime.request('runtime.migration.request', {
        deviceId: 'remote',
        method: 'migration/batch/plan',
        params,
      })
    ).rejects.toThrow('migration_batch_plugins_update_required')
    expect(request).not.toHaveBeenCalled()
    supports.mockReturnValue(true)
    await runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method: 'migration/batch/plan',
      params,
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]).toEqual(['migration/batch/plan', params])
  } finally {
    await runtime.dispose()
  }
})

test('prepared plugin scan selectors negotiate batch support and never forward unsupported mutations', async () => {
  const client = new FakeGatewayClient(null)
  const supports = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name !== 'migrationBatchPluginsV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const params = {
    sourceIds: [],
    pluginSources: [{ operationId: 'owned-plugin', expectedSequence: 3 }],
  }
  try {
    await expect(
      runtime.request('runtime.migration.request', {
        deviceId: 'remote',
        method: 'migration/batch/scan',
        params,
      })
    ).rejects.toThrow('migration_batch_plugins_update_required')
    expect(request).not.toHaveBeenCalled()
    supports.mockReturnValue(true)
    await runtime.request('runtime.migration.request', {
      deviceId: 'remote',
      method: 'migration/batch/scan',
      params,
    })
    expect(request).toHaveBeenCalledExactlyOnceWith('migration/batch/scan', params)
  } finally {
    await runtime.dispose()
  }
})

test('project plugin opt-in uses the existing localized upgrade boundary before dispatch', async () => {
  const client = new FakeGatewayClient(null)
  vi.spyOn(client, 'supportsExperimental').mockImplementation(
    capability => capability !== 'migrationPluginProjectsV1'
  )
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  try {
    for (const [method, params] of [
      ['migration/plugin/discover', { sources: ['codex'], includeProject: true }],
      [
        'migration/plugin/plan',
        { requestId: 'owned', candidateId: 'opaque', projectMapping: 'current_workspace' },
      ],
    ] as const)
      await expect(
        runtime.request('runtime.migration.request', { deviceId: 'remote', method, params })
      ).rejects.toThrow('migration_plugins_update_required')
    expect(request).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
})

test('history concurrency is projected from current target capability and never guessed from a version', async () => {
  for (const [capacity, expected] of [[0, 1], [32, 32], [64, 64]] as const) {
    const client = new FakeGatewayClient(null)
    vi.spyOn(client, 'supportsExperimental').mockImplementation(
      capability =>
        capability === 'migrationHistoryConcurrency64V1'
          ? capacity === 64
          : capability === 'migrationHistoryConcurrency32V1'
            ? capacity >= 32
            : true
    )
    const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [target],
      createClient: () => client,
    })
    try {
      await expect(
        runtime.request('runtime.migration.request', {
          deviceId: target.id,
          method: 'migration/history/concurrency',
          params: {},
        })
      ).resolves.toEqual({ maxConcurrentJobs: expected, requiresUpdate: capacity !== 64 })
      expect(request).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  }
})

test('readable reconstruction requires its own capability before any branch mutation', async () => {
  const client = new FakeGatewayClient(null)
  const supports = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== 'migrationHistoryReconstructionV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  const params = { jobId: 'job', relatedJobIds: [], reconstructReadable: true }
  const invoke = () => runtime.request('runtime.migration.request', { deviceId: 'remote', method: 'migration/history/branch/prepare', params })
  try {
    await expect(invoke()).rejects.toThrow('migration_history_reconstruction_update_required')
    expect(request).not.toHaveBeenCalled()
    supports.mockReturnValue(true)
    await invoke()
    expect(request).toHaveBeenLastCalledWith('migration/history/branch/prepare', params)
  } finally { await runtime.dispose() }
})
