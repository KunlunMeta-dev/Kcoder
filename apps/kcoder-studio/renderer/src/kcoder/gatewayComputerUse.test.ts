import { expect, test, vi } from 'vitest'
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }))
import { computerUseTurnParams } from './gatewayComputerUse'
import type { GatewayClient } from './gatewayRuntimeTypes'
const supported = { supportsExperimental: () => true } as unknown as GatewayClient
const approved = { computerUse: { approved: true, target: 'local_windows_desktop' } }
const sessionApproval = { computerUse: { ...approved.computerUse, useSessionAuthorization: false } }

test('desktop approval is explicit, per-turn, and local only', () => {
  expect(
    computerUseTurnParams({ permissionMode: 'yolo' }, supported, { transport: 'local' })
  ).toEqual({})
  expect(computerUseTurnParams(approved, supported, { transport: 'local' })).toEqual(
    sessionApproval
  )
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
    sessionApproval
  )
})

test('automatic inheritance uses the separate capability and cannot manufacture fresh approval', () => {
  expect(
    computerUseTurnParams(approved, supported, { transport: 'local' }, false, true, true)
  ).toEqual({
    computerUse: { approved: true, target: 'local_windows_desktop', useSessionAuthorization: true },
  })
  const legacy = {
    supportsExperimental: (capability: string) =>
      capability !== 'computerUseSessionAuthorizationV1',
  } as unknown as GatewayClient
  expect(() =>
    computerUseTurnParams(approved, legacy, { transport: 'local' }, false, true, true)
  ).toThrow('newTurnRequired')
  expect(computerUseTurnParams(approved, legacy, { transport: 'local' })).toEqual(approved)
})
