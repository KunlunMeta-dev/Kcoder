import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { MenuPosition } from '@/components/common/ActionMenu'

export interface WorkspaceTreeContextMenuItem {
  id: string
  label: string
  disabled?: boolean
  onSelect: () => void
}

export function WorkspaceFileTreeContextMenu({
  position,
  items,
  testIdPrefix,
  onClose,
}: {
  position: MenuPosition | null
  items: WorkspaceTreeContextMenuItem[]
  testIdPrefix: string
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!position) return
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [position, onClose])

  useEffect(() => {
    if (!position) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [position])

  if (!position) return null
  const maxLeft = Math.max(8, window.innerWidth - 208)
  const maxTop = Math.max(8, window.innerHeight - items.length * 32 - 24)
  return createPortal(
    <div
      ref={menuRef}
      data-testid={`${testIdPrefix}-menu`}
      data-file-tree-context-menu-root="true"
      data-embedded-browser-occlusion
      role="menu"
      style={{ left: Math.min(position.left, maxLeft), top: Math.min(position.top, maxTop) }}
      className="fixed z-[70] min-w-[176px] rounded-2xl border border-border bg-background p-1.5 text-text-primary shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
    >
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          data-testid={`${testIdPrefix}-${item.id}`}
          disabled={item.disabled}
          role="menuitem"
          onClick={() => {
            if (item.disabled) return
            onClose()
            item.onSelect()
          }}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-40"
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
