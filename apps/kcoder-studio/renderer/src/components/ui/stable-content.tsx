import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Layout-stable presentation primitives. Content that changes after a click or a
// late read (status text, toggled labels, selected weight) is stacked in one grid
// cell together with every alternative it can show, so the box keeps the size of its
// largest variant and surrounding content never moves. Reserved copies are
// invisible and aria-hidden, and their text lives in a CSS pseudo-element rather
// than the DOM, so it is neither announced, focusable nor matched as page text.

const STACK_CELL = 'col-start-1 row-start-1'

/** Text that only occupies space: rendered through `::before`, never as DOM text. */
export function ReserveText({ text, className }: { text: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-stable-reserve-text={text}
      className={cn('before:content-[attr(data-stable-reserve-text)]', className)}
    />
  )
}

function present(node: ReactNode) {
  return node !== null && node !== undefined && node !== false && node !== ''
}

export interface StableStatusProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Message shown now; `null`/`false` keeps the reserved space empty. */
  children?: ReactNode
  /**
   * Every message this slot can display, so it reserves the largest one up front.
   * Strings are reserved without DOM text; nodes should use `ReserveText` for text.
   */
  reserve: (string | ReactNode)[]
  /** Classes applied to the message and to each reserved copy (layout must match). */
  itemClassName?: string
}

/**
 * An always-mounted polite live region with reserved geometry. Mount it before the
 * action that fills it so assistive technology observes the change and the message
 * appears without pushing neighbours. Persistent failures still belong in an alert.
 */
export function StableStatus({ children, reserve, itemClassName, className, ...props }: StableStatusProps) {
  const active = present(children)
  return (
    <div
      // The live region is mounted up front (aria-live) so the change is announced; the
      // status role is exposed only while a message is shown, so idle slots stay silent.
      role={active ? 'status' : undefined}
      aria-live="polite"
      aria-atomic="true"
      data-stable-status
      data-active={active ? 'true' : 'false'}
      className={cn('grid', className)}
      {...props}
    >
      {reserve.map((node, index) => (
        <span
          key={index}
          aria-hidden="true"
          data-stable-reserve
          className={cn(STACK_CELL, 'invisible', itemClassName)}
        >
          {typeof node === 'string' ? <ReserveText text={node} /> : node}
        </span>
      ))}
      <span
        data-stable-current
        className={cn(
          STACK_CELL,
          'transition-opacity duration-base ease-standard motion-reduce:transition-none',
          active ? 'opacity-100' : 'opacity-0',
          itemClassName
        )}
      >
        {active ? children : null}
      </span>
    </div>
  )
}

export interface StableLabelProps extends HTMLAttributes<HTMLSpanElement> {
  /** Visible label. */
  children: ReactNode
  /** Every label this control can switch to (e.g. Show/Hide), reserved invisibly. */
  alternatives: string[]
  /** Reserve the alternatives at this weight too, e.g. `font-medium` for selected tabs. */
  reserveClassName?: string
}

/** A label that keeps the width of its longest alternative, e.g. in toggle buttons. */
export function StableLabel({
  children,
  alternatives,
  reserveClassName,
  className,
  ...props
}: StableLabelProps) {
  return (
    <span className={cn('inline-grid justify-items-center', className)} {...props}>
      <span className={STACK_CELL}>{children}</span>
      {alternatives.map((text, index) => (
        <ReserveText
          key={index}
          text={text}
          className={cn(STACK_CELL, 'invisible whitespace-nowrap', reserveClassName)}
        />
      ))}
    </span>
  )
}

/** Text whose width already accounts for a heavier selected weight, so tabs do not shift. */
export function WeightStableText({ text, weightClassName = 'font-medium' }: { text: string; weightClassName?: string }) {
  return (
    <StableLabel alternatives={[text]} reserveClassName={weightClassName}>
      {text}
    </StableLabel>
  )
}
