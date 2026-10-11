// cloud environment for the existing desktop runner.
import {
  delay,
  fetchJson,
  operationSignal,
  reservePort,
  retainedLogRefreshers,
  runChecked,
  waitForUrl,
} from './runtime.mjs'
import {
  CLOUD_DEVICE_ID,
  CLOUD_MODEL_CASES,
  MODEL_API_KEY,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  rendererDir,
  repoDir,
  resultDir,
  stateDir,
} from './config.mjs'
import { codexUpstreamApiFormat, writeCodexConfig } from './builds.mjs'
import { join, dirname } from 'node:path'
import { createProcessEnvironment, createRedactedLogRetainer } from '../process-lifecycle.mjs'
import assert from 'node:assert/strict'

export class RealCloudEnvironment {
  constructor({
    codexBinary,
    context,
    registerSecret,
    executorBinary,
    launcher,
    modelServerUrl,
    owner,
    sidecarLogSourceDir,
    workspacePath,
  }) {
    this.codexBinary = codexBinary
    this.context = context
    this.registerSecret = registerSecret
    this.executorBinary = executorBinary
    this.launcher = launcher
    this.modelServerUrl = modelServerUrl
    this.owner = owner
    this.sidecarLogSourceDir = sidecarLogSourceDir
    this.workspacePath = workspacePath
  }

  async start() {
    this.redisPort = await reservePort()
    this.backendPort = await reservePort()
    this.context.registerPort('legacy-cloud-redis', this.redisPort)
    this.context.registerPort('legacy-cloud-backend', this.backendPort)
    this.backendUrl = `http://127.0.0.1:${this.backendPort}`
    this.databasePath = join(stateDir, 'cloud-backend.sqlite3')
    this.backendLogPath = join(resultDir, 'cloud-backend.log')
    this.redisLogPath = join(resultDir, 'cloud-redis.log')
    this.remoteExecutorLogPath = join(resultDir, 'cloud-executor.log')

    this.redis = await this.launcher.launch({
      command: 'redis-server',
      args: ['--port', String(this.redisPort), '--save', '', '--appendonly', 'no'],
      profile: 'redis',
      resourceName: 'cloud Redis process',
      logPath: this.redisLogPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const backendSecrets = [
      `studio-desktop-e2e-${process.pid}`,
      `studio-desktop-e2e-internal-${process.pid}`,
    ]
    const backendEnv = createProcessEnvironment('backend', process.env, {
      DATABASE_URL: `sqlite:///${this.databasePath}`,
      REDIS_URL: `redis://127.0.0.1:${this.redisPort}/0`,
      SECRET_KEY: backendSecrets[0],
      INTERNAL_SERVICE_TOKEN: backendSecrets[1],
      DB_AUTO_MIGRATE: 'false',
      INIT_DATA_ENABLED: 'true',
    })
    await runChecked('uv', ['run', 'alembic', 'upgrade', 'head'], {
      cwd: join(repoDir, 'backend'),
      env: backendEnv,
    })
    this.backend = await this.launcher.launch({
      command: 'uv',
      args: [
        'run',
        'uvicorn',
        'app.main:app',
        '--host',
        '127.0.0.1',
        '--port',
        String(this.backendPort),
      ],
      cwd: join(repoDir, 'backend'),
      env: backendEnv,
      resourceName: 'cloud backend process',
      logPath: this.backendLogPath,
      secrets: backendSecrets,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForUrl(
      `${this.backendUrl}/api/docs`,
      `Real cloud backend did not start; see ${this.backendLogPath}`
    )

    const password = `studio-desktop-e2e-${process.pid}`
    const setup = await fetchJson(`${this.backendUrl}/api/auth/admin-password/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    this.authToken = setup.access_token
    this.registerSecret(this.authToken)
    assert.ok(this.authToken, 'Real cloud backend did not return an authentication token')
    await this.seedCloudProtocolModels()

    const remoteHome = join(stateDir, 'cloud-executor-home')
    const remoteRuntimeLogSource = join(this.sidecarLogSourceDir, 'cloud-executor-runtime.log')
    this.remoteCodexHome = join(remoteHome, 'codex')
    await writeCodexConfig(this.remoteCodexHome, this.modelServerUrl)
    const remoteEnv = createProcessEnvironment('runtime', process.env, {
      CODEX_BIN: this.codexBinary,
      CODEX_HOME: this.remoteCodexHome,
      HOME: remoteHome,
      USERPROFILE: remoteHome,
      APPDATA: this.context.pathInState('cloud-appdata'),
      LOCALAPPDATA: this.context.pathInState('cloud-local-appdata'),
      WEGENT_CODEX_HOME: this.remoteCodexHome,
      WEGENT_EXECUTOR_HOME: remoteHome,
      WEGENT_EXECUTOR_LOG_DIR: this.sidecarLogSourceDir,
      WEGENT_EXECUTOR_LOG_FILE: 'cloud-executor-runtime.log',
      EXECUTOR_MODE: 'local',
      WEGENT_BACKEND_URL: this.backendUrl,
      WEGENT_AUTH_TOKEN: this.authToken,
      DEVICE_ID: CLOUD_DEVICE_ID,
      DEVICE_NAME: 'Studio E2E Cloud Device',
      DEVICE_TYPE: 'remote',
      BIND_SHELL: 'claudecode',
      LOCAL_WORKSPACE_ROOT: dirname(this.workspacePath),
      KCODER_STUDIO_E2E_MODEL_API_KEY: MODEL_API_KEY,
      DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
      DEVICE_SESSION_GATEWAY_PORT: '0',
      WEGENT_APP_IPC_DEVICE_ID: undefined,
    })
    const remoteRuntimeLogPath = join(resultDir, 'cloud-executor-runtime.log')
    const remoteRuntimeLogRetainer = createRedactedLogRetainer({
      source: remoteRuntimeLogSource,
      destination: remoteRuntimeLogPath,
      secrets: () => [this.authToken, MODEL_API_KEY],
    })
    retainedLogRefreshers.set(remoteRuntimeLogPath, remoteRuntimeLogRetainer)
    this.owner.register('retain redacted cloud executor runtime log', async () => {
      try {
        await remoteRuntimeLogRetainer.sync({ final: true })
      } finally {
        retainedLogRefreshers.delete(remoteRuntimeLogPath)
      }
    })
    this.remoteExecutor = await this.launcher.launch({
      command: this.executorBinary,
      cwd: rendererDir,
      env: remoteEnv,
      resourceName: 'cloud remote executor process group',
      logPath: this.remoteExecutorLogPath,
      secrets: [this.authToken, MODEL_API_KEY],
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.owner.register('cloud running tasks', ({ signal }) => this.cancelRunningTasks(signal))
    await this.waitForDevice()
  }

  async seedCloudProtocolModels() {
    const items = CLOUD_MODEL_CASES.map(model => ({
      name: model.optionId,
      env: {
        model: model.protocol === 'anthropic' ? 'claude' : 'openai',
        model_id: model.modelId,
        base_url: `${this.modelServerUrl}/v1`,
        api_key: MODEL_API_KEY,
      },
      is_active: true,
      wework_available: true,
      protocol:
        model.protocol === 'responses'
          ? 'openai-responses'
          : model.protocol === 'chat'
            ? 'openai'
            : 'anthropic-messages',
      ...(model.protocol === 'responses'
        ? { api_format: 'responses' }
        : model.protocol === 'chat'
          ? { api_format: 'chat/completions' }
          : {}),
    }))
    await fetchJson(`${this.backendUrl}/api/models/batch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(items),
    })
  }

  async setCodexUpstreamProtocol(protocol) {
    await writeCodexConfig(
      this.remoteCodexHome,
      this.modelServerUrl,
      '',
      codexUpstreamApiFormat(protocol)
    )
  }

  async waitForDevice() {
    const startedAt = Date.now()
    while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
      const response = await fetch(`${this.backendUrl}/api/devices`, {
        headers: { Authorization: `Bearer ${this.authToken}` },
        signal: operationSignal,
      })
      if (response.ok) {
        const devices = await response.json()
        const device = devices.items?.find(item => item.device_id === CLOUD_DEVICE_ID)
        if (device?.status === 'online') return
      }
      await delay(250)
    }
    throw new Error(`Real cloud executor did not register; see ${this.remoteExecutorLogPath}`)
  }

  async waitForWorkspaceRemoved(workspacePath) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < UI_TIMEOUT_MS) {
      const response = await fetch(`${this.backendUrl}/api/runtime-work`, {
        headers: { Authorization: `Bearer ${this.authToken}` },
        signal: operationSignal,
      })
      if (response.ok) {
        const work = await response.json()
        const stillPresent = work.workspaces?.some(
          workspace => workspace.workspacePath === workspacePath
        )
        if (!stillPresent) return
      }
      await delay(250)
    }
    throw new Error('The real cloud backend still returned the removed project')
  }

  async cancelRunningTasks(signal) {
    if (!this.backendUrl || !this.authToken) return
    const work = await fetchJson(`${this.backendUrl}/api/runtime-work`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
      signal,
    })
    const workspaces = [
      ...(work.projects ?? []).flatMap(project => project.deviceWorkspaces ?? []),
      ...(work.chats ?? []),
    ]
    const runningTasks = workspaces.flatMap(workspace =>
      (workspace.tasks ?? [])
        .filter(task => task.running)
        .map(task => ({
          deviceId: workspace.deviceId,
          taskId: task.taskId,
          workspacePath: task.workspacePath,
        }))
    )
    await Promise.all(
      runningTasks.map(address =>
        fetchJson(`${this.backendUrl}/api/runtime-work/cancel`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(address),
          signal,
        })
      )
    )
  }
}
