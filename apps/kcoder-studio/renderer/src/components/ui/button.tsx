import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium transition-[background-color,border-color,box-shadow,transform] duration-base ease-standard focus-visible:outline-none focus-visible:border-focus active:translate-y-px disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',

  {
    variants: {
      variant: {
        primary:
          'border border-text-primary/80 bg-text-primary text-background hover:bg-text-primary/85',
        default:
          'border border-text-primary/80 bg-text-primary text-background hover:bg-text-primary/85',
        destructive:
          'border border-destructive/15 bg-destructive/10 text-destructive hover:bg-destructive/20',
        outline:
          'border border-text-primary/10 bg-background text-text-primary shadow-control hover:border-text-primary/20 hover:bg-surface/50 hover:shadow-control-hover active:shadow-control-pressed',
        secondary:
          'border border-text-primary/5 bg-text-primary/5 text-text-primary shadow-control hover:border-text-primary/10 hover:bg-text-primary/10 active:shadow-control-pressed',
        ghost:
          'border border-transparent text-text-secondary hover:bg-text-primary/5 hover:text-text-primary',
        // DESIGN.md 4.2 defines `#339CFF` as the focus *and link* blue, so the
        // link variant shares the focus token rather than a literal default.
        // Teal is explicitly forbidden here (4.3).
        link: 'text-focus underline-offset-4 hover:underline focus-visible:underline',
      },
      size: {
        default: 'h-control-lg px-4 py-2',
        sm: 'h-control-md rounded-lg px-3',
        lg: 'h-control-xl rounded-lg px-6',
        icon: 'h-control-lg w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

/**
 * Pending presentation for any button (shared `Button` or a domain `<button>` whose
 * class list includes `relative`). The idle label stays mounted but transparent so
 * the button keeps its width, and a centered 12px spinner overlays it. When given,
 * `pendingLabel` (e.g. "Saving…") becomes the accessible name instead of being
 * swapped in visibly, which would resize the button.
 */
export function ButtonPendingContent({
  pending,
  pendingLabel,
  children,
}: {
  pending: boolean
  pendingLabel?: React.ReactNode
  children?: React.ReactNode
}) {
  if (!pending) return <>{children}</>
  return (
    <>
      <span
        data-button-label
        aria-hidden={pendingLabel ? true : undefined}
        className="inline-flex items-center justify-center gap-[inherit] opacity-0"
      >
        {children}
      </span>
      {pendingLabel && <span className="sr-only">{pendingLabel}</span>}
      <span aria-hidden="true" data-button-spinner className="absolute inset-0 flex items-center justify-center">
        <Loader2 className="!size-3 animate-spin motion-reduce:animate-none" />
      </span>
    </>
  )
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /**
   * Pending operation owned by this button (see `ButtonPendingContent`). Clicks are
   * ignored and `aria-busy`/`aria-disabled` are set without native `disabled`, so
   * keyboard focus stays on the button. Ignored with `asChild`.
   */
  pending?: boolean
  /** Accessible name while pending, such as "Saving…"; the visible label does not change. */
  pendingLabel?: React.ReactNode
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, pending = false, pendingLabel, children, onClick, ...props },
    ref
  ) => {
    if (asChild) {
      return (
        <Slot className={cn(buttonVariants({ variant, size, className }))} ref={ref} onClick={onClick} {...props}>
          {children}
        </Slot>
      )
    }
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }), pending && 'relative cursor-progress')}
        ref={ref}
        {...props}
        aria-busy={pending ? true : props['aria-busy']}
        aria-disabled={pending ? true : props['aria-disabled']}
        data-pending={pending ? 'true' : undefined}
        onClick={event => {
          if (pending) {
            event.preventDefault()
            return
          }
          onClick?.(event)
        }}
      >
        <ButtonPendingContent pending={pending} pendingLabel={pendingLabel}>
          {children}
        </ButtonPendingContent>
      </button>
    )
  }
)
Button.displayName = 'Button'

export { Button }
