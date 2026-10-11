// runner for the existing desktop runner.
import {
  CLOUD_ONLY,
  DESKTOP_READY_TIMEOUT_MS,
  DESKTOP_SCENARIO_ONLY,
  GIT_SEED_CONTENT,
  GIT_SEED_NAME,
  IMAGE_ARTIFACT_BASE64,
  IMAGE_ARTIFACT_NAME,
  MACOS_LAUNCH_SERVICES_REGISTER,
  MODEL_API_KEY,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  rendererDir,
  resultDir,
} from './config.mjs'
import {
  artifactSink,
  commandOutput,
  operationSignal,
  resolveExecutable,
  retainedLogRefreshers,
  runChecked,
  setArtifactSink,
  setCommandOutput,
  setOperationSignal,
  setRunChecked,
  withTimeout,
  writeRedactedJson,
} from './runtime.mjs'
import { captureVerificationScreenshot } from './ui-helpers.mjs'
import { DesktopE2EServer } from './model-server.mjs'
import { buildDesktopApp, buildExecutor, writeCodexConfig } from './builds.mjs'
import { RealCloudEnvironment } from './cloud-environment.mjs'
import { runSelectionPhase } from './phases/selection.mjs'
import { runProjectsPhase } from './phases/projects.mjs'
import { runInitialTaskPhase } from './phases/initial-task.mjs'
import { runForksNavigationPhase } from './phases/forks-navigation.mjs'
import { runRecoveryPhase } from './phases/recovery.mjs'
import { runWorkspaceSessionPhase } from './phases/workspace-session.mjs'
import { runWorkspaceCreationPhase } from './phases/workspace-creation.mjs'
import { matrixCaseId } from './model-bindings.mjs'
import {
  createArtifactSink,
  createProcessEnvironment,
  createRedactedLogRetainer,
  stopProcessGroup,
  assertDesktopProcessIsolationSupported,
  combinePrimaryAndCleanupErrors,
} from '../process-lifecycle.mjs'
import { createOwnedProcessLauncher } from '../process-launcher.mjs'
import { createCommandSupport } from '../task-flow-command.mjs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPluginMarketplaceFixture } from '../task-flow-fixtures.mjs'
import { loadDesktopScenario } from '../scenario-loader.mjs'
import assert from 'node:assert/strict'

export async function main(context, display = null, deadlineAt = Date.now() + 2 * 60 * 60 * 1_000) {
  const { createRunContextDesktopOwner } =
    await import('../../../../e2e/harness/legacy-desktop-run.mjs')
  if (!context?.spawnOwned)
    throw new Error('Desktop task-flow requires its registered RunContext entry')
  assertDesktopProcessIsolationSupported()
  const owner = createRunContextDesktopOwner(context, {
    deadlineAt,
  })
  const launcher = createOwnedProcessLauncher({ owner })
  const artifactSecrets = new Set([
    MODEL_API_KEY,
    'studio-desktop-e2e-cloud-token',
    `studio-desktop-e2e-${process.pid}`,
    `studio-desktop-e2e-internal-${process.pid}`,
  ])
  setArtifactSink(createArtifactSink({ secrets: () => [...artifactSecrets] }))
  const commandSupport = createCommandSupport(owner, {
    environmentFor: (profile, overrides) =>
      createProcessEnvironment(profile, process.env, {
        ...(profile === 'runtime'
          ? {
              HOME: context.pathInState('command-home'),
              USERPROFILE: context.pathInState('command-home'),
              APPDATA: context.pathInState('command-appdata'),
              LOCALAPPDATA: context.pathInState('command-local-appdata'),
            }
          : {}),
        ...overrides,
      }),
  })
  setCommandOutput(commandSupport.commandOutput)
  setRunChecked(commandSupport.runChecked)
  for (const secret of artifactSecrets) context.registerSecret(secret)
  let primaryError = null
  try {
    await owner.runOperation(async signal => {
      setOperationSignal(
        context.abortSignal ? AbortSignal.any([signal, context.abortSignal]) : signal
      )
      try {
        await mkdir(resultDir, { recursive: true })
        const sidecarLogSourceDir = await mkdtemp(
          join(context.stateDir, 'studio-desktop-e2e-sidecar-')
        )
        owner.register('remove private sidecar log sources', () =>
          rm(sidecarLogSourceDir, { recursive: true, force: true })
        )
        const workspacePath = context.pathInState('workspace')
        const secondaryProjectPath = context.pathInState('secondary-project-root')
        const composerProjectPath = context.pathInState('composer-project')
        const homePath = context.pathInState('home')
        const executorHome = context.pathInState('executor-home')
        const pluginMarketplacePath = context.pathInState('plugin-marketplace')
        const appLogPath = join(resultDir, 'app.log')
        const executorLogPath = join(resultDir, 'executor.log')
        await Promise.all([
          mkdir(workspacePath, { recursive: true }),
          mkdir(secondaryProjectPath, { recursive: true }),
          mkdir(composerProjectPath, { recursive: true }),
          mkdir(homePath, { recursive: true }),
        ])
        await writeFile(join(workspacePath, GIT_SEED_NAME), GIT_SEED_CONTENT)
        await writeFile(join(workspacePath, 'auth.ts'), 'export const authenticated = true\n')
        await writeFile(
          join(workspacePath, IMAGE_ARTIFACT_NAME),
          Buffer.from(IMAGE_ARTIFACT_BASE64, 'base64')
        )
        await createPluginMarketplaceFixture(pluginMarketplacePath)
        await runChecked('git', ['init'], { cwd: workspacePath })
        await runChecked('git', ['config', 'user.name', 'Wework Desktop E2E'], {
          cwd: workspacePath,
        })
        await runChecked('git', ['config', 'user.email', 'desktop-e2e@studio.local'], {
          cwd: workspacePath,
        })
        await runChecked('git', ['add', GIT_SEED_NAME, 'auth.ts', IMAGE_ARTIFACT_NAME], {
          cwd: workspacePath,
        })
        await runChecked('git', ['commit', '-m', 'test: initialize desktop e2e workspace'], {
          cwd: workspacePath,
        })

        const desktopScenario = await loadDesktopScenario(
          process.env.KCODER_STUDIO_E2E_DESKTOP_SCENARIO_MODULE,
          {
            captureScreenshot: (control, name, selector) =>
              captureVerificationScreenshot(control, name, selector),
            resultDir,
            standalone: DESKTOP_SCENARIO_ONLY,
            uiTimeoutMs: UI_TIMEOUT_MS,
            workspacePath,
          }
        )
        if (DESKTOP_SCENARIO_ONLY && !desktopScenario) {
          throw new Error(
            'Desktop scenario-only mode requires KCODER_STUDIO_E2E_DESKTOP_SCENARIO_MODULE'
          )
        }
        const control = new DesktopE2EServer(workspacePath, workspacePath, desktopScenario)
        owner.register('desktop model and control servers', () => control.close())
        const modelSwitchVerification = []
        let app
        let appBundlePath
        let cloudEnvironment
        let desktopCloudToken = 'studio-desktop-e2e-cloud-token'
        let phase = 'startup'
        const phaseState = {
          get phase() {
            return phase
          },
          set phase(value) {
            phase = value
          },
          get app() {
            return app
          },
        }
        try {
          await control.start()
          context.registerPort('legacy-model', Number(new URL(control.url).port))
          context.registerPort('legacy-control', Number(new URL(control.controlUrl).port))
          const codexBinary = await resolveExecutable(
            process.env.CODEX_BIN ?? process.env.CODEX_BINARY_PATH,
            'codex',
            'Codex binary'
          )
          const codexVersion = await commandOutput(codexBinary, ['--version'])
          assert.ok(codexVersion.length > 0, 'Real Codex did not return a version')
          console.log(`Using real Codex: ${codexVersion}`)

          const appIdentifier = `dev.kcoder.studio.e2e.run${process.pid}`
          const executorBinary = await buildExecutor()
          if (CLOUD_ONLY) {
            cloudEnvironment = new RealCloudEnvironment({
              codexBinary,
              context,
              registerSecret: secret => {
                artifactSecrets.add(secret)
                context.registerSecret(secret)
              },
              executorBinary,
              launcher,
              modelServerUrl: control.url,
              owner,
              sidecarLogSourceDir,
              workspacePath,
            })
            await cloudEnvironment.start()
          }
          desktopCloudToken =
            cloudEnvironment?.authToken ?? desktopScenario?.authToken ?? desktopCloudToken
          artifactSecrets.add(desktopCloudToken)
          context.registerSecret(desktopCloudToken)
          const desktopApp = await buildDesktopApp(
            control.controlUrl,
            cloudEnvironment?.backendUrl ?? control.url,
            desktopCloudToken,
            appIdentifier,
            control.url
          )
          const appBinary = desktopApp.binaryPath
          appBundlePath = desktopApp.appBundlePath
          if (appBundlePath) {
            owner.register('macOS application registration', ({ deadlineAt }) =>
              commandOutput(MACOS_LAUNCH_SERVICES_REGISTER, ['-u', appBundlePath], {
                deadlineAt,
                profile: 'runtime',
              })
            )
          }
          await writeCodexConfig(
            join(executorHome, 'codex'),
            control.url,
            desktopScenario?.codexConfigToml
          )

          const appEnvironment = createProcessEnvironment('runtime', process.env, {
            ...(display ? { DISPLAY: display.display, XAUTHORITY: display.authority } : {}),
            KCODER_STUDIO_APP_CONFIG_DIR: context.pathInState('native-app-config'),
            CODEX_BIN: codexBinary,
            CODEX_HOME: undefined,
            HOME: homePath,
            USERPROFILE: homePath,
            APPDATA: context.pathInState('native-appdata'),
            LOCALAPPDATA: context.pathInState('native-local-appdata'),
            XDG_CONFIG_HOME: context.pathInState('native-xdg-config'),
            XDG_CACHE_HOME: context.pathInState('native-xdg-cache'),
            XDG_DATA_HOME: context.pathInState('native-xdg-data'),
            WEGENT_CODEX_HOME: join(executorHome, 'codex'),
            WEGENT_EXECUTOR_HOME: executorHome,
            KCODER_STUDIO_EXECUTOR_ISOLATION_OVERRIDE: 'false',
            WEGENT_EXECUTOR_LOG_DIR: sidecarLogSourceDir,
            WEGENT_EXECUTOR_LOG_FILE: 'executor.log',
            DEVICE_ID: `studio-e2e-device-${process.pid}`,
            DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
            DEVICE_SESSION_GATEWAY_PORT: '0',
            VITE_KCODER_STUDIO_E2E: 'true',
            KCODER_STUDIO_E2E_MODEL_API_KEY: MODEL_API_KEY,
            KCODER_STUDIO_EMBEDDED_BROWSER_BRIDGE_ADDR: '127.0.0.1:0',
            KCODER_STUDIO_EXECUTOR_SIDECAR: executorBinary,
          })
          const executorLogRetainer = createRedactedLogRetainer({
            source: join(sidecarLogSourceDir, 'executor.log'),
            destination: executorLogPath,
            secrets: () => [MODEL_API_KEY, desktopCloudToken],
          })
          retainedLogRefreshers.set(executorLogPath, executorLogRetainer)
          owner.register('retain redacted local executor runtime log', async () => {
            try {
              await executorLogRetainer.sync({ final: true })
            } finally {
              retainedLogRefreshers.delete(executorLogPath)
            }
          })
          const startDesktopAppProcess = async () => {
            const child = await launcher.launch({
              command: appBinary,
              cwd: rendererDir,
              env: appEnvironment,
              resourceName: `desktop application process group`,
              logPath: appLogPath,
              secrets: [MODEL_API_KEY, desktopCloudToken],
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: process.platform !== 'win32',
            })
            return child
          }
          app = await startDesktopAppProcess()
          const restartDesktopApp = async () => {
            const readyCountBeforeRestart = control.readyCount
            await stopProcessGroup(app)
            owner.releaseProcess(app)
            app = await startDesktopAppProcess()
            await withTimeout(
              control.awaitReadyAfter(readyCountBeforeRestart),
              WORKBENCH_READY_TIMEOUT_MS,
              'The restarted KCoder Studio application did not reconnect to the desktop controller'
            )
            await control.command('focusMainWindow', 'body')
          }

          const ready = await withTimeout(
            control.awaitReady(),
            DESKTOP_READY_TIMEOUT_MS,
            'Timed out waiting for the real Tauri application to connect to the Desktop E2E controller'
          )
          assert.match(
            String(ready.location ?? ''),
            /^(tauri|http):/,
            'The desktop controller did not connect from a webview'
          )
          await control.command('focusMainWindow', 'body')

          const runSelectionPhaseResult = await runSelectionPhase(
            {
              workspacePath,
              executorHome,
              pluginMarketplacePath,
              executorLogPath,
              desktopScenario,
              control,
              cloudEnvironment,
              appIdentifier,
              restartDesktopApp,
            },
            phaseState
          )
          if (runSelectionPhaseResult.stop) return

          const runProjectsPhaseResult = await runProjectsPhase(
            { workspacePath, secondaryProjectPath, control },
            phaseState
          )
          if (runProjectsPhaseResult.stop) return
          const { composerSelector, projectId, projectRowSelector } = runProjectsPhaseResult
          const runInitialTaskPhaseResult = await runInitialTaskPhase(
            { workspacePath, control, cloudEnvironment, composerSelector, projectRowSelector },
            phaseState
          )
          if (runInitialTaskPhaseResult.stop) return
          const { taskRowTestId } = runInitialTaskPhaseResult

          const runForksNavigationPhaseResult = await runForksNavigationPhase(
            {
              workspacePath,
              executorHome,
              control,
              modelSwitchVerification,
              cloudEnvironment,
              composerSelector,
              projectRowSelector,
              taskRowTestId,
            },
            phaseState
          )
          if (runForksNavigationPhaseResult.stop) return

          const runRecoveryPhaseResult = await runRecoveryPhase(
            { executorLogPath, control, appIdentifier, restartDesktopApp, composerSelector },
            phaseState
          )
          if (runRecoveryPhaseResult.stop) return

          const runWorkspaceSessionPhaseResult = await runWorkspaceSessionPhase(
            { control, composerSelector, taskRowTestId },
            phaseState
          )
          if (runWorkspaceSessionPhaseResult.stop) return

          const runWorkspaceCreationPhaseResult = await runWorkspaceCreationPhase(
            {
              workspacePath,
              composerProjectPath,
              executorHome,
              desktopScenario,
              control,
              cloudEnvironment,
              appIdentifier,
              restartDesktopApp,
              composerSelector,
              projectId,
              taskRowTestId,
            },
            phaseState
          )
          if (runWorkspaceCreationPhaseResult.stop) return
        } catch (error) {
          if (operationSignal?.aborted) throw error
          const diagnosticErrors = []
          const writeDiagnostic = async operation => {
            try {
              await withTimeout(
                operation(),
                Math.max(1, Math.min(5_000, owner.remainingMs())),
                'Timed out writing desktop E2E diagnostics before the cleanup reserve'
              )
            } catch (diagnosticError) {
              diagnosticErrors.push(diagnosticError)
            }
          }
          await writeDiagnostic(() =>
            writeRedactedJson(join(resultDir, 'model-requests.json'), control.modelRequests)
          )
          await writeDiagnostic(() =>
            artifactSink.writeJson(join(resultDir, 'scenario-state.json'), {
              phase,
              scenario: control.scenario,
              modelStage: control.modelStage,
              localProtocolStates: Object.fromEntries(
                [...control.localProtocolStates.entries()].map(([protocol, state]) => [
                  protocol,
                  { stage: state.stage, requestCount: state.requests.length },
                ])
              ),
              desktopScenario: desktopScenario?.diagnostics?.() ?? null,
              cloudModelStage: control.cloudModelStage,
              matrixCase: control.matrixCase ? matrixCaseId(control.matrixCase) : null,
              matrixStage: control.matrixState?.stage ?? null,
              matrixRequestCount: control.matrixState?.requests.length ?? 0,
              scenarioRequestCounts: Object.fromEntries(
                [...control.scenarioRequests.entries()].map(([name, requests]) => [
                  name,
                  requests.length,
                ])
              ),
              commandHistory: control.commandHistory,
            })
          )
          try {
            const snapshot = await control.command('snapshot', 'body', {
              timeoutMs: Math.max(1, Math.min(5_000, owner.remainingMs())),
            })
            await writeDiagnostic(() =>
              artifactSink.writeText(join(resultDir, 'ui-snapshot.json'), `${snapshot}\n`)
            )
          } catch (diagnosticError) {
            // Preserve the original test failure when the WebView can no longer answer diagnostics.
            diagnosticErrors.push(diagnosticError)
          }
          await writeDiagnostic(() =>
            artifactSink.writeText(
              join(resultDir, 'failure.txt'),
              `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
            )
          )
          if (diagnosticErrors.length > 0) {
            throw new AggregateError(
              [error, ...diagnosticErrors],
              'Desktop E2E failed while writing diagnostics',
              { cause: error }
            )
          }
          throw error
        }
      } finally {
        setOperationSignal(undefined)
      }
    })
  } catch (error) {
    primaryError = error
  } finally {
    let cleanupError = null
    try {
      await owner.cleanup()
    } catch (error) {
      cleanupError = error
    }
    const finalError = combinePrimaryAndCleanupErrors(primaryError, cleanupError)
    if (finalError) throw finalError
  }
}
