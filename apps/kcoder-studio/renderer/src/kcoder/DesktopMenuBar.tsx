import { DesktopCommandMenu, type DesktopCommand } from './DesktopCommandMenu'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

type DesktopMenuItem = { index: number; label: string; id?: string; entries?: DesktopCommand[] }
type DesktopMenuBridge = {
  list(locale?: string): Promise<DesktopMenuItem[]>
  invoke?(index: number, position: number): Promise<void>
  setTheme?(dark: boolean): Promise<void>
  setVisible(visible: boolean): Promise<void>
  open(index: number, x: number, y: number): Promise<void>
}

function rememberFocus(element: Element | null) {
  if (!(element instanceof HTMLElement)) return () => {}
  const selection = window.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange()
      )
    : []
  const input =
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null
  const start = input?.selectionStart
  const end = input?.selectionEnd
  const direction = input?.selectionDirection
  return () => {
    if (!element.isConnected) return
    element.focus({ preventScroll: true })
    if (element === document.body && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    if (input && start != null && end != null) {
      input.setSelectionRange(start, end, direction ?? undefined)
    } else if (ranges.length && ranges.every(range => range.commonAncestorContainer.isConnected)) {
      const current = window.getSelection()
      current?.removeAllRanges()
      ranges.forEach(range => current?.addRange(range))
    }
  }
}

function commandMenuAnchor(button: HTMLButtonElement): DOMRect {
  const bounds = button.getBoundingClientRect()
  const chrome = button.closest('[data-testid="desktop-brand-chrome"]')?.getBoundingClientRect()
  return new DOMRect(
    bounds.x,
    bounds.y,
    bounds.width,
    Math.max(bounds.bottom, chrome?.bottom ?? 0) - bounds.y
  )
}

export function DesktopMenuBar() {
  const { t, i18n } = useTranslation('common')
  const [bridge] = useState(
    () => (window as Window & { kcoderDesktopMenu?: DesktopMenuBridge }).kcoderDesktopMenu
  )
  const [items, setItems] = useState<DesktopMenuItem[]>([])
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [focused, setFocused] = useState(0)
  const [opened, setOpened] = useState<number | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const restoreFocus = useRef<() => void>(() => {})
  const mounted = useRef(false)
  const opening = useRef(false)

  const restoreNative = useCallback(async () => {
    try {
      await bridge?.setVisible(false)
    } catch {
      // A destroyed host may reject cleanup; never leave a rejected IPC promise unhandled.
    }
  }, [bridge])

  const fallback = useCallback(async () => {
    if (mounted.current) {
      if (bar.current?.contains(document.activeElement)) restoreFocus.current()
      setItems([])
    }
    await restoreNative()
  }, [restoreNative])

  useEffect(() => {
    if (!bridge) return
    mounted.current = true
    let active = true
    void (async () => {
      try {
        const hostItems = await bridge.list(i18n.resolvedLanguage ?? i18n.language)
        if (!active) return
        if (!hostItems.length) {
          await fallback()
          return
        }
        setItems(hostItems)
      } catch {
        if (active) await fallback()
      }
    })()
    return () => {
      active = false
      mounted.current = false
      void restoreNative()
    }
  }, [bridge, fallback, restoreNative, i18n.resolvedLanguage, i18n.language])

  useEffect(() => {
    if (!bridge || !items.length) return
    let active = true
    void (async () => {
      try {
        // Only hide the native bar after the replacement has committed to the DOM.
        await bridge.setVisible(true)
      } catch {
        if (active) await fallback()
      }
    })()
    return () => {
      active = false
    }
  }, [bridge, items, fallback])

  useEffect(() => {
    if (!items.length) return
    let altOnly = false
    const toggleFocus = () => {
      if (opened !== null && bridge?.invoke) {
        setOpened(null)
        buttons.current[opened]?.focus({ preventScroll: true })
        return
      }
      if (bar.current?.contains(document.activeElement)) {
        restoreFocus.current()
      } else {
        restoreFocus.current = rememberFocus(document.activeElement)
        buttons.current[focused]?.focus({ preventScroll: true })
      }
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      altOnly =
        event.key === 'Alt' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.repeat
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return
      if (event.key === 'F10' && !event.altKey) {
        event.preventDefault()
        toggleFocus()
      }
    }
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Alt' && altOnly && !event.defaultPrevented) {
        event.preventDefault()
        toggleFocus()
      }
      altOnly = false
    }
    const onBlur = () => {
      altOnly = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [items, focused, opened, bridge])

  const openMenu = async (position: number, keyboard: boolean) => {
    if (!bridge || opening.current) return
    const button = buttons.current[position]
    if (!button) return
    if (bridge.invoke && items[position].entries) {
      if (
        !bar.current?.contains(document.activeElement) &&
        !document.activeElement?.closest('[data-desktop-command-menu]')
      )
        restoreFocus.current = rememberFocus(document.activeElement)
      setAnchor(commandMenuAnchor(button))
      setOpened(current => (current === position && !keyboard ? null : position))
      return
    }
    const rect = button.getBoundingClientRect()
    opening.current = true
    setOpened(position)
    // Native edit roles must still target the composer, not the menu trigger.
    if (keyboard || bar.current?.contains(document.activeElement)) restoreFocus.current()
    const editingTarget = document.activeElement
    try {
      await bridge.open(items[position].index, Math.round(rect.left), Math.round(rect.bottom))
      if (mounted.current && keyboard && document.activeElement === editingTarget) {
        button.focus({ preventScroll: true })
      }
    } catch {
      await fallback()
    } finally {
      opening.current = false
      if (mounted.current) setOpened(null)
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLButtonElement>, position: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const destinations: Record<string, number> = {
      ArrowLeft: (position + items.length - 1) % items.length,
      ArrowRight: (position + 1) % items.length,
      Home: 0,
      End: items.length - 1,
    }
    if (event.key in destinations) {
      event.preventDefault()
      buttons.current[destinations[event.key]]?.focus({ preventScroll: true })
    } else if (['Enter', ' ', 'ArrowDown'].includes(event.key)) {
      event.preventDefault()
      if (!event.repeat) void openMenu(position, true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      restoreFocus.current()
    }
  }

  useEffect(() => {
    if (!bridge?.setTheme) return
    const sync = () => {
      void bridge.setTheme?.(document.documentElement.classList.contains('dark')).catch(() => {})
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [bridge])

  const closeCustom = (focusTrigger: boolean) => {
    const position = opened
    setOpened(null)
    if (focusTrigger && position !== null) buttons.current[position]?.focus({ preventScroll: true })
    else restoreFocus.current()
  }
  const invokeCommand = async (position: number) => {
    if (opened === null || !bridge?.invoke || opening.current) return
    const index = items[opened].index
    opening.current = true
    setOpened(null)
    restoreFocus.current()
    try {
      await bridge.invoke(index, position)
    } catch {
      await fallback()
    } finally {
      opening.current = false
    }
  }

  if (!items.length) return null
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-4 border-b border-border/60 bg-background pl-3 pr-[144px] select-none [-webkit-app-region:drag]"
      data-testid="desktop-brand-chrome"
    >
      <div
        className="flex shrink-0 items-center gap-2.5"
        aria-label="KCoder Studio"
        data-testid="desktop-wordmark"
      >
        <img src="/favicon.png" alt="" className="h-5 w-5 rounded-md" draggable={false} />
        <span className="flex items-baseline gap-1.5 text-sm tracking-tight text-text-primary">
          <span className="font-semibold">KCoder</span>
          <span className="font-normal tracking-normal text-text-secondary">Studio</span>
        </span>
      </div>
      <span className="h-4 w-px bg-border/70" aria-hidden="true" />
      <div
        ref={bar}
        role="menubar"
        aria-label={t('desktopMenu.label')}
        data-testid="desktop-menu-bar"
        className="flex h-8 min-w-0 items-center gap-1 overflow-x-auto text-text-secondary [-webkit-app-region:no-drag]"
        onFocusCapture={event => {
          if (
            !bar.current?.contains(event.relatedTarget) &&
            !(
              event.relatedTarget instanceof Element &&
              event.relatedTarget.closest('[data-desktop-command-menu]')
            )
          ) {
            restoreFocus.current = rememberFocus(event.relatedTarget)
          }
        }}
      >
        {items.map((item, position) => (
          <Button
            key={item.index}
            ref={element => {
              buttons.current[position] = element
            }}
            type="button"
            variant="ghost"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={opened === position}
            tabIndex={focused === position ? 0 : -1}
            data-testid={`desktop-menu-${item.index}`}
            className="h-7 shrink-0 rounded-lg border-transparent px-2.5 py-0 text-sm font-normal text-text-secondary hover:bg-text-primary/5 hover:text-text-primary active:translate-y-0 aria-expanded:bg-text-primary/10 aria-expanded:text-text-primary aria-expanded:shadow-sm focus-visible:ring-blue-500/50 focus-visible:ring-offset-0"
            onFocus={() => setFocused(position)}
            onMouseEnter={event => {
              if (opened !== null && bridge?.invoke && items[position].entries) {
                setAnchor(commandMenuAnchor(event.currentTarget))
                setOpened(position)
              }
            }}
            onPointerDown={event => event.preventDefault()}
            onMouseDown={event => event.preventDefault()}
            onClick={event => {
              void openMenu(
                position,
                event.detail === 0 && document.activeElement === event.currentTarget
              )
            }}
            onKeyDown={event => onMenuKeyDown(event, position)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {opened !== null && bridge?.invoke && items[opened]?.entries && anchor && (
        <DesktopCommandMenu
          label={items[opened].label}
          entries={items[opened].entries!}
          anchor={anchor}
          onDismiss={closeCustom}
          onSelect={position => void invokeCommand(position)}
          onSwitch={direction =>
            void openMenu((opened + direction + items.length) % items.length, true)
          }
        />
      )}
    </div>
  )
}
