import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { GatewayPermissionSelector } from './GatewayPermissionSelector'
import { turnPermissionParams } from '@/kcoder/gatewayTurnPermissions'

afterEach(() => {
  document.head.innerHTML = ''
})

test('permission menu keeps the server default until an explicit selection', () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="test">'
  const onChange = vi.fn()
  render(<GatewayPermissionSelector onChange={onChange} />)
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('composer-permission-selector'))
  expect(screen.getByTestId('permission-mode-default')).toHaveAttribute('aria-checked', 'true')
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(7)
  fireEvent.click(screen.getByTestId('permission-mode-ask'))
  expect(onChange).toHaveBeenCalledWith('ask')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

test('permission override requires a supporting server and rejects unknown modes', () => {
  expect(turnPermissionParams({}, {})).toEqual({})
  expect(() => turnPermissionParams({ model_config: { permission_mode: 'yolo' } }, {})).toThrow(
    'does not support'
  )
  expect(() =>
    turnPermissionParams(
      { model_config: { permission_mode: 'unsafe-unknown' } },
      { supportsExperimental: () => true }
    )
  ).toThrow('Unsupported')
  expect(
    turnPermissionParams(
      { model_config: { permission_mode: 'ask' } },
      { supportsExperimental: () => true }
    )
  ).toEqual({ permissionMode: 'ask' })
})
