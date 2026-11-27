import type { ComponentType, MouseEvent } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, MoreHorizontal } from 'lucide-react'

const MENU_GAP = 8
const VIEWPORT_PADDING = 8
const MIN_MENU_WIDTH = 176

export interface ActionMenuItem {
  label: string
  icon: ComponentType<{ className?: string }>
  onSelect: () => void | Promise<void>
  testId: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
}

interface ActionMenuProps {
  ariaLabel: string
  testId: string
  items: ActionMenuItem[]
  icon?: ComponentType<{ className?: string }>
  variant?: 'horizontal' | 'vertical'
  triggerClassName?: string
  placement?: 'side' | 'bottom-end' | 'top-start'
  disabled?: boolean
  contextMenuPosition?: MenuPosition | null
  onContextMenuClose?: () => void
}

export interface MenuPosition {
  left: number
  top: number
}

export function ActionMenu({
  ariaLabel,
  testId,
  items,
  icon: Icon = MoreHorizontal,
  variant = 'horizontal',
  triggerClassName,
  placement = 'side',
  disabled = false,
  contextMenuPosition,
  onContextMenuClose,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const pointerSelectionRef = useRef(false)
  const focusOnOpen = useRef<'first' | 'last' | null>('first')
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)

  const closeMenu = useCallback(() => {
    setOpen(false)
    setMenuPosition(null)
    onContextMenuClose?.()
  }, [onContextMenuClose])
  const menuOpen = open || Boolean(contextMenuPosition)
  const returnToTrigger = useCallback(
    () => containerRef.current?.querySelector('button')?.focus({ preventScroll: true }),
    []
  )

  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!open) {
      setMenuPosition(null)
    }
    if (menuOpen) {
      closeMenu()
    } else {
      focusOnOpen.current = 'first'
      setOpen(true)
    }
  }

  const handleItemSelect = async (item: ActionMenuItem) => {
    if (item.disabled) return
    closeMenu()
    returnToTrigger()
    await item.onSelect()
    if (document.activeElement === document.body && containerRef.current?.isConnected)
      returnToTrigger()
  }

  useLayoutEffect(() => {
    if (menuOpen) pointerSelectionRef.current = false
    else focusOnOpen.current = 'first'
  }, [menuOpen, contextMenuPosition])

  useLayoutEffect(() => {
    if (!menuOpen || !menuPosition || !focusOnOpen.current) return
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    const button = focusOnOpen.current === 'last' ? buttons?.[buttons.length - 1] : buttons?.[0]
    ;(button ?? menuRef.current)?.focus({ preventScroll: true })
    focusOnOpen.current = null
  }, [menuOpen, menuPosition])

  useLayoutEffect(() => {
    if (!menuOpen) return

    const updatePosition = () => {
      const menu = menuRef.current
      if (!menu) return
      // A menu inside an editor must appear above that editor, while ordinary
      // menus retain their layer below unrelated modal dialogs.
      menu.style.zIndex = containerRef.current?.closest('[role="dialog"]')
        ? 'var(--z-critical)'
        : ''

      const menuRect = menu.getBoundingClientRect()
      const menuWidth = Math.max(menuRect.width, MIN_MENU_WIDTH)
      const menuHeight = menuRect.height
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      const maxLeft = viewportWidth - menuWidth - VIEWPORT_PADDING
      const maxTop = viewportHeight - menuHeight - VIEWPORT_PADDING
      if (contextMenuPosition) {
        setMenuPosition({
          left: Math.max(VIEWPORT_PADDING, Math.min(contextMenuPosition.left, maxLeft)),
          top: Math.max(VIEWPORT_PADDING, Math.min(contextMenuPosition.top, maxTop)),
        })
        return
      }

      const trigger = containerRef.current
      if (!trigger) return
      const triggerRect = trigger.getBoundingClientRect()
      if (placement === 'top-start') {
        const aboveTop = triggerRect.top - menuHeight - MENU_GAP
        setMenuPosition({
          left: Math.max(VIEWPORT_PADDING, Math.min(triggerRect.left, maxLeft)),
          top: Math.max(
            VIEWPORT_PADDING,
            Math.min(
              aboveTop >= VIEWPORT_PADDING ? aboveTop : triggerRect.bottom + MENU_GAP,
              maxTop
            )
          ),
        })
        return
      }
      if (placement === 'bottom-end') {
        const belowTop = triggerRect.bottom + MENU_GAP
        const aboveTop = triggerRect.top - menuHeight - MENU_GAP
        const top =
          belowTop + menuHeight <= viewportHeight - VIEWPORT_PADDING
            ? belowTop
            : Math.max(VIEWPORT_PADDING, aboveTop)
        const left = Math.max(VIEWPORT_PADDING, Math.min(triggerRect.right - menuWidth, maxLeft))
        setMenuPosition({ left, top: Math.max(VIEWPORT_PADDING, Math.min(top, maxTop)) })
        return
      }

      const rightSideLeft = triggerRect.right + MENU_GAP
      const leftSideLeft = triggerRect.left - menuWidth - MENU_GAP
      const hasRoomOnRight = rightSideLeft + menuWidth <= viewportWidth - VIEWPORT_PADDING
      const preferredLeft = hasRoomOnRight ? rightSideLeft : leftSideLeft
      const left = Math.max(VIEWPORT_PADDING, Math.min(preferredLeft, maxLeft))
      const top = Math.max(VIEWPORT_PADDING, Math.min(triggerRect.top, maxTop))

      setMenuPosition({ left, top })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [contextMenuPosition, menuOpen, placement])

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        closeMenu()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        closeMenu()
        returnToTrigger()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeMenu, menuOpen, returnToTrigger])

  return (
    <div
      ref={containerRef}
      className="relative shrink-0"
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        data-testid={testId}
        onClick={handleTriggerClick}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          focusOnOpen.current = event.key === 'ArrowUp' ? 'last' : 'first'
          if (!menuOpen) {
            setMenuPosition(null)
            setOpen(true)
          } else {
            const buttons =
              menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
            ;(event.key === 'ArrowUp' ? buttons?.[buttons.length - 1] : buttons?.[0])?.focus()
            focusOnOpen.current = null
          }
        }}
        disabled={disabled}
        className={
          triggerClassName ??
          'flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 max-md:h-11 max-md:w-11'
        }
        aria-label={ariaLabel}
        title={ariaLabel}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <Icon className={variant === 'vertical' ? 'h-4 w-4 rotate-90' : 'h-4 w-4'} />
      </button>
      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            data-testid={`${testId}-menu`}
            role="menu"
            tabIndex={-1}
            aria-label={ariaLabel}
            onKeyDown={event => {
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
              )
              const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const next =
                  current < 0
                    ? event.key === 'ArrowUp'
                      ? buttons.length - 1
                      : 0
                    : (current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) %
                      buttons.length
                buttons[next]?.focus()
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault()
                ;(event.key === 'Home' ? buttons[0] : buttons[buttons.length - 1])?.focus()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeMenu()
                returnToTrigger()
              } else if (event.key === 'Tab') {
                closeMenu()
                returnToTrigger()
              }
            }}
            data-embedded-browser-occlusion
            style={{
              left: menuPosition?.left ?? 0,
              top: menuPosition?.top ?? 0,
              visibility: menuPosition ? 'visible' : 'hidden',
            }}
            className="fixed z-[70] max-h-[calc(100dvh-1rem)] min-w-[176px] max-w-[calc(100dvw-1rem)] overflow-y-auto rounded-xl border border-border bg-popover p-1 text-text-primary shadow-lg focus-visible:outline-none"
          >
            {items.map(item => (
              <button
                key={item.testId}
                type="button"
                data-testid={item.testId}
                disabled={item.disabled}
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                title={item.label}
                aria-checked={item.checked}
                onPointerDown={event => {
                  if (item.disabled) return
                  event.preventDefault()
                  event.stopPropagation()
                  pointerSelectionRef.current = true
                  void handleItemSelect(item)
                }}
                onClick={() => {
                  if (pointerSelectionRef.current) {
                    pointerSelectionRef.current = false
                    return
                  }
                  void handleItemSelect(item)
                }}
                className={[
                  'flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/50 max-md:h-11',
                  item.danger
                    ? 'text-destructive hover:bg-destructive/10'
                    : 'text-text-primary hover:bg-muted',
                  item.disabled ? 'cursor-not-allowed opacity-45 hover:bg-transparent' : '',
                ].join(' ')}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
                {item.checked ? (
                  <Check className="ml-auto h-4 w-4 shrink-0" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
