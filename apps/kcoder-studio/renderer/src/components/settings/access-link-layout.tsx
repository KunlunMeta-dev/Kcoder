import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SettingsIcon } from './settings-ui'

export const accessAddressClass =
  'min-h-control-lg w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11'

export function AccessLinkRow({
  id,
  title,
  description,
  icon,
  control,
  children,
  defaultOpen,
}: {
  id: string
  title: string
  description?: string
  icon: ReactNode
  control?: ReactNode
  children?: ReactNode
  defaultOpen?: boolean
}) {
  const rowClass = cn(
    'flex min-h-20 min-w-0 items-center gap-3 px-5 py-3 max-sm:gap-2 max-sm:px-3',
    control && 'pe-20 max-sm:pe-16'
  )
  const heading = (
    <>
      <SettingsIcon>{icon}</SettingsIcon>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-semibold text-text-primary">{title}</span>
        {description && <span className="mt-0.5 block break-words text-sm leading-snug text-text-secondary">{description}</span>}
      </span>
    </>
  )
  return (
    <div className="relative min-w-0" data-testid={id}>
      {children ? (
        <details open={defaultOpen} className="group/access">
          <summary
            data-testid={`${id}-details`}
            className={cn(rowClass, 'cursor-pointer list-none transition-colors hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [&::-webkit-details-marker]:hidden')}
          >
            {heading}
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-text-muted transition-transform group-open/access:rotate-180" />
          </summary>
          <div className="border-t border-border/60 bg-surface/30 px-5 py-5 max-sm:px-3">{children}</div>
        </details>
      ) : <div className={rowClass}>{heading}</div>}
      {control && <div className="absolute end-3 top-0 flex h-20 items-center sm:end-5">{control}</div>}
    </div>
  )
}

export function AccessLinkPanel({ qr, children }: { qr?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-5">
      {qr && <div className="max-w-full shrink-0">{qr}</div>}
      <div className="min-w-0 flex-[1_1_18rem] space-y-3">{children}</div>
    </div>
  )
}
