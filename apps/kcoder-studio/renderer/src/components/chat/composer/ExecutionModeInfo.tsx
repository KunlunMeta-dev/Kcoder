import { Info } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'

export function ExecutionModeInfo({ text }: { text: string }) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, bottom: 8 })
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect)
        setPosition({
          left: Math.max(8, Math.min(rect.left, innerWidth - 336)),
          bottom: Math.max(8, innerHeight - rect.top + 4),
        })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const pointer = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !content.current?.contains(event.target as Node)
      )
        setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', pointer)
      document.removeEventListener('keydown', key)
    }
  }, [open])
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
            className="fixed z-popover w-80 max-w-[calc(100vw-16px)] overflow-auto rounded-xl border border-border bg-popover p-3 text-xs text-text-secondary shadow-lg"
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
