import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

import type { ResolvedAppearanceMode } from './types'
import { isNativeTauriHost } from '@/lib/runtime-environment'
import { isClientImageUrl, selectClientImage } from '@/lib/client-image'

export type WorkbenchBackgroundSlot = ResolvedAppearanceMode | 'common'

export async function selectWorkbenchBackground(
  theme: WorkbenchBackgroundSlot
): Promise<string | null> {
  if (!isNativeTauriHost()) return selectClientImage('background')

  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  })
  if (!selected) return null
  return invoke<string>('import_workbench_background', { sourcePath: selected, theme })
}

export async function removeWorkbenchBackground(theme?: WorkbenchBackgroundSlot): Promise<void> {
  if (!isNativeTauriHost()) return
  await invoke('remove_workbench_background', { theme: theme ?? null })
}

export function backgroundImageUrl(path: string | null): string | null {
  if (isClientImageUrl(path)) return path
  if (!path || !isNativeTauriHost() || !isTauri()) return null
  return convertFileSrc(path)
}
