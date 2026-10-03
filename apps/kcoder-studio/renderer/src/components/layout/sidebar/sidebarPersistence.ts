import type { ProjectWithTasks, User as UserProfile } from '@/types/api'

export const DESKTOP_SIDEBAR_STORAGE_PREFIX = 'wework.desktop.sidebar'

export function getDesktopSidebarStorageScope(user: UserProfile | null): string {
  return user?.id ? String(user.id) : 'anonymous'
}

export function getDesktopSidebarStorageKey(scope: string, key: string): string {
  return `${DESKTOP_SIDEBAR_STORAGE_PREFIX}.${key}.${scope}`
}

export function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key)
    if (value === null) return fallback
    return value === 'true'
  } catch {
    return fallback
  }
}

export function writeStoredBoolean(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false')
  } catch {
    // Keep the in-memory sidebar state when browser storage is unavailable.
  }
}

export function readStoredNumberSet(key: string): Set<number> {
  try {
    const value = window.localStorage.getItem(key)
    if (!value) return new Set()
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is number => Number.isInteger(item) && item > 0))
  } catch {
    return new Set()
  }
}

export function writeStoredNumberSet(key: string, values: Set<number>) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...values].sort((a, b) => a - b)))
  } catch {
    // Keep the in-memory sidebar state when browser storage is unavailable.
  }
}

export function pruneProjectIdSet(values: Set<number>, projects: ProjectWithTasks[]): Set<number> {
  if (projects.length === 0) return values
  const projectIds = new Set(projects.map(project => project.id))
  return new Set([...values].filter(projectId => projectIds.has(projectId)))
}
