import { beforeEach, expect, test } from 'vitest'
import { defaultAppearance } from '../presets'
import { clearStoredAppearance, readStoredAppearance, writeStoredAppearance } from '../storage'

const KEY = 'kcoder.appearance'
const LEGACY_KEY = 'wework.appearance'
beforeEach(() => localStorage.clear())

test('released unversioned preferences load without writes and are versioned on explicit save', () => {
  const bytes = JSON.stringify({ mode: 'dark', uiFontSize: 16 })
  localStorage.setItem(LEGACY_KEY, bytes)
  const appearance = readStoredAppearance()
  expect(appearance.mode).toBe('dark')
  expect(appearance.uiFontSize).toBe(16)
  expect(localStorage.getItem(KEY)).toBeNull()
  expect(localStorage.getItem(LEGACY_KEY)).toBe(bytes)
  expect(writeStoredAppearance(appearance)).toBe(true)
  expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ schemaVersion: 1, mode: 'dark', uiFontSize: 16 })
  expect(readStoredAppearance()).toEqual(appearance)
  localStorage.setItem(LEGACY_KEY, '{"mode":"light"}')
  expect(readStoredAppearance().mode).toBe('dark')
  clearStoredAppearance()
  expect(readStoredAppearance()).toEqual(defaultAppearance)
  expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
})

test.each(['{corrupt', '[]', '{"schemaVersion":2,"mode":"dark"}'])('invalid or newer preferences are retained: %s', bytes => {
  localStorage.setItem(LEGACY_KEY, bytes)
  expect(readStoredAppearance()).toEqual(defaultAppearance)
  expect(writeStoredAppearance(defaultAppearance)).toBe(false)
  expect(localStorage.getItem(KEY)).toBeNull()
  expect(localStorage.getItem(LEGACY_KEY)).toBe(bytes)
})
