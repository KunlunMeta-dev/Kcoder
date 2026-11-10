import type { OfficeSettingsReadResult } from '../../../../shared/generated/contracts'
import { isOfficeSettingsReadResult } from '../../../../shared/generated/contractGuards.mjs'
import { requestLocalExecutor } from '@/host/localExecutor'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { KCODER_RUNTIME_METHODS } from '@/kcoder/legacyRuntimeAbi'
import type { NativeOfficeTarget } from './nativeOfficeTransport'

export class NativeOfficeSettingsError extends Error {
  readonly code:
    | 'unsupported'
    | 'unavailable'
    | 'conflict'
    | 'cancelled'
    | 'target_changed'
    | 'invalid_reply'
    | 'apply_unconfirmed'
  constructor(code: NativeOfficeSettingsError['code']) {
    super(code)
    this.name = 'NativeOfficeSettingsError'
    this.code = code
  }
}
interface Options {
  signal: AbortSignal
  isCurrent: () => boolean
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function normalize(error: unknown): NativeOfficeSettingsError {
  const value = record(error)
  const data = record(value.data)
  if (
    (data.kind === 'office_settings_unsupported' && data.capability === 'officeSettingsV1') ||
    value.code === -32601
  )
    return new NativeOfficeSettingsError('unsupported')
  const code = typeof value.code === 'string' ? value.code : value.message
  if (code === 'OFFICE_SETTINGS_REVISION_CONFLICT') return new NativeOfficeSettingsError('conflict')
  if (code === 'OFFICE_SETTINGS_TARGET_CHANGED')
    return new NativeOfficeSettingsError('target_changed')
  if (code === 'OFFICE_SETTINGS_CANCELLED') return new NativeOfficeSettingsError('cancelled')
  return error instanceof NativeOfficeSettingsError
    ? error
    : new NativeOfficeSettingsError('unavailable')
}
async function owned<T>(
  target: NativeOfficeTarget,
  options: Options,
  run: () => Promise<T>
): Promise<T> {
  const accountCurrent = captureAccountContextRevision()
  const check = () => {
    if (options.signal.aborted) throw new NativeOfficeSettingsError('cancelled')
    if (!options.isCurrent() || !accountCurrent(target.serverId))
      throw new NativeOfficeSettingsError('target_changed')
  }
  check()
  try {
    const result = await run()
    check()
    return result
  } catch (error) {
    check()
    throw normalize(error)
  }
}
function validate(value: unknown): OfficeSettingsReadResult {
  if (
    !isOfficeSettingsReadResult(value) ||
    !(value.persistedEnabled === null || typeof value.persistedEnabled === 'boolean') ||
    !/^[a-f0-9]{64}$/i.test(value.revision) ||
    value.restartRequired !== (value.effectiveEnabled !== value.connectionEnabled)
  )
    throw new NativeOfficeSettingsError('invalid_reply')
  return structuredClone(value)
}
export async function readNativeOfficeSettings(target: NativeOfficeTarget, options: Options) {
  return owned(target, options, async () =>
    validate(
      await requestLocalExecutor<unknown>(
        'runtime.settings.request',
        {
          ...target,
          method: 'settings/integrations/office/read',
          params: {},
        },
        { signal: options.signal }
      )
    )
  )
}
export async function saveNativeOfficeSettings(
  target: NativeOfficeTarget,
  enabled: boolean,
  expectedRevision: string,
  options: Options
) {
  if (typeof enabled !== 'boolean' || !/^[a-f0-9]{64}$/i.test(expectedRevision))
    throw new NativeOfficeSettingsError('invalid_reply')
  return owned(target, options, async () =>
    validate(
      await requestLocalExecutor<unknown>(
        'runtime.settings.request',
        {
          ...target,
          method: 'settings/integrations/office/save',
          params: { enabled, expectedRevision },
        },
        { signal: options.signal }
      )
    )
  )
}
export async function applyNativeOfficeSettings(
  target: NativeOfficeTarget,
  options: Options
): Promise<'applied' | 'busy'> {
  return owned(target, options, async () => {
    const result = record(
      await requestLocalExecutor(
        KCODER_RUNTIME_METHODS.appServerRestart,
        {
          serverId: target.serverId,
          ifIdle: true,
        },
        { signal: options.signal }
      )
    )
    if (result.restarted === true && result.requiresConfirmation === false) return 'applied'
    if (
      result.restarted === false &&
      result.requiresConfirmation === true &&
      Number.isSafeInteger(result.activeTaskCount) &&
      Number(result.activeTaskCount) > 0
    )
      return 'busy'
    throw new NativeOfficeSettingsError('apply_unconfirmed')
  })
}
