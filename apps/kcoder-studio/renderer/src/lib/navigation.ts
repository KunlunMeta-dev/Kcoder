import { getRuntimeConfig, stripAppBasePath } from '@/config/runtime'

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

export function navigateTo(path: string) {
  const browserPath = toBrowserPath(path)
  const currentPath = `${window.location.pathname}${window.location.search}`
  if (currentPath === browserPath) return

  window.history.pushState({}, '', browserPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
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

  return {
    deviceId,
    taskId: taskIdParam,
    ...(path === '/expert-conversations'
      ? { workspacePath: getRequiredSearchParam(searchParams, 'workspacePath') }
      : {}),
  }
}

export function buildRuntimeTaskRoute(address: RuntimeTaskRouteInput): string {
  const searchParams = new URLSearchParams()
  searchParams.set('deviceId', address.deviceId)
  searchParams.set('taskId', String(address.taskId))
  return `/runtime-tasks?${searchParams.toString()}`
}

export function isSettingsRoute(path: string): boolean {
  return path === '/settings' || path.startsWith('/settings/')
}
