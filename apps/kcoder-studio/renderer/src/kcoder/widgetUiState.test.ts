import { expect, test } from 'vitest'
import { clearWidgetUiState, readWidgetUiState, writeWidgetUiState } from './widgetUiState'

test('widget controls restore only the exact pane artifact and remain bounded and removable', () => {
  localStorage.clear()
  writeWidgetUiState('target-a:task', 'w-1', 1, 'hash', { savings: { years: 8 } })
  expect(readWidgetUiState('target-a:task', 'w-1', 1, 'hash')).toEqual({ savings: { years: 8 } })
  expect(readWidgetUiState('target-b:task', 'w-1', 1, 'hash')).toBeUndefined()
  expect(readWidgetUiState('target-a:task', 'w-1', 2, 'hash')).toBeUndefined()
  writeWidgetUiState('target-a:task', 'w-2', 1, 'hash', { huge: 'x'.repeat(17000) })
  expect(readWidgetUiState('target-a:task', 'w-2', 1, 'hash')).toBeUndefined()
  clearWidgetUiState('target-a:task')
  expect(readWidgetUiState('target-a:task', 'w-1', 1, 'hash')).toBeUndefined()
})
