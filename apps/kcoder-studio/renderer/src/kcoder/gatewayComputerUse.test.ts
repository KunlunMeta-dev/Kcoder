import { expect, test, vi } from 'vitest'
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }))
import { computerUseTurnParams } from './gatewayComputerUse'
import type { GatewayClient } from './gatewayRuntimeTypes'
const supported = { supportsExperimental: () => true } as unknown as GatewayClient
const approved = { computerUse: { approved: true, target: 'local_windows_desktop' } }

test('desktop approval is explicit, per-turn, and local only', () => {
  expect(
    computerUseTurnParams({ permissionMode: 'yolo' }, supported, { transport: 'local' })
  ).toEqual({})
  expect(computerUseTurnParams(approved, supported, { transport: 'local' })).toEqual(approved)
  expect(() => computerUseTurnParams(approved, supported, { transport: 'ssh' })).toThrow(
    'localOnly'
  )
  expect(() => computerUseTurnParams(approved, supported, { transport: 'local' }, true)).toThrow(
    'newTurnRequired'
  )
})
test('rejects incomplete, forged targets and unavailable capability', () => {
  for (const value of [
    true,
    [],
    {},
    { approved: false, target: 'local_windows_desktop' },
    { approved: true, target: 'remote' },
    { approved: true, target: 'local_windows_desktop', owner: 'other' },
  ]) {
    expect(() =>
      computerUseTurnParams({ computerUse: value }, supported, { transport: 'local' })
    ).toThrow('invalidApproval')
  }
  expect(() =>
    computerUseTurnParams(
      approved,
      { supportsExperimental: () => false } as unknown as GatewayClient,
      { transport: 'local' }
    )
  ).toThrow('unsupportedTarget')
})

test('an explicitly approved session can renew control for a failed-turn retry', () => {
  expect(computerUseTurnParams(approved, supported, { transport: 'local' }, true, true)).toEqual(
    approved
  )
})
