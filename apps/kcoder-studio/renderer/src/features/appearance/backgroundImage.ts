import type { ResolvedAppearanceMode } from './types'
import { isClientImageUrl, selectClientImage } from '@/lib/client-image'

export type WorkbenchBackgroundSlot = ResolvedAppearanceMode | 'common'

// Client images are shared by every appearance slot, so the slot is not needed
// to select or remove one; it stays in the signature for callers.
export function selectWorkbenchBackground(theme: WorkbenchBackgroundSlot): Promise<string | null>
export async function selectWorkbenchBackground(): Promise<string | null> {
  return selectClientImage('background')
}

export function removeWorkbenchBackground(theme?: WorkbenchBackgroundSlot): Promise<void>
export async function removeWorkbenchBackground(): Promise<void> {
  // Images belong to the client preference; no host-managed file needs removal.
}

export function backgroundImageUrl(path: string | null): string | null {
  return isClientImageUrl(path) ? path : null
}
