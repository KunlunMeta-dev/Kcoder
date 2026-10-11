// builds for the existing desktop runner.
import {
  CLOUD_ONLY,
  DEFAULT_MODEL_ID,
  MACOS_LAUNCH_SERVICES_REGISTER,
  MEMORY_ONLY,
  MODEL_PROVIDER_ID,
  PLUGINS_ONLY,
  rendererDir,
  repoDir,
  stateDir,
} from './config.mjs'
import { commandOutput, resolveExecutable, runChecked } from './runtime.mjs'
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { isExecutable } from '../task-flow-command.mjs'
import { createProcessEnvironment } from '../process-lifecycle.mjs'

export async function writeCodexConfig(
  codexHome,
  modelServerUrl,
  scenarioConfigToml = '',
  upstreamApiFormat = 'openai-responses'
) {
  await mkdir(codexHome, { recursive: true })
  await writeFile(
    join(codexHome, 'config.toml'),
    `model_provider = "${MODEL_PROVIDER_ID}"\nmodel = "${DEFAULT_MODEL_ID}"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n${scenarioConfigToml}\n[model_providers.${MODEL_PROVIDER_ID}]\nname = "Wework Desktop E2E"\nbase_url = "${modelServerUrl}/v1"\nenv_key = "KCODER_STUDIO_E2E_MODEL_API_KEY"\nwire_api = "responses"\nupstream_api_format = "${upstreamApiFormat}"\n`,
    'utf8'
  )
}

export function codexUpstreamApiFormat(protocol) {
  return protocol === 'responses'
    ? 'openai-responses'
    : protocol === 'chat'
      ? 'openai-chat-completions'
      : 'anthropic-messages'
}

export async function buildExecutor() {
  const configured = process.env.KCODER_STUDIO_E2E_EXECUTOR_BIN
  if (configured)
    return resolveExecutable(configured, 'wegent-executor', 'Configured Wework executor')

  await runChecked('cargo', ['build', '--locked', '--bin', 'wegent-executor'], {
    cwd: join(repoDir, 'executor'),
  })
  const binaryName = process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
  const binaryPath = join(repoDir, 'executor', 'target', 'debug', binaryName)
  assert.equal(await isExecutable(binaryPath), true, `Executor build did not produce ${binaryPath}`)
  return binaryPath
}

export async function readTauriMainBinaryName() {
  const configPath = join(rendererDir, 'src-tauri', 'tauri.conf.json')
  try {
    const raw = await readFile(configPath, 'utf8')
    const config = JSON.parse(raw)
    return config.mainBinaryName || 'app'
  } catch {
    return 'app'
  }
}

export async function readTauriE2EWindowConfig() {
  const configPath = join(rendererDir, 'src-tauri', 'tauri.conf.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const windows = config.app?.windows
  assert.ok(Array.isArray(windows) && windows.length > 0, 'Tauri main window config is missing')
  return windows.map(windowConfig => ({
    ...windowConfig,
    backgroundThrottling: 'disabled',
  }))
}

export async function wrapMacDesktopApp(binaryPath, binaryName, appIdentifier) {
  if (process.platform !== 'darwin') return { binaryPath, appBundlePath: null }

  const appBundlePath = join(stateDir, `WeWork-E2E-${process.pid}.app`)
  const contentsPath = join(appBundlePath, 'Contents')
  const bundledBinaryPath = join(contentsPath, 'MacOS', binaryName)
  await mkdir(join(contentsPath, 'MacOS'), { recursive: true })
  await symlink(binaryPath, bundledBinaryPath)
  await writeFile(
    join(contentsPath, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${binaryName}</string>
  <key>CFBundleIdentifier</key><string>${appIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>WeWork E2E ${process.pid}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
    'utf8'
  )
  await commandOutput(MACOS_LAUNCH_SERVICES_REGISTER, ['-f', appBundlePath])
  return { binaryPath: bundledBinaryPath, appBundlePath }
}

export async function buildDesktopApp(
  controlUrl,
  cloudBackendUrl,
  cloudToken,
  appIdentifier,
  modelServerUrl
) {
  const configured = process.env.KCODER_STUDIO_E2E_APP_BIN
  if (configured) {
    const binaryPath = await resolveExecutable(configured, 'app', 'Configured Wework desktop app')
    return wrapMacDesktopApp(binaryPath, binaryPath.split('/').at(-1), appIdentifier)
  }

  const windows = await readTauriE2EWindowConfig()
  await runChecked(
    'pnpm',
    [
      'exec',
      'tauri',
      'build',
      '--debug',
      '--no-bundle',
      '--config',
      JSON.stringify({
        identifier: appIdentifier,
        app: {
          windows,
          security: {
            capabilities: [
              'default',
              {
                identifier: 'desktop-e2e-focus',
                description: 'Allows the desktop E2E runner to keep WebKit timers unthrottled',
                windows: ['main'],
                permissions: [
                  'core:window:allow-set-focus',
                  'core:window:allow-show',
                  'core:window:allow-unminimize',
                ],
              },
            ],
          },
        },
      }),
    ],
    {
      cwd: rendererDir,
      env: createProcessEnvironment('build', process.env, {
        VITE_KCODER_STUDIO_DESKTOP_E2E_CONTROL_URL: controlUrl,
        VITE_KCODER_STUDIO_E2E_CLOUD_BACKEND_URL: cloudBackendUrl,
        VITE_KCODER_STUDIO_E2E_CLOUD_TOKEN: cloudToken,
        VITE_KCODER_STUDIO_E2E_MODEL_SERVER_URL: modelServerUrl,
        VITE_KCODER_STUDIO_E2E_LOCAL_MODELS_CATALOG_READY: CLOUD_ONLY ? 'true' : 'false',
        VITE_KCODER_STUDIO_E2E: 'true',
        VITE_KCODER_STUDIO_E2E_SEED_LOCAL_MODELS: PLUGINS_ONLY || MEMORY_ONLY ? 'false' : 'true',
        VITE_KCODER_STUDIO_RUNTIME_MODE: 'local-first',
      }),
    }
  )
  const mainBinaryName = await readTauriMainBinaryName()
  const binaryName = process.platform === 'win32' ? `${mainBinaryName}.exe` : mainBinaryName
  const candidates = [
    join(rendererDir, 'src-tauri', 'target', 'debug', binaryName),
    join(
      rendererDir,
      'src-tauri',
      'target',
      'debug',
      'bundle',
      'macos',
      'WeWork.app',
      'Contents',
      'MacOS',
      binaryName
    ),
  ]
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return wrapMacDesktopApp(candidate, binaryName, appIdentifier)
    }
  }
  throw new Error(
    `Tauri build did not produce an executable app. Checked: ${candidates.join(', ')}`
  )
}
