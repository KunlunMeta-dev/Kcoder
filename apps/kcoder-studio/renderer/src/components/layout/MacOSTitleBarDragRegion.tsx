import { cn } from '@/lib/utils'
import { getKeyboardPlatform } from '@/lib/keyboard-platform'

interface MacOSTitleBarDragRegionProps {
  className?: string
}

export function MacOSTitleBarDragRegion({
  className = 'h-full w-full',
}: MacOSTitleBarDragRegionProps) {
  // Windows already has a separate draggable brand/menu bar above the workbench.
  const draggable = getKeyboardPlatform() !== 'windows'
  return (
    <div
      data-testid="macos-titlebar-drag-region"
      data-kcoder-drag-region={draggable ? true : undefined}
      className={cn(
        draggable ? 'pointer-events-auto [-webkit-app-region:drag]' : 'pointer-events-none',
        className
      )}
      aria-hidden="true"
    />
  )
}
