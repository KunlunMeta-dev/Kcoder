// model server for the existing desktop runner.
import { DesktopProtocolServer } from './model-protocol-server.mjs'
import {
  assistantMessage,
  codexRequestKind,
  cors,
  createSse,
  customToolCall,
  functionCall,
  json,
  localProtocolCase,
  readRequestBody,
  requestAdvertisesShellTool,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  responseFailed,
  selectApplyPatchTool,
  selectCloudApplyPatchTool,
  selectShellTool,
  selectTool,
  selectViewImageTool,
  streamingMarkdownReport,
  streamingTextEvents,
} from './model-bindings.mjs'
import {
  ATTACHMENT_ONLY_COMPLETION_TEXT,
  ATTACHMENT_ONLY_FILENAME,
  BLOCKED_CLOUD_MODEL_PATH,
  CANCELLATION_PROMPT,
  CLOUD_COMPLETION_TEXT,
  CLOUD_FOLLOW_UP_COMPLETION_TEXT,
  CLOUD_FOLLOW_UP_PROMPT,
  CLOUD_PUBLIC_MODEL_LABEL,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_TASK_PROMPT,
  COMPLETION_TEXT,
  CONCURRENT_MEMORY_TASK_COUNT,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DROPPED_PATH_COMPLETION_TEXT,
  DROPPED_PATH_FILE_NAME,
  DROPPED_PATH_FOLDER_NAME,
  FOLLOW_UP_COMPLETION_TEXT,
  FOLLOW_UP_PROMPT,
  FORK_FOLLOW_UP_COMPLETION_TEXT,
  FORK_FOLLOW_UP_PROMPT,
  FRESH_CHAT_COMPLETION_TEXT,
  FRESH_CHAT_PROMPT,
  GOAL_IDLE_COMPLETION_TEXT,
  GOAL_IDLE_INITIAL_TEXT,
  GOAL_IDLE_PROMPT,
  GOAL_RESTART_COMPLETION_TEXT,
  GOAL_RESTART_INITIAL_TEXT,
  GOAL_RESTART_PROMPT,
  LOCAL_MODEL_CASES,
  MEMORY_PROMPT,
  MODEL_API_KEY,
  PASTED_PATH_COMPLETION_TEXT,
  PASTED_PATH_FILE_NAME,
  PASTED_PATH_FOLDER_NAME,
  PASTED_ZIP_COMPLETION_TEXT,
  PASTED_ZIP_FILENAME,
  RECONNECT_COMPLETION_TEXT,
  RECONNECT_PROMPT,
  REQUEST_USER_INPUT_COMPLETION_TEXT,
  REQUEST_USER_INPUT_PROMPT,
  REQUEST_USER_INPUT_QUESTION,
  RETRY_COMPLETION_TEXT,
  RETRY_FAILURE_TEXT,
  RETRY_PROMPT,
  RUNNING_FORK_COMPLETION_TEXT,
  RUNNING_FORK_FOLLOW_UP_PROMPT,
  SIDE_CHAT_COMPLETION_TEXT,
  SIDE_CHAT_FILENAME,
  SIDE_CHAT_PROMPT,
  TASK_PROMPT,
  TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX,
  TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX,
  UI_TIMEOUT_MS,
  WINDOW_LIFECYCLE_COMPLETION_RESPONSE,
  WINDOW_LIFECYCLE_PROMPT,
} from './config.mjs'
import { abortable, delay, withTimeout } from './runtime.mjs'
import { createServer } from 'node:http'
import { DesktopControlTransport } from '../task-flow-control-transport.mjs'
import { DesktopModelScenarioState, routeModelScenario } from '../task-flow-model-state.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'

export class DesktopE2EServer extends DesktopProtocolServer {
  constructor(workspacePath, cloudWorkspacePath = workspacePath, desktopScenario = null) {
    super()
    this.workspacePath = workspacePath
    this.cloudWorkspacePath = cloudWorkspacePath
    this.desktopScenario = desktopScenario
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(error => this.fail(error, response))
    })
    this.desktopScenario?.attachServer?.(this.server)
    this.controlServer = createServer((request, response) => {
      void this.handleControl(request, response).catch(error => this.fail(error, response))
    })
    this.fatalError = null
    this.fatalErrorPromise = new Promise((_, reject) => {
      this.rejectFatalError = reject
    })
    // A guarded operation observes this rejection; this handler prevents Node from
    // reporting it as unhandled in the small window before that operation starts.
    void this.fatalErrorPromise.catch(() => {})
    this.controlTransport = new DesktopControlTransport({
      guard: promise => this.guard(promise),
      json,
      readRequestBody,
      timeoutMs: UI_TIMEOUT_MS,
      withTimeout,
    })
    this.modelScenarioState = new DesktopModelScenarioState({
      guard: promise => this.guard(promise),
      localModels: LOCAL_MODEL_CASES,
      timeoutMs: UI_TIMEOUT_MS,
      withTimeout,
    })
    this.modelRequests = []
    this.catalogRequests = []
    this.blockedCloudRequests = []
    this.blockedCloudResponses = new Set()
    this.blockedCloudWaiters = []
    this.failCloudModels = false
    this.cloudModelsAvailable = false
    this.failedCloudModelRequests = 0
    this.failedCloudModelWaiter = null
    this.modelStage = 'initial'
    this.memoryStage = 'initial'
    this.concurrentMemoryResponses = []
    this.concurrentMemoryTaskNumbers = new Set()
    this.cloudModelStage = 'initial'
    this.toolLessPrewarmHandled = false
    this.memoryToolLessPrewarmHandled = false
    this.cloudToolLessPrewarmHandled = false
    this.toolOutput = null
    this.initialToolRelease = new Promise(resolvePromise => {
      this.releaseInitialTool = resolvePromise
    })
    this.retryCompletionRelease = new Promise(resolvePromise => {
      this.releaseRetryCompletion = resolvePromise
    })
    this.requestUserInputRelease = new Promise(resolvePromise => {
      this.releaseRequestUserInput = resolvePromise
    })
    this.requestUserInputResponseWritten = new Promise(resolvePromise => {
      this.resolveRequestUserInputResponseWritten = resolvePromise
    })
    this.reconnectDisconnectRelease = new Promise(resolvePromise => {
      this.releaseReconnectDisconnect = resolvePromise
    })
    this.reconnectResponseStarted = new Promise(resolvePromise => {
      this.resolveReconnectResponseStarted = resolvePromise
    })
    this.reconnectCompletionRelease = new Promise(resolvePromise => {
      this.releaseReconnectCompletion = resolvePromise
    })
    this.windowLifecycleRelease = new Promise(resolvePromise => {
      this.releaseWindowLifecycle = resolvePromise
    })
    this.windowLifecycleResponseStarted = new Promise(resolvePromise => {
      this.resolveWindowLifecycleResponseStarted = resolvePromise
    })
    this.runningForkFollowUpRelease = new Promise(resolvePromise => {
      this.releaseRunningForkFollowUp = resolvePromise
    })
    this.goalIdleInitialRelease = new Promise(resolvePromise => {
      this.releaseGoalIdleInitial = resolvePromise
    })
    this.goalIdleContinuationRelease = new Promise(resolvePromise => {
      this.releaseGoalIdleContinuation = resolvePromise
    })
    this.goalRestartResumeRelease = new Promise(resolvePromise => {
      this.releaseGoalRestartResume = resolvePromise
    })
    this.cloudFollowUpRelease = new Promise(resolvePromise => {
      this.releaseCloudFollowUp = resolvePromise
    })
    this.goalIdleStage = 'initial'
    this.goalRestartStage = 'initial'
    this.goalRestartResumeRequested = false
  }
  async start() {
    await Promise.all([this.listen(this.server), this.listen(this.controlServer)])
    const address = this.server.address()
    const controlAddress = this.controlServer.address()
    assert.ok(address && typeof address !== 'string', 'Desktop E2E server did not bind a TCP port')
    assert.ok(
      controlAddress && typeof controlAddress !== 'string',
      'Desktop E2E control server did not bind a TCP port'
    )
    this.url = `http://127.0.0.1:${address.port}`
    this.controlUrl = `http://127.0.0.1:${controlAddress.port}`
  }
  async listen(server) {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolvePromise()
      })
    })
  }
  async close() {
    for (const response of this.blockedCloudResponses) response.destroy()
    this.blockedCloudResponses.clear()
    this.server.closeAllConnections?.()
    this.controlServer.closeAllConnections?.()
    const closeServer = server =>
      server.listening
        ? new Promise((resolvePromise, reject) =>
            server.close(error => (error ? reject(error) : resolvePromise()))
          )
        : Promise.resolve()
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.desktopScenario?.close?.()),
      closeServer(this.server),
      closeServer(this.controlServer),
    ])
    const errors = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'Desktop E2E servers failed to close')
  }
  awaitReady() {
    return this.controlTransport.awaitReady()
  }
  awaitReadyAfter(readyCount) {
    return this.controlTransport.awaitReadyAfter(readyCount)
  }
  get ready() {
    return this.controlTransport.ready
  }
  get readyCount() {
    return this.controlTransport.readyCount
  }
  get commandHistory() {
    return this.controlTransport.commandHistory
  }
  awaitBlockedCloudRequest(pathname) {
    const request = this.blockedCloudRequests.find(item => item.pathname === pathname)
    if (request) return this.guard(Promise.resolve(request))
    return this.guard(
      new Promise(resolvePromise => {
        this.blockedCloudWaiters.push({ pathname, resolve: resolvePromise })
      })
    )
  }
  fail(error, response) {
    if (!response.headersSent) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    } else if (!response.writableEnded) {
      response.destroy(error instanceof Error ? error : undefined)
    }
    if (this.fatalError) return
    this.fatalError = error instanceof Error ? error : new Error(String(error))
    this.rejectFatalError(this.fatalError)
    this.controlTransport.fail(this.fatalError)
  }
  guard(promise) {
    if (this.fatalError) return Promise.reject(this.fatalError)
    return Promise.race([promise, this.fatalErrorPromise])
  }
  blockCloudRequest(request, response, url) {
    const blockedRequest = {
      method: request.method,
      pathname: url.pathname,
      search: url.search,
    }
    this.blockedCloudRequests.push(blockedRequest)
    this.blockedCloudResponses.add(response)
    response.once('close', () => this.blockedCloudResponses.delete(response))

    const remainingWaiters = []
    for (const waiter of this.blockedCloudWaiters) {
      if (waiter.pathname === url.pathname) {
        waiter.resolve(blockedRequest)
      } else {
        remainingWaiters.push(waiter)
      }
    }
    this.blockedCloudWaiters = remainingWaiters
  }
  failBlockedCloudModels() {
    this.failCloudModels = true
    const failedRequests = this.blockedCloudResponses.size
    for (const response of this.blockedCloudResponses) {
      json(response, 503, { error: 'Desktop E2E intentional cloud model failure' })
    }
    this.blockedCloudResponses.clear()
    this.failedCloudModelRequests += failedRequests
    if (failedRequests > 0) {
      this.failedCloudModelWaiter?.()
      this.failedCloudModelWaiter = null
    }
  }
  restoreCloudModels() {
    this.failCloudModels = false
    this.cloudModelsAvailable = true
  }
  awaitFailedCloudModelRequest() {
    if (this.failedCloudModelRequests > 0) return this.guard(Promise.resolve())
    return this.guard(
      new Promise(resolvePromise => {
        this.failedCloudModelWaiter = resolvePromise
      })
    )
  }
  get scenario() {
    return this.modelScenarioState.scenario
  }
  get matrixCase() {
    return this.modelScenarioState.matrixCase
  }
  get matrixState() {
    return this.modelScenarioState.matrixState
  }
  get localProtocolStates() {
    return this.modelScenarioState.localProtocolStates
  }
  get scenarioRequests() {
    return this.modelScenarioState.requests
  }
  setScenario(scenario) {
    this.modelScenarioState.setScenario(scenario)
  }
  setMatrixCase(model) {
    this.modelScenarioState.setMatrixCase(model)
  }
  recordScenarioRequest(scenario, request) {
    this.modelScenarioState.recordRequest(scenario, request)
  }
  awaitScenarioRequest(scenario) {
    return this.modelScenarioState.awaitRequest(scenario)
  }
  awaitScenarioRequestCount(scenario, count) {
    return this.modelScenarioState.awaitRequestCount(scenario, count)
  }
  releaseInitialToolExecution() {
    this.releaseInitialTool()
  }
  releaseRetryResponse() {
    this.releaseRetryCompletion()
  }
  releaseRequestUserInputResponse() {
    this.releaseRequestUserInput()
    return this.guard(this.requestUserInputResponseWritten)
  }
  awaitReconnectResponseStarted() {
    return this.guard(this.reconnectResponseStarted)
  }
  disconnectReconnectResponse() {
    this.releaseReconnectDisconnect()
  }
  releaseReconnectResponse() {
    this.releaseReconnectCompletion()
  }
  awaitWindowLifecycleResponseStarted() {
    return this.guard(this.windowLifecycleResponseStarted)
  }
  releaseWindowLifecycleResponse() {
    this.releaseWindowLifecycle()
  }
  releaseRunningForkFollowUpResponse() {
    this.releaseRunningForkFollowUp()
  }
  releaseGoalIdleInitialResponse() {
    this.releaseGoalIdleInitial()
  }
  releaseGoalIdleResponse() {
    this.releaseGoalIdleContinuation()
  }
  releaseGoalRestartResponse() {
    this.releaseGoalRestartResume()
  }
  markGoalRestartResumeRequested() {
    this.goalRestartResumeRequested = true
  }
  releaseCloudFollowUpResponse() {
    this.releaseCloudFollowUp()
  }
  releaseConcurrentMemoryResponses() {
    for (const { response, stream } of this.concurrentMemoryResponses.splice(0)) {
      response.end(createSse(stream.finish))
    }
  }
  async command(action, selector, options = {}) {
    return abortable(this.controlTransport.command(action, selector, options))
  }
  async handleControl(request, response) {
    cors(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', this.controlUrl)
    if (await this.controlTransport.handleRoute(request, response, url)) return
    json(response, 404, {
      error: `No Desktop E2E control route for ${request.method} ${url.pathname}`,
    })
  }
  async handle(request, response) {
    cors(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', this.url)
    if (await this.controlTransport.handleRoute(request, response, url)) return
    if (await this.desktopScenario?.handleHttp?.(request, response, url)) return

    if (request.method === 'GET' && url.pathname === '/api/users/me') {
      json(response, 200, {
        id: 9001,
        user_name: 'studio-desktop-e2e-cloud-user',
        email: 'desktop-e2e@studio.local',
      })
      return
    }

    if (request.method === 'GET' && url.pathname === BLOCKED_CLOUD_MODEL_PATH) {
      if (this.cloudModelsAvailable) {
        json(response, 200, {
          data: [
            {
              name: `codex-${DEFAULT_MODEL_ID}`,
              type: 'runtime',
              displayName: `${DEFAULT_MODEL_LABEL} (Codex)`,
              provider: 'openai',
              modelId: DEFAULT_MODEL_ID,
              namespace: 'default',
              config: {
                protocol: 'openai-responses',
                apiFormat: 'responses',
                weworkModelKind: 'codex-official',
                ui: { family: 'codex-official', modelLabel: DEFAULT_MODEL_LABEL },
              },
              runtime: { family: 'openai.openai-responses' },
              isActive: true,
            },
            {
              name: CLOUD_PUBLIC_MODEL_NAME,
              type: 'public',
              displayName: CLOUD_PUBLIC_MODEL_LABEL,
              provider: 'openai',
              modelId: 'desktop-e2e-public-upstream-model',
              namespace: 'default',
              resourceUserId: 0,
              config: {
                protocol: 'openai-responses',
                apiFormat: 'responses',
                ui: { family: 'gpt', modelLabel: CLOUD_PUBLIC_MODEL_LABEL },
              },
              runtime: { family: 'openai.openai-responses' },
              isActive: true,
            },
          ],
        })
        return
      }
      if (this.failCloudModels) {
        this.failedCloudModelRequests += 1
        this.failedCloudModelWaiter?.()
        this.failedCloudModelWaiter = null
        json(response, 503, { error: 'Desktop E2E intentional cloud model failure' })
        return
      }
      this.blockCloudRequest(request, response, url)
      return
    }

    if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      this.catalogRequests.push({
        authorization: request.headers.authorization ?? null,
        ifNoneMatch: request.headers['if-none-match'] ?? null,
        pathname: url.pathname,
        search: url.search,
      })
      assert.equal(
        request.headers.authorization,
        `Bearer ${MODEL_API_KEY}`,
        'The local catalog router did not forward the configured model API key'
      )
      response.setHeader('ETag', '"studio-desktop-e2e-models-v1"')
      json(response, 200, {
        models: [],
      })
      return
    }

    const modelProtocol =
      url.pathname === '/v1/responses' || url.pathname === '/responses'
        ? 'responses'
        : url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions'
          ? 'chat'
          : url.pathname === '/v1/messages' || url.pathname === '/messages'
            ? 'anthropic'
            : null
    if (request.method === 'POST' && modelProtocol) {
      await this.handleModelResponse(request, response, modelProtocol)
      return
    }

    json(response, 404, { error: `No Desktop E2E route for ${request.method} ${url.pathname}` })
  }
  async handleModelResponse(request, response, protocol) {
    const body = await readRequestBody(request)
    const authorization = request.headers.authorization ?? null
    const modelRequest = { authorization, body, scenario: this.scenario }
    this.modelRequests.push(modelRequest)
    const authenticated =
      authorization === `Bearer ${MODEL_API_KEY}` || request.headers['x-api-key'] === MODEL_API_KEY
    if (!authenticated) {
      json(response, 401, { error: 'The Desktop E2E model API key was not forwarded by Codex' })
      return
    }

    if (
      routeModelScenario(this.scenario, {
        model_protocol_matrix: () => {
          this.handleModelProtocolMatrixResponse(response, protocol, body, request.headers)
          return true
        },
        provider_switch_retry: () => {
          this.handleProviderSwitchRetryResponse(response, protocol, body, modelRequest)
          return true
        },
      })
    ) {
      return
    }

    const localModel = localProtocolCase(body.model)
    if (localModel) {
      assert.equal(
        protocol,
        localModel.protocol,
        `Local model ${body.model} reached the wrong ${protocol} endpoint`
      )
      this.handleLocalProtocolResponse(response, localModel, body, request.headers)
      return
    }

    const responseId = `studio-e2e-response-${this.modelRequests.length}`
    const requestKind = codexRequestKind(body)
    if (requestKind === 'compaction') {
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage('Desktop E2E context compaction completed.'),
        responseCompleted(responseId),
      ])
      return
    }

    if (requestKind === 'prewarm') {
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    // Codex CLI 0.144 can prewarm a custom Responses provider before adding
    // tool definitions or request metadata. It must not advance the task loop.
    if (
      this.scenario === 'initial' &&
      this.modelStage === 'initial' &&
      !this.toolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.toolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (
      this.scenario === 'cloud_initial' &&
      this.cloudModelStage === 'initial' &&
      !this.cloudToolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.cloudToolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (
      this.scenario === 'memory' &&
      this.memoryStage === 'initial' &&
      !this.memoryToolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.memoryToolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (this.scenario === 'initial' && this.modelStage === 'initial') {
      this.recordScenarioRequest('initial', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(TASK_PROMPT),
        'The real Codex request did not contain the UI task prompt'
      )
      const tool = selectShellTool(body, this.workspacePath)
      const patch = selectApplyPatchTool(body)
      const image = selectViewImageTool(body, this.workspacePath)
      this.modelStage = 'awaiting_tool_output'
      await this.initialToolRelease
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('studio-e2e-tool-call', tool.name, tool.arguments),
        ...functionCall('studio-e2e-view-image', image.name, image.arguments),
        customToolCall('studio-e2e-apply-patch', 'apply_patch', patch),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'initial') {
      assert.equal(
        this.modelStage,
        'awaiting_tool_output',
        `Unexpected desktop E2E model stage: ${this.modelStage}`
      )
      this.recordScenarioRequest('initial', modelRequest)
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The real Codex request did not report its tool output to the model service'
      )
      this.toolOutput = JSON.stringify(body.input)
      this.modelStage = 'complete'
      // Let the workbench commit the completed tool items before the final response
      // triggers a transcript refresh. Real providers have network latency here; an
      // immediate mock response can otherwise race the live image-view rendering.
      await delay(250)
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'concurrent_memory') {
      const promptMatch = JSON.stringify(body).match(
        /KCODER_STUDIO_DESKTOP_E2E_CONCURRENT_MEMORY_(\d+)/
      )
      assert.ok(promptMatch, 'Concurrent memory request did not contain a task UI prompt')
      const taskNumber = Number(promptMatch[1])
      assert.ok(
        taskNumber >= 1 && taskNumber <= CONCURRENT_MEMORY_TASK_COUNT,
        `Concurrent memory request contained invalid task number ${taskNumber}`
      )
      if (!this.concurrentMemoryTaskNumbers.has(taskNumber)) {
        this.concurrentMemoryTaskNumbers.add(taskNumber)
        this.recordScenarioRequest('concurrent_memory', modelRequest)
      }
      const stream = streamingTextEvents(responseId, `Concurrent task ${taskNumber} completed.`)
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(
        createSse([
          ...stream.start,
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: `Concurrent task ${taskNumber} is running.`,
            offset: 0,
          },
        ])
      )
      this.concurrentMemoryResponses.push({ response, stream })
      return
    }

    if (this.scenario === 'memory' && this.memoryStage === 'initial') {
      this.recordScenarioRequest('memory', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(MEMORY_PROMPT),
        'The real Codex request did not contain the memory E2E prompt'
      )
      const tool = selectShellTool(body, this.workspacePath)
      this.memoryStage = 'awaiting_tool_output'
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('studio-memory-tool-call', tool.name, tool.arguments),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'memory') {
      this.recordScenarioRequest('memory', modelRequest)
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The real Codex request did not report the memory E2E tool output'
      )
      this.memoryStage = 'streaming'
      await this.writeStreamingMarkdown(response, responseId, streamingMarkdownReport())
      this.memoryStage = 'complete'
      return
    }

    if (this.scenario === 'cloud_initial' && this.cloudModelStage === 'initial') {
      this.recordScenarioRequest('cloud_initial', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CLOUD_TASK_PROMPT),
        'The real cloud Codex request did not contain the UI task prompt'
      )
      const tool = selectShellTool(body, this.cloudWorkspacePath)
      const patch = selectCloudApplyPatchTool(body)
      this.cloudModelStage = 'awaiting_tool_output'
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('studio-cloud-e2e-tool-call', tool.name, tool.arguments),
        customToolCall('studio-cloud-e2e-apply-patch', 'apply_patch', patch),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'cloud_initial') {
      this.recordScenarioRequest('cloud_initial', modelRequest)
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The real cloud Codex request did not report its tool output to the model service'
      )
      this.cloudModelStage = 'complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(CLOUD_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'cloud_follow_up') {
      this.recordScenarioRequest('cloud_follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CLOUD_FOLLOW_UP_PROMPT),
        'The real cloud Codex request did not contain the follow-up prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      await this.cloudFollowUpRelease
      response.end(
        createSse([
          assistantMessage(CLOUD_FOLLOW_UP_COMPLETION_TEXT),
          responseCompleted(responseId),
        ])
      )
      return
    }

    if (this.scenario === 'follow_up') {
      this.recordScenarioRequest('follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(FOLLOW_UP_PROMPT),
        'The real Codex request did not contain the follow-up prompt'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(FOLLOW_UP_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'goal_restart') {
      this.recordScenarioRequest('goal_restart', modelRequest)
      if (this.goalRestartStage === 'initial') {
        assert.ok(
          JSON.stringify(body).includes(GOAL_RESTART_PROMPT),
          'The real Codex request did not contain the Goal restart prompt'
        )
        this.goalRestartStage = 'continuation'
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(GOAL_RESTART_INITIAL_TEXT),
          responseCompleted(responseId),
        ])
        return
      }
      if (this.goalRestartStage === 'continuation') {
        this.goalRestartStage = 'waiting_resume'
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        await new Promise(resolvePromise => response.once('close', resolvePromise))
        return
      }
      if (this.goalRestartStage === 'waiting_resume') {
        assert.equal(
          this.goalRestartResumeRequested,
          true,
          'The interrupted Goal resumed without explicit user input'
        )
        const updateGoal = selectTool(body, 'update_goal', { status: 'complete' })
        this.goalRestartStage = 'awaiting_resume_release'
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        await this.goalRestartResumeRelease
        response.end(
          createSse([
            ...functionCall(
              'studio-e2e-goal-restart-complete',
              updateGoal.name,
              updateGoal.arguments
            ),
            responseCompleted(responseId),
          ])
        )
        return
      }
      assert.equal(
        this.goalRestartStage,
        'awaiting_resume_release',
        `Unexpected Goal restart model stage: ${this.goalRestartStage}`
      )
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The resumed Goal did not return its update_goal output'
      )
      this.goalRestartStage = 'complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(GOAL_RESTART_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'goal_idle') {
      this.recordScenarioRequest('goal_idle', modelRequest)
      if (this.goalIdleStage === 'initial') {
        assert.ok(
          JSON.stringify(body).includes(GOAL_IDLE_PROMPT),
          'The real Codex request did not contain the Goal idle prompt'
        )
        const stream = streamingTextEvents(responseId, GOAL_IDLE_INITIAL_TEXT)
        this.goalIdleStage = 'continuation'
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse(stream.start))
        await this.goalIdleInitialRelease
        response.write(
          createSse([
            {
              type: 'response.output_text.delta',
              item_id: stream.itemId,
              output_index: 0,
              content_index: 0,
              delta: GOAL_IDLE_INITIAL_TEXT,
              offset: 0,
            },
          ])
        )
        response.end(createSse(stream.finish))
        return
      }
      if (this.goalIdleStage === 'continuation') {
        const updateGoal = selectTool(body, 'update_goal', { status: 'complete' })
        this.goalIdleStage = 'awaiting_update_output'
        await this.goalIdleContinuationRelease
        this.writeSse(response, [
          responseCreated(responseId),
          ...functionCall('studio-e2e-goal-idle-complete', updateGoal.name, updateGoal.arguments),
          responseCompleted(responseId),
        ])
        return
      }
      assert.equal(
        this.goalIdleStage,
        'awaiting_update_output',
        `Unexpected Goal idle model stage: ${this.goalIdleStage}`
      )
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The Goal continuation did not return its update_goal output'
      )
      this.goalIdleStage = 'complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(GOAL_IDLE_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'running_fork_follow_up') {
      this.recordScenarioRequest('running_fork_follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(RUNNING_FORK_FOLLOW_UP_PROMPT),
        'The real Codex request did not contain the running-fork follow-up prompt'
      )
      const stream = streamingTextEvents(responseId, RUNNING_FORK_COMPLETION_TEXT)
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse(stream.start))
      await this.runningForkFollowUpRelease
      response.write(
        createSse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: RUNNING_FORK_COMPLETION_TEXT,
            offset: 0,
          },
        ])
      )
      response.end(createSse(stream.finish))
      return
    }

    if (this.scenario === 'fork_follow_up') {
      this.recordScenarioRequest('fork_follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(FORK_FOLLOW_UP_PROMPT),
        'The real Codex request did not contain the fork follow-up prompt'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(FORK_FOLLOW_UP_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'window_lifecycle') {
      this.recordScenarioRequest('window_lifecycle', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(WINDOW_LIFECYCLE_PROMPT),
        'The real Codex request did not contain the window-lifecycle prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      this.resolveWindowLifecycleResponseStarted()
      await this.windowLifecycleRelease
      response.end(
        createSse([
          assistantMessage(WINDOW_LIFECYCLE_COMPLETION_RESPONSE),
          responseCompleted(responseId),
        ])
      )
      return
    }

    if (this.scenario === 'turn_navigation') {
      this.recordScenarioRequest('turn_navigation', modelRequest)
      const serializedBody = JSON.stringify(body)
      const turnMatch = Array.from(
        serializedBody.matchAll(
          new RegExp(`${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_(\\d+)`, 'g')
        )
      ).at(-1)
      assert.ok(turnMatch, 'The turn-navigation request did not include its turn number')
      const turnNumber = Number(turnMatch[1])
      const completionText = `${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}_${turnNumber}`
      const responseText = [
        completionText,
        ...Array.from(
          { length: 6 },
          (_, index) =>
            `Virtualized navigation response ${turnNumber}.${index + 1}. ${'Measured content '.repeat(12)}`
        ),
      ].join('\n\n')
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(responseText),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'request_user_input') {
      this.recordScenarioRequest('request_user_input', modelRequest)
      if (JSON.stringify(body.input).includes('studio-e2e-request-user-input')) {
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(REQUEST_USER_INPUT_COMPLETION_TEXT),
          responseCompleted(responseId),
        ])
        return
      }
      assert.ok(
        JSON.stringify(body).includes(REQUEST_USER_INPUT_PROMPT),
        'The real Codex request did not contain the request-user-input prompt'
      )
      const tool = selectTool(body, 'request_user_input', {
        questions: [
          {
            header: 'Direction',
            id: 'direction',
            question: REQUEST_USER_INPUT_QUESTION,
            options: [
              { label: 'Minimal', description: 'Make the smallest focused change.' },
              { label: 'Complete', description: 'Cover the full interaction flow.' },
            ],
          },
        ],
      })
      await this.requestUserInputRelease
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('studio-e2e-request-user-input', tool.name, tool.arguments),
        responseCompleted(responseId),
      ])
      this.resolveRequestUserInputResponseWritten()
      return
    }

    if (this.scenario === 'fresh_chat') {
      this.recordScenarioRequest('fresh_chat', modelRequest)
      assert.ok(JSON.stringify(body).includes(FRESH_CHAT_PROMPT), 'The fresh chat prompt was lost')
      assert.equal(
        JSON.stringify(body).includes(TASK_PROMPT),
        false,
        'The new conversation inherited the previous task context'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(FRESH_CHAT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'attachment_only') {
      this.recordScenarioRequest('attachment_only', modelRequest)
      const requestText = JSON.stringify(body)
      assert.ok(
        requestText.includes(ATTACHMENT_ONLY_FILENAME),
        'The attachment-only request did not contain the selected file'
      )
      const requestNumber = this.scenarioRequests.get('attachment_only').length
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(`${ATTACHMENT_ONLY_COMPLETION_TEXT}_${requestNumber}`),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'pasted_zip_attachment') {
      this.recordScenarioRequest('pasted_zip_attachment', modelRequest)
      const requestText = JSON.stringify(body)
      assert.ok(
        requestText.includes(PASTED_ZIP_FILENAME),
        'The pasted ZIP filename was not forwarded to the real Codex request'
      )
      assert.ok(
        requestText.includes('application/zip'),
        'The pasted ZIP MIME type was not forwarded to the real Codex request'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(PASTED_ZIP_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'pasted_workspace_paths') {
      this.recordScenarioRequest('pasted_workspace_paths', modelRequest)
      const requestText = JSON.stringify(body)
      const folderPath = join(this.workspacePath, PASTED_PATH_FOLDER_NAME)
      const filePath = join(this.workspacePath, PASTED_PATH_FILE_NAME)
      assert.ok(
        requestText.includes(folderPath),
        'The pasted folder reference was not forwarded to the real Codex request'
      )
      assert.ok(
        requestText.includes(filePath),
        'The pasted file reference was not forwarded to the real Codex request'
      )
      assert.equal(
        requestText.includes('nested path context') ||
          requestText.includes('# Pasted path context'),
        false,
        'The pasted paths copied file contents into the model request'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(PASTED_PATH_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'dropped_workspace_paths') {
      this.recordScenarioRequest('dropped_workspace_paths', modelRequest)
      const requestText = JSON.stringify(body)
      const folderPath = join(this.workspacePath, DROPPED_PATH_FOLDER_NAME)
      const filePath = join(this.workspacePath, DROPPED_PATH_FILE_NAME)
      assert.ok(
        requestText.includes(folderPath),
        'The dropped folder reference was not forwarded to the real Codex request'
      )
      assert.ok(
        requestText.includes(filePath),
        'The dropped file reference was not forwarded to the real Codex request'
      )
      assert.equal(
        requestText.includes('nested dropped path context') ||
          requestText.includes('# Dropped path context'),
        false,
        'The dropped paths copied file contents into the model request'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(DROPPED_PATH_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'side_chat_attachment') {
      this.recordScenarioRequest('side_chat_attachment', modelRequest)
      const requestText = JSON.stringify(body)
      assert.ok(requestText.includes(SIDE_CHAT_PROMPT), 'The side-chat request lost its prompt')
      assert.ok(
        requestText.includes(SIDE_CHAT_FILENAME),
        'The side-chat request lost its isolated attachment'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(SIDE_CHAT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'cancellation') {
      this.recordScenarioRequest('cancellation', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CANCELLATION_PROMPT),
        'The real Codex request did not contain the cancellation prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      return
    }

    if (this.scenario === 'retry') {
      this.recordScenarioRequest('retry', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(RETRY_PROMPT),
        'The real Codex request did not contain the retry prompt'
      )
      const retryRequests = this.scenarioRequests.get('retry') ?? []
      if (retryRequests.length === 1) {
        this.writeSse(response, [
          responseCreated(responseId),
          responseFailed(responseId, RETRY_FAILURE_TEXT),
        ])
        return
      }
      await this.retryCompletionRelease
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(RETRY_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'reconnect') {
      this.recordScenarioRequest('reconnect', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(RECONNECT_PROMPT),
        'The real Codex request did not contain the reconnect prompt'
      )
      const reconnectRequests = this.scenarioRequests.get('reconnect') ?? []
      if (reconnectRequests.length === 1) {
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        this.resolveReconnectResponseStarted()
        await this.reconnectDisconnectRelease
        response.destroy()
        return
      }
      await this.reconnectCompletionRelease
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(RECONNECT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    throw new Error(`Unexpected desktop E2E scenario: ${this.scenario}`)
  }
}
