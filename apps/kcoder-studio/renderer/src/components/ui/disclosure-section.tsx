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
  defaultOpen = false,
  inlineDescription = false,
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  icon: ReactNode
  status?: ReactNode
  testId: string
  defaultOpen?: boolean
  inlineDescription?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <details
      open={defaultOpen}
      data-testid={testId}
      className={cn(
        'group/disclosure rounded-2xl border border-border/60 bg-surface/30',
        className
      )}
    >
      <summary
        data-testid={`${testId}-toggle`}
        className={cn(
          'flex cursor-pointer list-none items-center gap-3 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden',
          inlineDescription ? 'min-h-[60px] px-4 py-2.5' : 'min-h-16 p-4'
        )}
      >
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-surface text-focus [&>svg]:size-5"
        >
          {icon}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1',
            inlineDescription && 'flex flex-wrap items-baseline gap-x-5 gap-y-1'
          )}
        >
          <span className="block break-words text-lg font-semibold text-text-primary">{title}</span>
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
          className="size-4 shrink-0 text-text-muted transition-transform group-open/disclosure:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  )
}
