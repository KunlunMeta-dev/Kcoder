import { expect, test } from 'vitest'
import { expertPersonalizationRoute, readExpertSettingsScope } from './personalizationRoutes'

test('expert skills keep the exact owner while channels retain only target and workspace', () => {
  const scope = {
    deviceId: 'remote-owned',
    workspacePath: '/workspace/a b',
    expertId: 'personal.original',
  }
  const skills = expertPersonalizationRoute(scope)
  expect(readExpertSettingsScope(skills.slice(skills.indexOf('?')))).toEqual(scope)
  const route = expertPersonalizationRoute(scope, 'channels')
  expect(route.startsWith('/channels?')).toBe(true)
  const query = new URLSearchParams(route.slice(route.indexOf('?')))
  expect(query.get('deviceId')).toBe(scope.deviceId)
  expect(query.get('workspacePath')).toBe(scope.workspacePath)
  expect(query.has('expertId')).toBe(false)
  for (const query of [
    '?expertId=personal.original',
    '?deviceId=another&expertId=personal.original',
    '',
  ]) {
    expect(readExpertSettingsScope(query)).toBeNull()
  }
})

test('expert tools retain the same expert, target and project as skills', () => {
  const scope = {
    deviceId: 'remote',
    workspacePath: '/original-project',
    expertId: 'personal.original',
  }
  const route = expertPersonalizationRoute(scope, 'tools')
  expect(route.startsWith('/personalization/tools?')).toBe(true)
  expect(readExpertSettingsScope(route.slice(route.indexOf('?')))).toEqual(scope)
})
