import { cn } from '@/lib/utils'
import { ChevronRight, Plus } from 'lucide-react'
import type { ReactNode } from 'react'

export function SidebarButton({
  icon: Icon,
  label,
  testId,
  selected,
  onClick,
}: {
  icon: typeof Plus
  label: string
  testId: string
  selected?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
      className={[
        'flex h-[30px] w-full items-center gap-2 rounded-[10px] px-2 text-left text-base font-normal leading-5',
        selected
          ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
          : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
      ].join(' ')}
    >
      <Icon className="h-4 w-4 text-current" />
      <span>{label}</span>
    </button>
  )
}

export function SidebarSectionHeader({
  title,
  expanded,
  hasContent,
  toggleTestId,
  iconTestId,
  onToggle,
  children,
}: {
  title: string
  expanded: boolean
  hasContent: boolean
  toggleTestId: string
  iconTestId: string
  onToggle: () => void
  children: ReactNode
}) {
  const iconVisibilityClass =
    hasContent && !expanded ? 'opacity-100' : 'opacity-0 group-hover/section:opacity-100'

  return (
    <div className="group/section relative mb-2 flex h-[30px] items-center px-2.5">
      <button
        type="button"
        data-testid={toggleTestId}
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md pr-16 text-left"
      >
        <span className="truncate text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-muted))] opacity-75">
          {title}
        </span>
        <ChevronRight
          data-testid={iconTestId}
          className={cn(
            'h-4 w-4 shrink-0 text-[rgb(var(--color-sidebar-text-muted))] transition-[opacity,transform]',
            expanded ? 'rotate-90' : 'rotate-0',
            iconVisibilityClass
          )}
        />
      </button>
      <div
        data-testid={`${toggleTestId}-actions`}
        className="pointer-events-auto absolute right-2.5 top-1/2 z-[70] flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover/section:opacity-100 hover:opacity-100 focus-within:opacity-100"
      >
        {children}
      </div>
    </div>
  )
}
