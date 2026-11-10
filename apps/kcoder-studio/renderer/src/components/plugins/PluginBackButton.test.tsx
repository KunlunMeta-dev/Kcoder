import '@/i18n'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { toBrowserPath } from '@/lib/navigation'
import { PluginBackButton } from './PluginBackButton'

const originalUrl = `${window.location.pathname}${window.location.search}`
afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', originalUrl)
})

test.each([
  ['/plugins/manage', '/plugins'],
  ['/plugins/create', '/plugins'],
  ['/plugins?view=marketplaces', '/plugins'],
  ['/plugins', '/'],
])('Back from %s opens its parent even after direct entry', (path, parent) => {
  window.history.replaceState({}, '', toBrowserPath(path))
  render(<PluginBackButton />)
  fireEvent.click(screen.getByTestId('plugins-back-button'))
  expect(`${window.location.pathname}${window.location.search}`).toBe(toBrowserPath(parent))
})
