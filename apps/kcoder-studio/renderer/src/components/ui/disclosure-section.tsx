import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Native disclosure keeps keyboard activation and expanded state in sync. */
export function DisclosureSection({
  title,
  description,
  icon,
  status,
  testId,
  toggleTestId,
  defaultOpen = false,
  inlineDescription = false,
  children,
  className,
  tone = 'accent',
}: {
  title: ReactNode
  description?: ReactNode
  icon: ReactNode
  status?: ReactNode
  testId: string
  toggleTestId?: string
  defaultOpen?: boolean
  inlineDescription?: boolean
  children: ReactNode
  className?: string
  tone?: 'accent' | 'neutral'
}) {
  return (
    <details
      open={defaultOpen}
      data-testid={testId}
      className={cn(
        'studio-card group/disclosure rounded-2xl border border-border/60',
        tone === 'neutral' ? 'bg-background' : 'bg-surface/30',
        className
      )}
    >
      <summary
        data-testid={toggleTestId ?? `${testId}-toggle`}
        className={cn(
          'flex cursor-pointer list-none items-center gap-3 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden',
          inlineDescription ? 'studio-card-heading min-h-[60px]' : 'studio-card-heading min-h-16'
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-xl [&>svg]:size-5',
            tone === 'neutral' ? 'bg-surface text-text-secondary' : 'bg-accent-surface text-focus'
          )}
        >
          {icon}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1',
            inlineDescription && 'flex flex-wrap items-baseline gap-x-5 gap-y-1'
          )}
        >
          <span
            className={cn(
              'block break-words font-semibold text-text-primary',
              tone === 'neutral' ? 'text-base' : 'text-lg'
            )}
          >
            {title}
          </span>
          {description && (
            <span
              className={cn(
                'block break-all text-sm text-text-secondary',
                !inlineDescription && 'mt-1'
              )}
            >
              {description}
            </span>
          )}
        </span>
        {status}
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-text-muted transition-transform group-open/disclosure:rotate-180"
        />
      </summary>
      <div className="studio-card-body">{children}</div>
    </details>
  )
}
