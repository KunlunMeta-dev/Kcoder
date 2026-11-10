import { expect, test } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import { currentHostDeviceId } from './currentHostTarget'

const device = (value: Partial<DeviceInfo>) => value as DeviceInfo

test('recognizes the actual Gateway local device shape with remote I/O and a custom label/id', () => {
  expect(
    currentHostDeviceId([
      device({
        device_id: 'ssh-default',
        device_type: 'remote',
        is_default: true,
        capabilities: ['kcoder-gateway'],
      }),
      device({
        device_id: 'cyx-current',
        name: 'cyx · local',
        device_type: 'remote',
        capabilities: ['kcoder-gateway', 'kcoder-gateway-local'],
      }),
    ])
  ).toBe('cyx-current')
})

test('prefers the actual Gateway host over a label hint and preserves legacy local targets', () => {
  expect(
    currentHostDeviceId([
      device({
        device_id: 'remote',
        device_type: 'remote',
        nameKey: 'currentComputer',
        capabilities: ['kcoder-gateway'],
      }),
      device({
        device_id: 'actual-host',
        device_type: 'remote',
        capabilities: ['kcoder-gateway-local'],
      }),
    ])
  ).toBe('actual-host')
  expect(currentHostDeviceId([device({ device_id: 'legacy', device_type: 'local' })])).toBe(
    'legacy'
  )
  expect(currentHostDeviceId([device({ device_id: 'local' })])).toBe('local')
})

test('does not substitute an arbitrary remote or a mislabeled Gateway server', () => {
  expect(
    currentHostDeviceId([
      device({
        device_id: 'remote',
        device_type: 'remote',
        nameKey: 'currentComputer',
        capabilities: ['kcoder-gateway'],
      }),
    ])
  ).toBeUndefined()
})
