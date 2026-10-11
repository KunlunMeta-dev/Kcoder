import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Shared switch. DESIGN.md 7.1: a switch applies an immediate setting, as
 * opposed to a checkbox that participates in a larger submitted selection.
 *
 * The track uses the interactive accent blue when on, which DESIGN.md 4.2
 * allows for selected emphasis, and reaches for the semantic token rather than
 * a palette literal. Colour is never the only cue: the knob position, the
 * `data-state` attribute and `aria-checked` all carry the state too (4.2, 10).
 *
 * `components/settings/settings-ui.tsx` still owns a structurally different
 * `SettingsSwitch` with nine dependants; consolidating it onto this primitive
 * is tracked as follow-up work rather than done blind here.
 */

type SwitchSize = 'sm' | 'md'

const TRACK_SIZE: Record<SwitchSize, string> = {
  sm: 'h-5 w-8',
  md: 'h-7 w-12',
}

const KNOB_SIZE: Record<SwitchSize, string> = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
}

const KNOB_INSET: Record<SwitchSize, string> = {
  sm: 'left-0.5 top-0.5',
  md: 'left-1 top-1',
}

const KNOB_CHECKED_OFFSET: Record<SwitchSize, string> = {
  sm: 'translate-x-3.5',
  md: 'translate-x-5',
}

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  size?: SwitchSize
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, size = 'md', className, disabled, onClick, ...props }, ref) => {
    const state = checked ? 'checked' : 'unchecked'
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        data-state={state}
        disabled={disabled}
        // Composed rather than spread-over: callers that pass `onClick` (rows
        // stop propagation so the row itself does not activate) must not lose
        // the toggle.
        onClick={event => {
          onClick?.(event)
          onCheckedChange(!checked)
        }}
        className={cn(
          'relative inline-flex shrink-0 items-center rounded-full transition-colors duration-fast',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-40',
          TRACK_SIZE[size],
          checked ? 'bg-focus' : 'bg-border',
          className
        )}
        {...props}
      >
        <span
          data-state={state}
          className={cn(
            'absolute rounded-full bg-white shadow-sm transition-transform duration-fast motion-reduce:transition-none',
            KNOB_SIZE[size],
            KNOB_INSET[size],
            checked ? KNOB_CHECKED_OFFSET[size] : 'translate-x-0'
          )}
        />
      </button>
    )
  }
)
Switch.displayName = 'Switch'

export { Switch }
