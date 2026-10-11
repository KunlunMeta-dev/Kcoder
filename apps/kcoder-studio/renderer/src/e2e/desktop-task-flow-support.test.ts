import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

interface TaskFlowArgsModule {
  parseTaskFlowArgs: (
    argv: string[],
    env: Record<string, string | undefined>
  ) => Record<string, unknown> & { memoryLimits: Record<string, number> }
}

interface TaskFlowFixturesModule {
  PLUGIN_NAME: string
  createPluginMarketplaceFixture: (root: string) => Promise<void>
}

interface TaskFlowCommandModule {
  createCommandSupport: (
    owner: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => {
    commandOutput: (command: string, args: string[]) => Promise<string>
    runChecked: (command: string, args: string[]) => Promise<void>
  }
  isExecutable: (path: string) => Promise<boolean>
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>
}

interface ProcessLauncherModule {
  createOwnedProcessLauncher: (options: Record<string, unknown>) => {
    launch: (options: Record<string, unknown>) => Promise<Record<string, unknown>>
  }
}

interface TaskFlowEvidenceModule {
  countTextOccurrences: (value: string, search: string) => number
  distanceFromBottom: (metrics: {
    scrollHeight: number
    clientHeight: number
    scrollTop: number
  }) => number
  memorySampleRangeKiB: (samples: Array<{ physicalFootprintKiB: number }>) => number
  medianMemorySample: <T extends { physicalFootprintKiB: number }>(samples: T[]) => T | null
  processGroup: (
    snapshot: { processMemory: { groups: Array<{ group: string }> } },
    groupName: string
  ) => { group: string } | null
}

interface TaskFlowModelProtocolModule {
  createModelProtocolHelpers: (config: Record<string, unknown>) => {
    createSse: (events: Array<{ type: string }>) => string
    codexRequestKind: (body: Record<string, unknown>) => string | null
    matrixPatch: (model: Record<string, string>) => string
    readRequestBody: (request: Readable) => Promise<Record<string, unknown>>
    json: (response: Record<string, unknown>, status: number, value: unknown) => void
    cors: (response: Record<string, unknown>) => void
    requestContainsToolOutput: (request: Record<string, unknown>) => boolean
    selectShellTool: (
      request: Record<string, unknown>,
      workspacePath: string
    ) => { name: string; arguments: Record<string, unknown> }
    selectApplyPatchTool: (request: Record<string, unknown>) => string
    selectCloudApplyPatchTool: (request: Record<string, unknown>) => string
    selectViewImageTool: (
      request: Record<string, unknown>,
      workspacePath: string
    ) => { name: string; arguments: Record<string, unknown> }
  }
}

interface TaskFlowControlModule {
  DesktopControlTransport: new (options: Record<string, unknown>) => {
    activeClientId: string | null
    commandHistory: unknown[]
    command: (action: string, selector: string) => Promise<unknown>
    handleRoute: (
      request: Readable & { method?: string },
      response: unknown,
      url: URL
    ) => Promise<boolean>
  }
}

interface TaskFlowModelStateModule {
  DesktopModelScenarioState: new (options: Record<string, unknown>) => {
    scenario: string
    matrixState: { stage: string } | null
    setScenario: (scenario: string) => void
    setMatrixCase: (model: Record<string, string>) => void
    recordRequest: (scenario: string, request: unknown) => void
    awaitRequest: (scenario: string) => Promise<unknown>
  }
  routeModelScenario: (scenario: string, routes: Record<string, () => unknown>) => unknown
}

interface TaskFlowAttachmentScenariosModule {
  createAttachmentScenarioHelpers: (deps: Record<string, unknown>) => {
    verifyPastedZipAttachment: (options: {
      composerSelector: string
      control: Record<string, unknown>
    }) => Promise<void>
  }
}

interface TaskFlowRuntimeScenariosModule {
  createRuntimeScenarioHelpers: (deps: Record<string, unknown>) => {
    verifyReconnectRecovery: (options: {
      composerSelector: string
      control: Record<string, unknown>
    }) => Promise<void>
  }
}

const temporaryDirectories: string[] = []

function desktopModule(name: string): string {
  return pathToFileURL(resolve(import.meta.dirname, `../../e2e/desktop/${name}`)).href
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))
  )
})

describe('desktop task-flow support', () => {
  test('routes desktop resources, child environments, logs and diagnostics through the lifecycle owner', async () => {
    const { createOwnedProcessLauncher } = (await import(
      /* @vite-ignore */ desktopModule('process-launcher.mjs')
    )) as ProcessLauncherModule
    const calls: Array<{ kind: string; value: unknown }> = []
    const child = { stdout: {}, stderr: {} }
    const launcher = createOwnedProcessLauncher({
      sourceEnv: { PATH: '/bin', UNRELATED_SECRET: 'hidden' },
      environmentFactory: (profile: string, source: Record<string, string>, overrides: unknown) => {
        calls.push({ kind: 'environment', value: { profile, source, overrides } })
        return { PATH: source.PATH, PROFILE: profile }
      },
      owner: {
        async spawnProcess(_command: string, _args: string[], options: unknown) {
          calls.push({ kind: 'spawn', value: options })
          return child
        },
        captureProcessOutput(stream: unknown, destination: string, options: unknown) {
          calls.push({ kind: 'log', value: { stream, destination, options } })
        },
      },
    })

    await launcher.launch({
      command: 'desktop-app',
      profile: 'runtime',
      envOverrides: { CODEX_HOME: undefined },
      logPath: '/logs/app.log',
      resourceName: 'desktop app group',
      secrets: ['secret'],
    })

    expect(calls).toEqual([
      {
        kind: 'environment',
        value: {
          profile: 'runtime',
          source: { PATH: '/bin', UNRELATED_SECRET: 'hidden' },
          overrides: { CODEX_HOME: undefined },
        },
      },
      {
        kind: 'spawn',
        value: {
          cleanup: 'group',
          env: { PATH: '/bin', PROFILE: 'runtime' },
          resourceName: 'desktop app group',
        },
      },
      {
        kind: 'log',
        value: {
          stream: child.stdout,
          destination: '/logs/app.log',
          options: { secrets: ['secret'] },
        },
      },
      {
        kind: 'log',
        value: {
          stream: child.stderr,
          destination: '/logs/app.log',
          options: { secrets: ['secret'] },
        },
      },
    ])
  })

  test('parses scenario selection and memory limits without reading global state', async () => {
    const { parseTaskFlowArgs } = (await import(
      /* @vite-ignore */ desktopModule('task-flow-args.mjs')
    )) as TaskFlowArgsModule
    const options = parseTaskFlowArgs(['node', 'task-flow', '--memory-only', '--retry-only'], {
      KCODER_STUDIO_E2E_MEMORY_MAX_PEAK_GROWTH_KIB: '1234',
      KCODER_STUDIO_E2E_DESKTOP_SCENARIO_ONLY: 'true',
    })

    expect(options).toMatchObject({ memoryOnly: true, retryOnly: true, cloudOnly: false })
    expect(options.desktopScenarioOnly).toBe(true)
    expect(options.memoryLimits.peakGrowthKiB).toBe(1234)
    expect(() =>
      parseTaskFlowArgs([], { KCODER_STUDIO_E2E_MEMORY_MAX_SETTLED_DOM_NODES: 'invalid' })
    ).toThrow(/positive number/)
  })

  test('materializes the plugin fixture without owning any process lifecycle', async () => {
    const fixtures = (await import(
      /* @vite-ignore */ desktopModule('task-flow-fixtures.mjs')
    )) as TaskFlowFixturesModule
    const root = await mkdtemp(join(tmpdir(), 'wework-task-flow-fixture-'))
    temporaryDirectories.push(root)

    await fixtures.createPluginMarketplaceFixture(root)

    const marketplace = JSON.parse(
      await readFile(join(root, '.agents/plugins/marketplace.json'), 'utf8')
    )
    const plugin = JSON.parse(
      await readFile(
        join(root, 'plugins', fixtures.PLUGIN_NAME, '.codex-plugin/plugin.json'),
        'utf8'
      )
    )
    expect(marketplace.plugins[0].name).toBe(fixtures.PLUGIN_NAME)
    expect(plugin.name).toBe(fixtures.PLUGIN_NAME)
    expect(
      await readFile(
        join(root, 'plugins', fixtures.PLUGIN_NAME, 'skills/desktop-e2e-skill/SKILL.md'),
        'utf8'
      )
    ).toContain('desktop-e2e-skill')
  })

  test('runs bounded command probes through the command support boundary', async () => {
    const commands = (await import(
      /* @vite-ignore */ desktopModule('task-flow-command.mjs')
    )) as TaskFlowCommandModule

    const calls: unknown[] = []
    const support = commands.createCommandSupport(
      {
        async runCommand(command: string, args: string[], options: unknown) {
          calls.push({ command, args, options })
          return { stdout: 'ready\n', stderr: '' }
        },
      },
      { environmentFor: () => ({ PATH: '/bin' }) }
    )
    await expect(support.commandOutput('probe', ['--version'])).resolves.toBe('ready')
    expect(calls).toEqual([
      { command: 'probe', args: ['--version'], options: { env: { PATH: '/bin' } } },
    ])
    await expect(commands.isExecutable(process.execPath)).resolves.toBe(true)
    await expect(commands.withTimeout(Promise.resolve('done'), 50, 'late')).resolves.toBe('done')
    await expect(commands.withTimeout(new Promise(() => {}), 5, 'bounded timeout')).rejects.toThrow(
      'bounded timeout'
    )
  })

  test('normalizes text, layout and memory evidence without a desktop process', async () => {
    const evidence = (await import(
      /* @vite-ignore */ desktopModule('task-flow-evidence.mjs')
    )) as TaskFlowEvidenceModule
    const samples = [
      { physicalFootprintKiB: 30, phase: 'high' },
      { physicalFootprintKiB: 10, phase: 'low' },
      { physicalFootprintKiB: 20, phase: 'middle' },
    ]

    expect(evidence.countTextOccurrences('one-one-one', 'one')).toBe(3)
    expect(
      evidence.distanceFromBottom({ scrollHeight: 100, clientHeight: 30, scrollTop: 80 })
    ).toBe(0)
    expect(evidence.memorySampleRangeKiB(samples)).toBe(20)
    expect(evidence.medianMemorySample(samples)?.phase).toBe('middle')
    expect(
      evidence.processGroup(
        { processMemory: { groups: [{ group: 'app' }, { group: 'webkit-webcontent' }] } },
        'webkit-webcontent'
      )
    ).toEqual({ group: 'webkit-webcontent' })
  })

  test('builds model protocol responses without owning the mock server lifecycle', async () => {
    const { createModelProtocolHelpers } = (await import(
      /* @vite-ignore */ desktopModule('task-flow-model-protocol.mjs')
    )) as TaskFlowModelProtocolModule
    const protocol = createModelProtocolHelpers(modelProtocolConfig())
    const model = { execution: 'local', source: 'catalog', protocol: 'responses' }

    expect(protocol.createSse([{ type: 'response.created' }])).toContain('event: response.created')
    expect(
      protocol.codexRequestKind({
        client_metadata: { 'x-codex-turn-metadata': '{"request_kind":"compact"}' },
      })
    ).toBe('compact')
    expect(protocol.matrixPatch(model)).toContain('studio-matrix-local-catalog-responses.txt')
    expect(protocol.requestContainsToolOutput({ input: [{ type: 'function_call_output' }] })).toBe(
      true
    )
  })

  test.each([
    ['exec_command', 'cmd'],
    ['shell_command', 'command'],
  ])('selects %s with explicit command metadata', async (toolName, commandField) => {
    const { createModelProtocolHelpers } = (await import(
      /* @vite-ignore */ desktopModule('task-flow-model-protocol.mjs')
    )) as TaskFlowModelProtocolModule
    const protocol = createModelProtocolHelpers(modelProtocolConfig())
    const selected = protocol.selectShellTool({ tools: [{ name: toolName }] }, '/workspace')

    expect(selected.name).toBe(toolName)
    expect(selected.arguments).toMatchObject({
      [commandField]: 'pwd',
      workdir: '/workspace',
    })
  })

  test('handles HTTP JSON, CORS, malformed bodies and custom tool protocols', async () => {
    const { createModelProtocolHelpers } = (await import(
      /* @vite-ignore */ desktopModule('task-flow-model-protocol.mjs')
    )) as TaskFlowModelProtocolModule
    const protocol = createModelProtocolHelpers(modelProtocolConfig())
    const headers = new Map<string, string>()
    let status = 0
    let body = ''
    const response = {
      writeHead(nextStatus: number, nextHeaders: Record<string, string>) {
        status = nextStatus
        Object.entries(nextHeaders).forEach(([name, value]) => headers.set(name, value))
      },
      setHeader(name: string, value: string) {
        headers.set(name, value)
      },
      end(value: string) {
        body = value
      },
    }

    protocol.cors(response)
    protocol.json(response, 201, { accepted: true })
    expect(status).toBe(201)
    expect(headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(body).toBe('{"accepted":true}\n')
    await expect(protocol.readRequestBody(Readable.from(['{bad json']))).rejects.toBeInstanceOf(
      SyntaxError
    )
    expect(protocol.selectApplyPatchTool({ tools: [{ name: 'apply_patch' }] })).toContain(
      '*** Add File: artifact.txt'
    )
    expect(
      protocol.selectCloudApplyPatchTool({
        tools: [{ name: 'apply_patch', type: 'custom' }],
      })
    ).toContain('*** Add File: cloud.txt')
    expect(protocol.selectViewImageTool({ tools: [{ name: 'view_image' }] }, '/workspace')).toEqual(
      {
        name: 'view_image',
        arguments: { path: '/workspace/image.png' },
      }
    )
  })

  test('correlates control commands with the active desktop client', async () => {
    const { DesktopControlTransport } = (await import(
      /* @vite-ignore */ desktopModule('task-flow-control-transport.mjs')
    )) as TaskFlowControlModule
    const protocolModule = (await import(
      /* @vite-ignore */ desktopModule('task-flow-model-protocol.mjs')
    )) as TaskFlowModelProtocolModule
    const protocol = protocolModule.createModelProtocolHelpers(modelProtocolConfig())
    const transport = new DesktopControlTransport({
      guard: (promise: Promise<unknown>) => promise,
      json: protocol.json,
      readRequestBody: protocol.readRequestBody,
      timeoutMs: 100,
      withTimeout: (promise: Promise<unknown>) => promise,
    })
    const readyResponse = responseRecorder()
    await transport.handleRoute(
      requestWithJson('POST', { clientId: 'client-a' }),
      readyResponse,
      new URL('http://control/ready')
    )
    expect(transport.activeClientId).toBe('client-a')

    const resultPromise = transport.command('click', '#send')
    const commandResponse = responseRecorder()
    await transport.handleRoute(
      requestWithJson('GET', null),
      commandResponse,
      new URL('http://control/commands?clientId=client-a')
    )
    const delivered = JSON.parse(commandResponse.body)
    expect(delivered).toMatchObject({ action: 'click', selector: '#send' })
    await transport.handleRoute(
      requestWithJson('POST', {
        id: delivered.id,
        clientId: 'client-a',
        ok: true,
        value: 'clicked',
      }),
      responseRecorder(),
      new URL('http://control/results')
    )
    await expect(resultPromise).resolves.toBe('clicked')
    expect(transport.commandHistory).toHaveLength(1)
  })

  test('rejects queued commands when the desktop control client is replaced', async () => {
    const { DesktopControlTransport } = (await import(
      /* @vite-ignore */ desktopModule('task-flow-control-transport.mjs')
    )) as TaskFlowControlModule
    const protocolModule = (await import(
      /* @vite-ignore */ desktopModule('task-flow-model-protocol.mjs')
    )) as TaskFlowModelProtocolModule
    const protocol = protocolModule.createModelProtocolHelpers(modelProtocolConfig())
    const transport = new DesktopControlTransport({
      guard: (promise: Promise<unknown>) => promise,
      json: protocol.json,
      readRequestBody: protocol.readRequestBody,
      timeoutMs: 100,
      withTimeout: (promise: Promise<unknown>) => promise,
    })

    await transport.handleRoute(
      requestWithJson('POST', { clientId: 'client-a' }),
      responseRecorder(),
      new URL('http://control/ready')
    )
    const pending = transport.command('click', '#stale')
    await transport.handleRoute(
      requestWithJson('POST', { clientId: 'client-b' }),
      responseRecorder(),
      new URL('http://control/ready')
    )
    await expect(pending).rejects.toThrow(/client-a was replaced by client-b/)

    const stalePoll = responseRecorder()
    await transport.handleRoute(
      requestWithJson('GET', null),
      stalePoll,
      new URL('http://control/commands?clientId=client-a')
    )
    expect(stalePoll.status).toBe(204)
  })

  test('owns model scenario transitions and routes only the active state', async () => {
    const { DesktopModelScenarioState, routeModelScenario } = (await import(
      /* @vite-ignore */ desktopModule('task-flow-model-state.mjs')
    )) as TaskFlowModelStateModule
    const state = new DesktopModelScenarioState({
      guard: (promise: Promise<unknown>) => promise,
      localModels: [{ protocol: 'responses' }],
      timeoutMs: 100,
      withTimeout: (promise: Promise<unknown>) => promise,
    })
    expect(() => state.setScenario('unknown')).toThrow(/Unknown desktop E2E scenario/)
    state.setMatrixCase({ protocol: 'responses' })
    expect(state.scenario).toBe('model_protocol_matrix')
    expect(state.matrixState?.stage).toBe('text')

    const request = state.awaitRequest('retry')
    state.recordRequest('retry', { prompt: 'again' })
    await expect(request).resolves.toEqual({ prompt: 'again' })
    expect(
      routeModelScenario(state.scenario, {
        model_protocol_matrix: () => 'matrix',
        retry: () => 'retry',
      })
    ).toBe('matrix')
  })

  test('attachment scenario factory validates dependencies and preserves command order', async () => {
    const { createAttachmentScenarioHelpers } = (await import(
      /* @vite-ignore */ desktopModule('task-flow-attachment-scenarios.mjs')
    )) as TaskFlowAttachmentScenariosModule
    expect(() => createAttachmentScenarioHelpers({})).toThrow(
      /missing dependencies: ACTIVE_WORKBENCH_SELECTOR/
    )

    const events: string[] = []
    const helpers = createAttachmentScenarioHelpers(attachmentScenarioDependencies(events))
    const control = {
      setScenario(scenario: string) {
        events.push(`scenario:${scenario}`)
      },
      async command(action: string) {
        events.push(`command:${action}`)
        return '{}'
      },
      async awaitScenarioRequestCount(scenario: string, count: number) {
        events.push(`request:${scenario}:${count}`)
      },
    }

    await helpers.verifyPastedZipAttachment({ composerSelector: '#composer', control })

    expect(events).toEqual([
      'scenario:pasted_zip_attachment',
      'command:snapshot',
      'command:click',
      'command:waitFor',
      'command:pasteFile',
      'command:waitFor',
      'command:clickWhenEnabled',
      'request:pasted_zip_attachment:1',
      'command:waitFor',
      'command:waitFor',
      'capture:pasted-zip-attachment.png',
    ])
  })

  test('attachment scenario factory propagates command failures without continuing', async () => {
    const { createAttachmentScenarioHelpers } = (await import(
      /* @vite-ignore */ desktopModule('task-flow-attachment-scenarios.mjs')
    )) as TaskFlowAttachmentScenariosModule
    const events: string[] = []
    const expected = new Error('paste failed')
    const helpers = createAttachmentScenarioHelpers(attachmentScenarioDependencies(events))
    const control = {
      setScenario() {},
      async command(action: string) {
        events.push(action)
        if (action === 'pasteFile') throw expected
        return '{}'
      },
      async awaitScenarioRequestCount() {
        events.push('unexpected-request')
      },
    }

    await expect(
      helpers.verifyPastedZipAttachment({ composerSelector: '#composer', control })
    ).rejects.toBe(expected)
    expect(events).toEqual(['snapshot', 'click', 'waitFor', 'pasteFile'])
  })

  test('runtime scenario factory validates dependencies and releases reconnect in order', async () => {
    const { createRuntimeScenarioHelpers } = (await import(
      /* @vite-ignore */ desktopModule('task-flow-runtime-scenarios.mjs')
    )) as TaskFlowRuntimeScenariosModule
    expect(() => createRuntimeScenarioHelpers({})).toThrow(
      /missing dependencies: ACTIVE_WORKBENCH_SELECTOR/
    )

    const events: string[] = []
    const helpers = createRuntimeScenarioHelpers(runtimeScenarioDependencies(events))
    const control = reconnectControl(events)

    await helpers.verifyReconnectRecovery({ composerSelector: '#composer', control })

    expect(events).toEqual([
      'scenario:reconnect',
      'send:reconnect:RECONNECT_PROMPT',
      'await-response-started',
      'command:waitFor:thinking-indicator',
      'capture:reconnect-01-streaming.png',
      'disconnect',
      'command:waitFor:runtime-reconnecting-status',
      'capture:reconnect-02-reconnecting.png',
      'await-request:reconnect:2',
      'release',
      'command:waitFor:message-assistant',
      'command:snapshot:active-workbench',
      'capture:reconnect-03-recovered.png',
    ])
  })

  test('runtime scenario factory propagates failures before releasing reconnect', async () => {
    const { createRuntimeScenarioHelpers } = (await import(
      /* @vite-ignore */ desktopModule('task-flow-runtime-scenarios.mjs')
    )) as TaskFlowRuntimeScenariosModule
    const events: string[] = []
    const expected = new Error('reconnect UI missing')
    const control = reconnectControl(events, expected)
    const helpers = createRuntimeScenarioHelpers(runtimeScenarioDependencies(events))

    await expect(
      helpers.verifyReconnectRecovery({ composerSelector: '#composer', control })
    ).rejects.toBe(expected)
    expect(events).toEqual([
      'scenario:reconnect',
      'send:reconnect:RECONNECT_PROMPT',
      'await-response-started',
      'command:waitFor:thinking-indicator',
      'capture:reconnect-01-streaming.png',
      'disconnect',
      'command:waitFor:runtime-reconnecting-status',
    ])
  })
})

function attachmentScenarioDependencies(events: string[]): Record<string, unknown> {
  return {
    ACTIVE_WORKBENCH_SELECTOR: 'active-workbench',
    ATTACHMENT_ONLY_COMPLETION_TEXT: 'attachment-only',
    ATTACHMENT_ONLY_FILENAME: 'image.png',
    COMPLETION_TEXT: 'complete',
    COMPOSER_READY_STABILITY_MS: 1,
    DROPPED_PATH_COMPLETION_TEXT: 'dropped',
    DROPPED_PATH_FILE_NAME: 'dropped.md',
    DROPPED_PATH_FOLDER_NAME: 'dropped-folder',
    IMAGE_ARTIFACT_BASE64: 'aW1hZ2U=',
    PASTED_PATH_COMPLETION_TEXT: 'pasted-path',
    PASTED_PATH_FILE_NAME: 'pasted.md',
    PASTED_PATH_FOLDER_NAME: 'pasted-folder',
    PASTED_ZIP_BASE64: 'emlw',
    PASTED_ZIP_COMPLETION_TEXT: 'pasted-zip',
    PASTED_ZIP_FILENAME: 'fixture.zip',
    SIDE_CHAT_COMPLETION_TEXT: 'side-complete',
    SIDE_CHAT_FILENAME: 'side.png',
    SIDE_CHAT_PROMPT: 'side prompt',
    UI_TIMEOUT_MS: 100,
    WORKBENCH_READY_TIMEOUT_MS: 100,
    resultDir: '/tmp/result',
    captureVerificationScreenshot: async (_control: unknown, name: string) => {
      events.push(`capture:${name}`)
    },
    waitForSnapshot: async () => ({ testIds: [] }),
    waitForLogPattern: async () => {},
    reactivateMacApplication: async () => {},
    withTimeout: async (promise: Promise<unknown>) => promise,
  }
}

function runtimeScenarioDependencies(events: string[]): Record<string, unknown> {
  return {
    ACTIVE_WORKBENCH_SELECTOR: 'active-workbench',
    RECONNECT_COMPLETION_TEXT: 'RECONNECT_COMPLETE',
    RECONNECT_PROMPT: 'RECONNECT_PROMPT',
    UI_TIMEOUT_MS: 100,
    COMPOSER_READY_STABILITY_MS: 1,
    GOAL_IDLE_COMPLETION_TEXT: 'goal-idle-complete',
    GOAL_IDLE_PROMPT: 'goal-idle',
    GOAL_RESTART_COMPLETION_TEXT: 'goal-restart-complete',
    GOAL_RESTART_PROMPT: 'goal-restart',
    GOAL_RESTART_RESUME_PROMPT: 'goal-resume',
    WORKBENCH_READY_TIMEOUT_MS: 100,
    captureVerificationScreenshot: async (_control: unknown, name: string) => {
      events.push(`capture:${name}`)
    },
    sendPromptUntilScenarioRequest: async (
      _control: unknown,
      _selector: string,
      prompt: string,
      scenario: string
    ) => {
      events.push(`send:${scenario}:${prompt}`)
    },
    withTimeout: async (promise: Promise<unknown>) => promise,
    selectE2EModel: async () => {},
    waitForNewTaskRow: async () => 'runtime-local-task-row-1',
    waitForSnapshot: async () => ({ testIds: [] }),
    waitForWorkbenchDebugState: async () => ({}),
    waitForBlankConversation: async () => {},
    waitForExecutorReadyEvidence: async () => ({ processIds: [1] }),
    processIsAlive: () => false,
    sendPrompt: async () => {},
  }
}

function reconnectControl(events: string[], reconnectFailure?: Error): Record<string, unknown> {
  return {
    setScenario(scenario: string) {
      events.push(`scenario:${scenario}`)
    },
    async awaitReconnectResponseStarted() {
      events.push('await-response-started')
    },
    disconnectReconnectResponse() {
      events.push('disconnect')
    },
    async awaitScenarioRequestCount(scenario: string, count: number) {
      events.push(`await-request:${scenario}:${count}`)
    },
    releaseReconnectResponse() {
      events.push('release')
    },
    async command(action: string, selector: string) {
      const label = selector.match(/data-testid="([^"]+)/)?.[1] ?? selector
      events.push(`command:${action}:${label}`)
      if (reconnectFailure && label === 'runtime-reconnecting-status') throw reconnectFailure
      if (action === 'snapshot') return JSON.stringify({ testIds: [] })
      return ''
    },
  }
}

function modelProtocolConfig(): Record<string, unknown> {
  return {
    MEMORY_COMPLETION_TEXT: 'memory complete',
    LOCAL_MODEL_CASES: [],
    LOCAL_MODEL_SWITCH_ARTIFACT: 'switch.txt',
    LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT: 'switch',
    MODEL_PROTOCOL_MATRIX_TEXT_PREFIX: 'TEXT',
    MODEL_PROTOCOL_MATRIX_TOOL_PREFIX: 'TOOL',
    ARTIFACT_NAME: 'artifact.txt',
    ARTIFACT_CONTENT: 'artifact',
    CLOUD_ARTIFACT_NAME: 'cloud.txt',
    CLOUD_ARTIFACT_CONTENT: 'cloud',
    IMAGE_ARTIFACT_NAME: 'image.png',
  }
}

function requestWithJson(method: string, value: unknown): Readable & { method?: string } {
  const request = Readable.from(value == null ? [] : [JSON.stringify(value)]) as Readable & {
    method?: string
  }
  request.method = method
  return request
}

function responseRecorder(): {
  body: string
  status: number
  writeHead: (status: number, headers?: Record<string, string>) => void
  setHeader: (name: string, value: string) => void
  end: (value?: string) => void
} {
  return {
    body: '',
    status: 0,
    writeHead(status) {
      this.status = status
    },
    setHeader() {},
    end(value = '') {
      this.body = value
    },
  }
}
