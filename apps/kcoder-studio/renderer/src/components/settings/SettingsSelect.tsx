import { Check, ChevronDown } from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'

// Keep the real select as the form/accessibility boundary. The desktop popup is
// a presentation layer, so labels, validation and existing change handlers survive.
export function SettingsSelect({
  icon,
  density = 'standard',
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  icon: ReactNode
  density?: 'standard' | 'compact'
}) {
  const select = useRef<HTMLSelectElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const id = useId()
  const [menu, setMenu] = useState<{
    left: number
    top?: number
    bottom?: number
    width: number
    height: number
  } | null>(null)
  const [options, setOptions] = useState<{ value: string; label: string; disabled: boolean }[]>([])
  const [selectedLabel, setSelectedLabel] = useState('')
  const current = String(props.value ?? props.defaultValue ?? '')
  useEffect(() => {
    const element = select.current
    if (!element) return
    const update = () => {
      setSelectedLabel(element.selectedOptions[0]?.textContent ?? '')
      setOptions(
        Array.from(element.options).map(option => ({
          value: option.value,
          label: option.textContent ?? '',
          disabled: option.disabled,
        }))
      )
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(element, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [children, current])
  const close = (restore = false) => {
    setMenu(null)
    if (restore) select.current?.focus()
  }
  useEffect(() => {
    if (!menu) return
    const active =
      popup.current?.querySelector<HTMLElement>('[aria-selected="true"]:not(:disabled)') ??
      popup.current?.querySelector<HTMLElement>('button:not(:disabled)')
    active?.focus()
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && event.target !== select.current)
        setMenu(null)
    }
    const reposition = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) setMenu(null)
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [menu])
  function open() {
    const element = select.current
    if (!element || element.matches(':disabled')) return
    const rect = element.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const height = Math.min(288, Math.max(below, above))
    const width = Math.min(
      Math.max(rect.width, density === 'compact' ? 260 : 0),
      window.innerWidth - 16
    )
    setMenu({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
      height,
      ...(below >= Math.min(240, above)
        ? { top: rect.bottom + 6 }
        : { bottom: window.innerHeight - rect.top + 6 }),
    })
  }
  function choose(value: string) {
    const element = select.current
    if (!element) return
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
    setSelectedLabel(element.selectedOptions[0]?.textContent ?? '')
    close(true)
  }
  return (
    <span
      className={
        density === 'compact'
          ? 'relative inline-block min-w-0 max-w-56 align-middle'
          : 'relative mt-1 block'
      }
    >
      <select
        {...props}
        ref={select}
        aria-controls={menu ? id : undefined}
        aria-expanded={Boolean(menu)}
        onChange={event => {
          setSelectedLabel(event.target.selectedOptions[0]?.textContent ?? '')
          props.onChange?.(event)
        }}
        onMouseDown={event => {
          props.onMouseDown?.(event)
          if (!event.defaultPrevented) {
            event.preventDefault()
            if (menu) close(true)
            else open()
          }
        }}
        onKeyDown={event => {
          props.onKeyDown?.(event)
          if (event.defaultPrevented) return
          if (['ArrowDown', 'ArrowUp', ' ', 'Enter'].includes(event.key)) {
            event.preventDefault()
            open()
          }
        }}
        className={`peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed ${className}`}
      >
        {children}
      </select>
      <span
        aria-hidden="true"
        className={`flex items-center text-sm text-text-primary transition-all duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-focus/30 peer-disabled:opacity-40 max-md:min-h-11 ${density === 'compact' ? 'h-7 gap-2 rounded-lg border border-transparent px-2 peer-hover:bg-text-primary/5' : 'min-h-10 gap-3 rounded-xl border px-3 shadow-sm peer-hover:border-text-muted/30'} ${menu ? 'border-blue-500/60 bg-background ring-2 ring-focus/10' : density === 'compact' ? 'border-transparent bg-transparent' : 'border-border bg-background'}`}
      >
        <span className="flex shrink-0 text-text-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{selectedLabel || '\u00a0'}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-text-muted transition-transform motion-reduce:transition-none ${menu ? 'rotate-180' : ''}`}
        />
      </span>
      {menu &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="listbox"
            aria-label={props['aria-label'] ?? selectedLabel}
            data-embedded-browser-occlusion
            className="fixed z-[11000] overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-lg"
            style={{
              left: menu.left,
              top: menu.top,
              bottom: menu.bottom,
              width: menu.width,
              maxHeight: menu.height,
            }}
            onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) close()
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close(true)
                return
              }
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
              )
              const index = items.indexOf(event.target as HTMLButtonElement)
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                items[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                ]?.focus()
              } else if (event.key.length === 1 && event.key !== ' ') {
                items
                  .find(item =>
                    item.textContent?.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase())
                  )
                  ?.focus()
              }
            }}
          >
            {options.map(option => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === current}
                disabled={option.disabled}
                tabIndex={-1}
                onClick={() => choose(option.value)}
                className="flex min-h-9 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-text-primary transition-colors hover:bg-surface focus:bg-surface focus:outline-none aria-selected:bg-surface/70 disabled:cursor-not-allowed disabled:opacity-40 max-md:min-h-11"
              >
                <span className="min-w-0 flex-1 break-words">{option.label}</span>
                {option.value === current && (
                  <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </span>
  )
}
