import { join } from 'node:path'

export function validateAiVerifyGatewayOrigin(value) {
  const match = typeof value === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value)
  if (!match || Number(match[1]) > 65535) {
    throw new Error('Gateway verification requires an owned http://127.0.0.1:<port> origin')
  }
  return value
}

export function buildAiVerifyGatewayEnvironment(
  processEnvironment,
  { gatewayOrigin, controlUrl, token, sessionDirectory }
) {
  const environment = {}
  // Only operating-system launch essentials cross this boundary, never application settings.
  for (const key of ['PATH', 'DISPLAY', 'LANG', 'LC_ALL', 'TZ']) {
    if (processEnvironment[key] !== undefined) environment[key] = processEnvironment[key]
  }
  return {
    ...environment,
    HOME: join(sessionDirectory, 'native-home'),
    XDG_CONFIG_HOME: join(sessionDirectory, 'native-home', '.config'),
    XDG_CACHE_HOME: join(sessionDirectory, 'native-home', '.cache'),
    XDG_DATA_HOME: join(sessionDirectory, 'native-home', '.local', 'share'),
    KCODER_STUDIO_APP_CONFIG_DIR: join(sessionDirectory, 'app-config'),
    KCODER_STUDIO_AI_VERIFY_GATEWAY_ORIGIN: validateAiVerifyGatewayOrigin(gatewayOrigin),
    KCODER_STUDIO_AI_VERIFY_CONTROL_URL: validateAiVerifyGatewayOrigin(controlUrl),
    KCODER_STUDIO_AI_VERIFY_CONTROL_TOKEN: token,
  }
}

const INHERITED_EXECUTOR_ENV_KEYS = [
  'WEGENT_EXECUTOR_APP_IPC_ADDR',
  'WEGENT_EXECUTOR_APP_IPC_ADDR_FILE',
  'WEGENT_EXECUTOR_APP_IPC_SOCKET',
  'WEGENT_EXECUTOR_BINARY',
  'WEGENT_EXECUTOR_SOURCE_DIR',
  'KCODER_STUDIO_EXECUTOR_SIDECAR',
  'KCODER_STUDIO_SHARED_EXECUTOR_HOME',
]

export function buildAiVerifyEnvironment(
  processEnvironment,
  {
    controlUrl,
    token,
    codexHome,
    nativeCodexHome,
    verifyCodexHomeInitialization,
    deviceId,
    appIdentifier,
    executorHome,
    sessionDirectory,
  }
) {
  const isolatedEnvironment = { ...processEnvironment }
  for (const key of INHERITED_EXECUTOR_ENV_KEYS) delete isolatedEnvironment[key]

  return {
    ...isolatedEnvironment,
    VITE_KCODER_STUDIO_E2E: 'true',
    VITE_KCODER_STUDIO_DESKTOP_E2E_CONTROL_URL: controlUrl,
    VITE_KCODER_STUDIO_DESKTOP_E2E_CONTROL_TOKEN: token,
    CODEX_HOME: codexHome,
    WEGENT_CODEX_HOME: codexHome,
    ...(nativeCodexHome ? { KCODER_STUDIO_E2E_NATIVE_CODEX_HOME: nativeCodexHome } : {}),
    ...(verifyCodexHomeInitialization ? { VITE_KCODER_STUDIO_E2E_CODEX_HOME_INITIALIZATION: 'true' } : {}),
    DEVICE_ID: deviceId,
    KCODER_STUDIO_APP_IDENTIFIER: appIdentifier,
    DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
    DEVICE_SESSION_GATEWAY_PORT: '0',
    WEGENT_EXECUTOR_HOME: executorHome,
    WEGENT_EXECUTOR_DEV_RELOAD: '0',
    KCODER_STUDIO_EXECUTOR_ISOLATION_OVERRIDE: 'true',
    KCODER_STUDIO_DISABLE_BACKGROUND_THROTTLING: '1',
    WEGENT_EXECUTOR_PROJECTS_DIR: join(executorHome, 'workspace', 'projects'),
    WEGENT_EXECUTOR_LOG_DIR: sessionDirectory,
    KCODER_STUDIO_APP_CONFIG_DIR: join(sessionDirectory, 'app-config'),
  }
}
