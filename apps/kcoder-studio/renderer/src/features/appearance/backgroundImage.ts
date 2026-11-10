import type { ResolvedAppearanceMode } from './types'
import { isClientImageUrl, selectClientImage } from '@/lib/client-image'

export type WorkbenchBackgroundSlot = ResolvedAppearanceMode | 'common'

export async function selectWorkbenchBackground(
  _theme: WorkbenchBackgroundSlot
): Promise<string | null> {
  return selectClientImage('background')
}

export async function removeWorkbenchBackground(_theme?: WorkbenchBackgroundSlot): Promise<void> {
  // Images belong to the client preference; no host-managed file needs removal.
}

export function backgroundImageUrl(path: string | null): string | null {
  return isClientImageUrl(path) ? path : null
}
