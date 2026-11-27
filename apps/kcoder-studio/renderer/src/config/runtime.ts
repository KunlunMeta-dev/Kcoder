export type RuntimeMode = 'local-first' | 'backend'

export interface RuntimeConfig {
  appBasePath: string
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
  wegentBackendUrl: string
  runtimeMode: RuntimeMode
  cloudDeviceScalingWikiUrl: string
}

type RuntimeConfigOverrides = Partial<RuntimeConfig>

declare global {
  interface Window {
    __KCODER_STUDIO_RUNTIME_CONFIG__?: RuntimeConfigOverrides
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function runtimeOverrides(): RuntimeConfigOverrides {
  if (typeof window === 'undefined') {
    return {}
  }

  const configured = window.__KCODER_STUDIO_RUNTIME_CONFIG__ ?? {}
  const injectedBasePath = document.querySelector<HTMLMetaElement>(
    'meta[name="kcoder-app-base-path"]'
  )?.content
  return !configured.appBasePath && injectedBasePath
    ? { ...configured, appBasePath: injectedBasePath }
    : configured
}

function runtimeString(
  overrides: RuntimeConfigOverrides,
  key: keyof RuntimeConfig
): string | undefined {
  const value = overrides[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isValidRuntimeMode(value: string): value is RuntimeMode {
  return value === 'local-first' || value === 'backend'
}

function resolveRuntimeMode(overrides: RuntimeConfigOverrides): RuntimeMode {
  const runtimeValue = runtimeString(overrides, 'runtimeMode')
  if (runtimeValue && isValidRuntimeMode(runtimeValue)) {
    return runtimeValue
  }

  const envValue = import.meta.env.VITE_KCODER_STUDIO_RUNTIME_MODE
  if (envValue && isValidRuntimeMode(envValue)) {
    return envValue
  }

  return 'local-first'
}

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === '/') {
    return ''
  }

  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`
  return trimTrailingSlash(withLeadingSlash)
}

export function joinAppPath(basePath: string, path: string): string {
  const normalizedBasePath = normalizeBasePath(basePath)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  if (!normalizedBasePath) {
    return normalizedPath
  }

  if (normalizedPath === '/') {
    return `${normalizedBasePath}/`
  }

  return `${normalizedBasePath}${normalizedPath}`
}

export function stripAppBasePath(path: string): string {
  const appBasePath = getRuntimeConfig().appBasePath
  if (!appBasePath || path === appBasePath) {
    return path === appBasePath ? '/' : path
  }

  if (path.startsWith(`${appBasePath}/`)) {
    return path.slice(appBasePath.length) || '/'
  }

  return path
}

function normalizeBackendUrl(value: string): string {
  const url = new URL(value)
  const segments = url.pathname.split('/').filter(Boolean)
  const apiIndex = segments.indexOf('api')
  const backendSegments = apiIndex >= 0 ? segments.slice(0, apiIndex) : segments
  const backendPath = backendSegments.length > 0 ? `/${backendSegments.join('/')}` : ''
  return trimTrailingSlash(`${url.origin}${backendPath}`)
}

export function getConfiguredSocketBaseUrl(): string {
  const overrides = runtimeOverrides()
  return (
    runtimeString(overrides, 'socketBaseUrl') ||
    import.meta.env.VITE_WEGENT_SOCKET_URL?.trim() ||
    ''
  )
}

export function getRuntimeConfig(): RuntimeConfig {
  const overrides = runtimeOverrides()
  const gatewayPage = Boolean(
    globalThis.document?.querySelector<HTMLMetaElement>('meta[name="kcoder-rpc-token"]')?.content
  )
  const gatewayPrefix = gatewayPage
    ? document.querySelector<HTMLMetaElement>('meta[name="kcoder-app-base-path"]')?.content
    : undefined
  const appBasePath = normalizeBasePath(
    gatewayPrefix ||
      runtimeString(overrides, 'appBasePath') ||
      import.meta.env.VITE_APP_BASE_PATH ||
      import.meta.env.BASE_URL
  )
  if (gatewayPage) {
    return {
      appBasePath,
      apiBaseUrl: joinAppPath(appBasePath, '/api'),
      socketBaseUrl: window.location.origin,
      socketPath: joinAppPath(appBasePath, '/socket.io'),
      wegentBackendUrl: '',
      runtimeMode: 'local-first',
      cloudDeviceScalingWikiUrl: '',
    }
  }
  const configuredBackendUrl =
    runtimeString(overrides, 'wegentBackendUrl') ||
    import.meta.env.VITE_WEGENT_BACKEND_URL?.trim() ||
    ''
  const wegentBackendUrl = configuredBackendUrl ? normalizeBackendUrl(configuredBackendUrl) : ''
  const apiBaseUrl =
    runtimeString(overrides, 'apiBaseUrl') ||
    (wegentBackendUrl ? `${wegentBackendUrl}/api` : joinAppPath(appBasePath, '/api'))
  const socketBaseUrl = getConfiguredSocketBaseUrl() || wegentBackendUrl || window.location.origin
  const socketPath =
    runtimeString(overrides, 'socketPath') || joinAppPath(appBasePath, '/socket.io')

  return {
    appBasePath,
    apiBaseUrl: trimTrailingSlash(apiBaseUrl),
    socketBaseUrl: trimTrailingSlash(socketBaseUrl),
    socketPath,
    wegentBackendUrl,
    runtimeMode: resolveRuntimeMode(overrides),
    cloudDeviceScalingWikiUrl:
      runtimeString(overrides, 'cloudDeviceScalingWikiUrl') ||
      import.meta.env.VITE_CLOUD_DEVICE_SCALING_WIKI_URL ||
      '',
  }
}
