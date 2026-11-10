import { expect, test } from 'vitest'
import {
  getDesktopSidebarStorageKey,
  readStoredBoolean,
  readStoredNumberSet,
  writeStoredBoolean,
  writeStoredNumberSet,
} from './sidebarPersistence'

test('sidebar preferences migrate in the same user scope and prioritize new values', () => {
  const expandedKey = getDesktopSidebarStorageKey('7', 'projectsExpanded')
  const projectsKey = getDesktopSidebarStorageKey('7', 'expandedProjectIds')
  localStorage.setItem('wework.desktop.sidebar.projectsExpanded.7', 'false')
  localStorage.setItem('wework.desktop.sidebar.expandedProjectIds.7', '[42]')

  expect(readStoredBoolean(expandedKey, true)).toBe(false)
  expect(readStoredNumberSet(projectsKey)).toEqual(new Set([42]))
  expect(readStoredNumberSet(getDesktopSidebarStorageKey('8', 'expandedProjectIds'))).toEqual(new Set())

  writeStoredBoolean(expandedKey, true)
  writeStoredNumberSet(projectsKey, new Set())

  expect(localStorage.getItem('kcoder.desktop.sidebar.projectsExpanded.7')).toBe('true')
  expect(localStorage.getItem('kcoder.desktop.sidebar.expandedProjectIds.7')).toBe('[]')
  expect(readStoredBoolean(expandedKey, false)).toBe(true)
  expect(readStoredNumberSet(projectsKey)).toEqual(new Set())
})
