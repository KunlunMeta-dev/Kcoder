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
  { sessionDirectory }
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
  }
}
