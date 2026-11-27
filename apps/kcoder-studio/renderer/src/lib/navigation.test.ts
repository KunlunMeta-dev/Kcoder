import { afterEach, describe, expect, test } from 'vitest'
import {
  buildRuntimeTaskRoute,
  navigateTo,
  navigateToLastConversation,
  parseRuntimeTaskRoute,
  redirectLegacyConnectorRoute,
  parentPageRoute,
} from './navigation'

afterEach(() => {
  window.sessionStorage.removeItem('kcoder.lastConversationRoute')
  window.history.replaceState({}, '', '/')
})

test('replaces the old connector settings bookmark while preserving query, hash and history state', () => {
  window.history.replaceState({ source: 'bookmark' }, '', '/settings/channels/?tab=connections#active')
  const length = window.history.length
  redirectLegacyConnectorRoute()
  expect(window.location.pathname + window.location.search + window.location.hash).toBe('/channels?tab=connections#active')
  expect(window.history.state).toEqual({ source: 'bookmark' })
  expect(window.history.length).toBe(length)
})

describe('runtime task navigation', () => {
  test('returns from nested settings to the original target and session', () => {
    const address = {
      deviceId: 'remote',
      taskId: 'kcoder:remote:thread',
      expectedSessionAddress: { targetId: 'target', workspaceId: 'workspace', threadId: 'thread' },
    }
    const route = buildRuntimeTaskRoute(address)
    window.history.replaceState({}, '', route)
    navigateTo('/settings')
    navigateTo('/settings/personal/models')
    navigateToLastConversation()
    expect(`${window.location.pathname}${window.location.search}`).toBe(route)
    expect(parseRuntimeTaskRoute(window.location.pathname, window.location.search)).toEqual(address)
  })

  test('returns to the workbench when no valid conversation route is available', () => {
    window.sessionStorage.setItem('kcoder.lastConversationRoute', '//external.invalid')
    window.history.replaceState({}, '', '/settings/tools')
    navigateToLastConversation()
    expect(window.location.pathname).toBe('/')
  })
  test('builds runtime task routes without exposing workspace paths', () => {
    const route = buildRuntimeTaskRoute({
      deviceId: 'dev-mac.local',
      workspacePath: '/Users/dev-mac/work/Wegent github',
      taskId: '12345',
    })

    expect(route).toBe('/runtime-tasks?deviceId=dev-mac.local&taskId=12345')
    expect(route).not.toContain('workspacePath')
    expect(route).not.toContain('%2FUsers%2Fdev-mac%2Fwork%2FWegent')
  })

  test('parses runtime task routes from device and task ids only', () => {
    expect(parseRuntimeTaskRoute('/runtime-tasks', '?deviceId=dev-mac.local&taskId=12345')).toEqual(
      {
        deviceId: 'dev-mac.local',
        taskId: '12345',
      }
    )
  })

  test('retains the complete canonical peer address through a route round trip', () => {
    const expectedSessionAddress = { targetId: 'native-original', workspaceId: 'workspace-original', threadId: 'same-id' }
    const address = { deviceId: 'catalog-alias', taskId: 'kcoder:catalog-alias:same-id', expectedSessionAddress }
    const route = buildRuntimeTaskRoute({ ...address, workspacePath: '/private/workspace' })
    const url = new URL(route, 'http://localhost')
    expect(parseRuntimeTaskRoute(url.pathname, url.search)).toEqual(address)
    expect(route).not.toContain('private')
  })

  test('rejects partial, conflicting and duplicate canonical selectors instead of dropping their constraint', () => {
    const base = '?deviceId=alias&taskId=kcoder%3Aalias%3Asame-id'
    const encoded = encodeURIComponent(JSON.stringify({ targetId: 'native', workspaceId: 'workspace', threadId: 'same-id' }))
    for (const selector of ['null', '%7B', encodeURIComponent(JSON.stringify({ targetId: 'native', threadId: 'same-id' })),
      encodeURIComponent(JSON.stringify({ targetId: 'native', workspaceId: 'workspace', threadId: 'other' })),
      `${encoded}&expectedSessionAddress=${encoded}`]) {
      expect(parseRuntimeTaskRoute('/runtime-tasks', `${base}&expectedSessionAddress=${selector}`)).toBeNull()
    }
    expect(() => buildRuntimeTaskRoute({ deviceId: 'alias', taskId: 'kcoder:alias:other',
      expectedSessionAddress: { targetId: 'native', workspaceId: 'workspace', threadId: 'same-id' } })).toThrow()
  })
})


describe('logical parent page navigation', () => {
  test.each([
    ['/plugins/manage', '', '/plugins'],
    ['/plugins/create', '', '/plugins'],
    ['/plugins/manage/', '?view=installed', '/plugins'],
    ['/plugins', '?view=marketplaces', '/plugins'],
    ['/plugins', '', '/'],
    ['/settings/plugins', '', '/settings'],
    ['/settings', '', '/'],
    ['/runtime-tasks', '?deviceId=local&taskId=original', '/tasks'],
    ['/knowledge', '', '/'],
    ['/', '', '/'],
    ['//external.invalid', '', '/'],
  ])('returns the stable parent for %s%s', (path, search, expected) => {
    expect(parentPageRoute(path, search)).toBe(expected)
  })
})
