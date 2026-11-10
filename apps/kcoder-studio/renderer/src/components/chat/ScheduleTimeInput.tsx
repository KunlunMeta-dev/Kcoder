import { useEffect, useRef, useState } from 'react'
import { CalendarClock, Clock3 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export function ScheduleTimeInput({
  type,
  value,
  onChange,
  testId,
}: {
  type: 'time' | 'datetime-local'
  value: string
  onChange: (value: string) => void
  testId: string
}) {
  const { t } = useTranslation('common')
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [placement, setPlacement] = useState<{ above: boolean; right: boolean } | null>(null)
  const hour = Number(value.split(':')[0]) || 0
  const minute = Number(value.split(':')[1]) || 0
  const close = (focus = false) => {
    setPlacement(null)
    if (focus) input.current?.focus({ preventScroll: true })
  }
  const open = () => {
    if (input.current?.matches(':disabled')) return
    if (type === 'datetime-local') {
      input.current?.focus({ preventScroll: true })
      try {
        input.current?.showPicker?.()
      } catch {
        /* Keyboard entry remains available on unsupported hosts. */
      }
      return
    }
    const bounds = root.current?.getBoundingClientRect()
    setPlacement({
      above: !!bounds && window.innerHeight - bounds.bottom < 280 && bounds.top > 280,
      right: !!bounds && bounds.left + 256 > window.innerWidth - 16,
    })
  }
  const choose = (column: 'hour' | 'minute', number: number) => {
    onChange(
      `${String(column === 'hour' ? number : hour).padStart(2, '0')}:${String(column === 'minute' ? number : minute).padStart(2, '0')}`
    )
  }
  useEffect(() => {
    if (!placement) return
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setPlacement(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setPlacement(null)
        input.current?.focus({ preventScroll: true })
      }
    }
    root.current?.querySelectorAll<HTMLElement>('[role="listbox"]').forEach(list => {
      const selected = list.querySelector<HTMLElement>('[aria-selected="true"]')
      if (selected)
        list.scrollTop = selected.offsetTop - list.clientHeight / 2 + selected.offsetHeight / 2
    })
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape, true)
    }
  }, [placement])
  return (
    <div
      ref={root}
      className={`relative flex min-h-11 max-w-full items-center rounded-xl border border-border bg-background transition-[border-color,box-shadow,background-color] duration-150 ease-out hover:border-focus/50 hover:bg-focus/5 hover:shadow-sm focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/20 has-[:disabled]:opacity-50 ${type === 'time' ? 'w-44' : 'w-72'}`}
    >
      <input
        ref={input}
        data-testid={testId}
        type={type}
        required
        step={type === 'time' ? 60 : 1}
        value={value}
        aria-label={t(
          type === 'time' ? 'automations.timePicker.time' : 'automations.timePicker.dateTime'
        )}
        onChange={event => onChange(event.target.value)}
        onClick={event => {
          if (type === 'datetime-local') {
            event.preventDefault()
            open()
          }
        }}
        className="min-w-0 flex-1 rounded-xl bg-transparent px-3 py-2 text-sm text-text-primary outline-none [color-scheme:light_dark] [&::-webkit-calendar-picker-indicator]:hidden"
      />
      <button
        type="button"
        data-testid={`${testId}-picker`}
        aria-label={t('automations.timePicker.open')}
        aria-expanded={type === 'time' ? !!placement : undefined}
        aria-haspopup={type === 'time' ? 'dialog' : undefined}
        onClick={() => (placement ? close(true) : open())}
        className="mr-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors duration-150 hover:bg-focus/10 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:size-11"
      >
        {type === 'time' ? (
          <Clock3 className="size-4" aria-hidden="true" />
        ) : (
          <CalendarClock className="size-4" aria-hidden="true" />
        )}
      </button>
      {placement && (
        <div
          role="dialog"
          aria-label={t('automations.timePicker.title')}
          data-testid={`${testId}-panel`}
          className={`absolute z-popover w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-3 text-text-primary shadow-lg ${placement.above ? 'bottom-full mb-2' : 'top-full mt-2'} ${placement.right ? 'right-0' : 'left-0'}`}
        >
          <div className="grid grid-cols-2 gap-3">
            {(['hour', 'minute'] as const).map(column => (
              <div key={column} className="min-w-0">
                <div className="pb-2 text-center text-xs text-text-muted">
                  {t(`automations.timePicker.${column}`)}
                </div>
                <div
                  role="listbox"
                  aria-label={t(`automations.timePicker.${column}`)}
                  className="relative max-h-44 overflow-y-auto overscroll-contain rounded-lg bg-surface/50 p-1"
                  onKeyDown={event => {
                    const options = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')
                    )
                    const index = options.indexOf(document.activeElement as HTMLButtonElement)
                    if (index < 0 || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
                      return
                    event.preventDefault()
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? options.length - 1
                          : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
                            options.length
                    options[next]?.focus({ preventScroll: true })
                    const option = options[next]
                    if (option)
                      event.currentTarget.scrollTop =
                        option.offsetTop - event.currentTarget.clientHeight / 2
                    choose(column, next)
                  }}
                >
                  {Array.from({ length: column === 'hour' ? 24 : 60 }, (_, number) => (
                    <button
                      key={number}
                      type="button"
                      role="option"
                      aria-selected={number === (column === 'hour' ? hour : minute)}
                      data-testid={`${testId}-${column}-${number}`}
                      tabIndex={number === (column === 'hour' ? hour : minute) ? 0 : -1}
                      onClick={() => choose(column, number)}
                      className="flex min-h-9 w-full items-center justify-center rounded-md text-sm tabular-nums transition-colors duration-150 hover:bg-focus/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus aria-selected:bg-foreground aria-selected:font-medium aria-selected:text-background max-md:min-h-11"
                    >
                      {String(number).padStart(2, '0')}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            data-testid={`${testId}-done`}
            onClick={() => close(true)}
            className="mt-3 min-h-9 w-full rounded-lg bg-foreground px-3 text-sm text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
          >
            {t('automations.timePicker.done')}
          </button>
        </div>
      )}
    </div>
  )
}
