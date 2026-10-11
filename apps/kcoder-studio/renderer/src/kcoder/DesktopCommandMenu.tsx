import { useEffect, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  Copy,
  Scissors,
  Clipboard,
  Undo2,
  Redo2,
  FolderOpen,
  MessageSquarePlus,
  Settings,
  Clock,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  Maximize,
  PanelTop,
  LogOut,
  X,
  Minus,
  Square,
  Scan,
  TextSelect,
} from 'lucide-react'

export type DesktopCommand = {
  position: number
  id?: string
  label: string
  type?: string
  enabled: boolean
  visible: boolean
  checked: boolean
  accelerator: string
}
const icons = {
  newWindow: PanelTop,
  newChat: MessageSquarePlus,
  temporaryChat: MessageSquarePlus,
  openFolder: FolderOpen,
  close: X,
  logout: LogOut,
  quit: LogOut,
  undo: Undo2,
  redo: Redo2,
  cut: Scissors,
  copy: Copy,
  paste: Clipboard,
  selectAll: TextSelect,
  reload: RefreshCw,
  forceReload: RefreshCw,
  resetZoom: Scan,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  togglefullscreen: Maximize,
  minimize: Minus,
  zoom: Square,
  settings: Settings,
  automations: Clock,
}

export function DesktopCommandMenu({
  label,
  entries,
  anchor,
  onSelect,
  onDismiss,
  onSwitch,
}: {
  label: string
  entries: DesktopCommand[]
  anchor: DOMRect
  onSelect: (position: number) => void
  onDismiss: (focusTrigger: boolean) => void
  onSwitch: (direction: number) => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const dismiss = useRef(onDismiss)
  useEffect(() => {
    dismiss.current = onDismiss
  }, [onDismiss])
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus()
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        (!panel.current?.contains(event.target) &&
          !event.target.closest('[data-testid="desktop-menu-bar"]'))
      )
        dismiss.current(false)
    }
    const hide = () => dismiss.current(false)
    window.addEventListener('pointerdown', outside)
    window.addEventListener('resize', hide)
    window.addEventListener('blur', hide)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', hide)
      window.removeEventListener('blur', hide)
    }
  }, [label])
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey) return
    const controls = Array.from(
      panel.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? []
    )
    const index = controls.indexOf(event.target as HTMLButtonElement)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      controls[
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? controls.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length
      ]?.focus()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      onSwitch(event.key === 'ArrowRight' ? 1 : -1)
    } else if (['Escape', 'F10', 'Tab'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      onDismiss(event.key !== 'Tab')
    } else if (event.key.length === 1 && event.key !== ' ') {
      const ordered = [...controls.slice(index + 1), ...controls.slice(0, index + 1)]
      ordered
        .find(control =>
          control.dataset.label?.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase())
        )
        ?.focus()
    }
  }
  const width = Math.min(300, window.innerWidth - 16)
  const top = Math.max(8, Math.min(anchor.bottom + 5, window.innerHeight - 80))
  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      onKeyDown={keyboard}
      data-desktop-command-menu
      data-embedded-browser-occlusion
      className="fixed z-[11000] overflow-y-auto rounded-xl border border-border/70 bg-background p-1.5 text-text-primary shadow-xl ring-1 ring-text-primary/5 [-webkit-app-region:no-drag]"
      style={{
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        top,
        width,
        maxHeight: window.innerHeight - top - 8,
      }}
    >
      {entries
        .filter(entry => entry.visible)
        .map(entry => {
          if (entry.type === 'separator')
            return (
              <div
                key={entry.position}
                role="separator"
                className="mx-2 my-1.5 h-px bg-border/70"
              />
            )
          const Icon = icons[entry.id as keyof typeof icons]
          return (
            <button
              key={entry.position}
              type="button"
              role={entry.type === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={entry.type === 'checkbox' ? entry.checked : undefined}
              data-testid={`desktop-command-${entry.id ?? entry.position}`}
              data-label={entry.label}
              disabled={!entry.enabled}
              tabIndex={-1}
              onClick={() => onSelect(entry.position)}
              className="group flex min-h-8 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-text-primary/5 focus:bg-text-primary/5 focus:outline-none disabled:cursor-not-allowed disabled:opacity-35"
            >
              <span
                className="flex h-4 w-4 shrink-0 items-center text-text-secondary"
                aria-hidden="true"
              >
                {entry.checked ? (
                  <Check className="h-4 w-4" />
                ) : Icon ? (
                  <Icon className="h-4 w-4" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1 whitespace-nowrap">{entry.label}</span>
              {entry.accelerator && (
                <kbd className="ml-4 shrink-0 rounded border border-border/50 bg-surface/60 px-1.5 py-0.5 font-sans text-xs tabular-nums text-text-muted">
                  {entry.accelerator
                    .replace(
                      /CommandOrControl|CmdOrCtrl|Control/g,
                      /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'
                    )
                    .replace(/Plus/g, '+')}
                </kbd>
              )}
            </button>
          )
        })}
    </div>,
    document.body
  )
}
