import { Info } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useOutsideClick } from '@/hooks/useOutsideClick'
import {
  calculateFloatingMenuHorizontalLayout,
  getFloatingMenuVisibleBounds,
  observeFloatingMenuLayout,
} from '@/lib/floating-menu'

export function ExecutionModeInfo({ text }: { text: string }) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, bottom: 8, width: 320 })
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect()
      const anchor = trigger.current
      if (rect && anchor) {
        const visibleBounds = getFloatingMenuVisibleBounds(anchor, 8)
        const layout = calculateFloatingMenuHorizontalLayout({
          anchorRect: rect,
          containerLeft: 0,
          visibleBounds,
          preferredWidth: 320,
        })
        setPosition({
          left: layout.left,
          bottom: Math.max(8, innerHeight - rect.top + 4),
          width: layout.width,
        })
      }
    }
    update()
    return observeFloatingMenuLayout(trigger.current, update)
  }, [open])
  useOutsideClick([trigger, content], open, () => setOpen(false))
  useEscapeKey(() => {
    setOpen(false)
    trigger.current?.focus()
  }, open)
  const label = t('workbench.execution_mode_configuration')
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid="execution-mode-info-button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted focus-visible:outline focus-visible:outline-focus md:h-7 md:w-7"
      >
        <Info className="h-4 w-4" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={content}
            data-testid="execution-mode-info"
            role="region"
            aria-label={label}
            style={{ ...position, maxHeight: `calc(100vh - ${position.bottom + 8}px)` }}
            className="fixed z-popover overflow-auto rounded-xl border border-border bg-popover p-3 text-xs text-text-secondary shadow-lg"
          >
            <pre tabIndex={0} className="max-h-40 overflow-auto whitespace-pre-wrap break-words">
              {text}
            </pre>
          </div>,
          document.body
        )}
    </>
  )
}
