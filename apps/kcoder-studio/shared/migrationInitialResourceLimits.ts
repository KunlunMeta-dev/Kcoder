import type { MigrationResourceLimits } from './generated/contracts'

export const INITIAL_RESOURCE_FIELDS = ['maxTotalBytes', 'maxPayloadFiles', 'minFreeBytes', 'minFreeFileNodes'] as const
export type InitialResourceDraft = { enabled: boolean } & Record<typeof INITIAL_RESOURCE_FIELDS[number], string>
/** These are editable starting values, not observations of the target's capacity or policy. */
export const createInitialResourceDraft = (): InitialResourceDraft => ({ enabled: false, maxTotalBytes: '21474836480', maxPayloadFiles: '10000', minFreeBytes: '134217728', minFreeFileNodes: '32' })
export function initialResourceSelection(draft: InitialResourceDraft): { valid: boolean; limits?: MigrationResourceLimits } {
  if (!draft.enabled) return { valid: true }
  if (INITIAL_RESOURCE_FIELDS.some(key => !/^\d{1,16}$/.test(draft[key]))) return { valid: false }
  const limits = Object.fromEntries(INITIAL_RESOURCE_FIELDS.map(key => [key, Number(draft[key])])) as Required<MigrationResourceLimits>
  if (Object.values(limits).some(value => !Number.isSafeInteger(value)) || limits.maxTotalBytes <= 0 || limits.maxTotalBytes > 512 * 1024 ** 3
    || limits.maxPayloadFiles <= 0 || limits.maxPayloadFiles > 16384 || limits.minFreeBytes < 1024 ** 2 || limits.minFreeBytes > 16 * 1024 ** 3
    || limits.minFreeFileNodes < 0 || limits.minFreeFileNodes > 16384) return { valid: false }
  return { valid: true, limits: Object.freeze(limits) }
}
/** A lost creation reply cannot authorize changing the original request's quota. */
export function sameInitialResourceSelection(a?: MigrationResourceLimits, b?: MigrationResourceLimits): boolean {
  return a === undefined || b === undefined ? a === b : INITIAL_RESOURCE_FIELDS.every(key => a[key] === b[key])
}
