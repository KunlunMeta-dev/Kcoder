import { getRuntimeConfig, stripAppBasePath } from '@/config/runtime'
import { sessionAddress, type SessionAddress } from '../../../shared/peerAgentMessage'

function joinBrowserPath(basePath: string | undefined, path: string): string {
  const normalizedBasePath = !basePath || basePath === '/' ? '' : basePath.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  if (!normalizedBasePath) return normalizedPath
  if (normalizedPath === '/') return `${normalizedBasePath}/`
  return `${normalizedBasePath}${normalizedPath}`
}

export function toBrowserPath(path: string): string {
  return joinBrowserPath(getRuntimeConfig().appBasePath, path)
}

/** Replace the retired settings URL before any route consumer reads it. */
export function redirectLegacyConnectorRoute() {
  const path = stripAppBasePath(window.location.pathname).replace(/\/+$/, '')
  if (path === '/settings/channels') {
    const { search, hash } = window.location
    window.history.replaceState(window.history.state, '', toBrowserPath('/channels') + search + hash)
  }
}

export function navigateTo(path: string) {
  const browserPath = toBrowserPath(path)
  const currentPath = `${window.location.pathname}${window.location.search}`
  if (currentPath === browserPath) return

  const currentRoute = stripAppBasePath(window.location.pathname)
  if (parseRuntimeTaskRoute(currentRoute, window.location.search)) {
    try {
      window.sessionStorage.setItem(
        'kcoder.lastConversationRoute',
        `${currentRoute}${window.location.search}`
      )
    } catch {
      // Navigation remains available when browser storage is disabled.
    }
  }

  window.history.pushState({}, '', browserPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function navigateToLastConversation() {
  let route: string | null = null
  try {
    route = window.sessionStorage.getItem('kcoder.lastConversationRoute')
  } catch {
    // The workbench can still display its currently selected conversation.
  }
  const url =
    route && route.startsWith('/') && !route.startsWith('//')
      ? new URL(route, window.location.origin)
      : null
  navigateTo(
    url && parseRuntimeTaskRoute(url.pathname, url.search) ? `${url.pathname}${url.search}` : '/'
  )
}

/** Return to the logical parent, independent of browser history or direct entry. */
export function parentPageRoute(path: string, search = ''): string {
  if (!path.startsWith('/') || path.startsWith('//')) return '/'
  const normalized = path.replace(/\/+$/, '') || '/'
  if (normalized === '/runtime-tasks') return '/tasks'
  if (normalized === '/expert-conversations') return '/experts'
  if (normalized === '/plugins' && new URLSearchParams(search).has('view')) return '/plugins'
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : '/'
}

export function navigateToParentPage() {
  navigateTo(parentPageRoute(stripAppBasePath(window.location.pathname), window.location.search))
}

export interface RuntimeTaskRoute {
  deviceId: string
  taskId: string
  workspacePath?: string | null
  expectedSessionAddress?: SessionAddress
}

export type RuntimeTaskRouteInput = RuntimeTaskRoute

function getRequiredSearchParam(
  searchParams: URLSearchParams,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = searchParams.get(name)
    if (value && value.trim()) {
      return value
    }
  }
  return undefined
}

export function parseRuntimeTaskRoute(path: string, search = ''): RuntimeTaskRoute | null {
  if (path !== '/runtime-tasks' && path !== '/expert-conversations') return null

  const searchParams = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const deviceId = getRequiredSearchParam(searchParams, 'deviceId', 'device_id')
  const taskIdParam = getRequiredSearchParam(searchParams, 'taskId', 'task_id')
  if (!deviceId || !taskIdParam) return null
  let expectedSessionAddress: SessionAddress | null = null
  if (searchParams.has('expectedSessionAddress')) {
    if (searchParams.getAll('expectedSessionAddress').length !== 1) return null
    try { expectedSessionAddress = sessionAddress(JSON.parse(searchParams.get('expectedSessionAddress')!)) }
    catch { return null }
    if (!expectedSessionAddress || taskIdParam !== `kcoder:${deviceId}:${expectedSessionAddress.threadId}`) return null
  }

  return {
    deviceId,
    taskId: taskIdParam,
    ...(expectedSessionAddress ? { expectedSessionAddress } : {}),
    ...(path === '/expert-conversations'
      ? { workspacePath: getRequiredSearchParam(searchParams, 'workspacePath') }
      : {}),
  }
}

export function buildRuntimeTaskRoute(address: RuntimeTaskRouteInput): string {
  const searchParams = new URLSearchParams()
  searchParams.set('deviceId', address.deviceId)
  searchParams.set('taskId', String(address.taskId))
  if (address.expectedSessionAddress !== undefined) {
    const expected = sessionAddress(address.expectedSessionAddress)
    if (!expected || address.taskId !== `kcoder:${address.deviceId}:${expected.threadId}`)
      throw new Error('SESSION_ADDRESS_EXPECTATION_INVALID')
    searchParams.set('expectedSessionAddress', JSON.stringify(expected))
  }
  return `/runtime-tasks?${searchParams.toString()}`
}

export function isSettingsRoute(path: string): boolean {
  return path === '/settings' || path.startsWith('/settings/')
}
