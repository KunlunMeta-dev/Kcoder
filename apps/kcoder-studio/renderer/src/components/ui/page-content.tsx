import { useLayoutEffect, useRef, type HTMLAttributes } from 'react'
import { animatePageSurface } from '@/components/layout/pageTransitionAnimation'
import { cn } from '@/lib/utils'

// Shared reading/configuration column: the former `48rem` (`768px`) column widened
// by 30% to `62.4rem` (`998.4px`). Settings, Wiki and plugin pages all read from
// this token instead of capping their content with a local literal.
export const PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS = 'max-w-[var(--studio-page-column-width)]'

// Narrow variant of the same column: the former `560px` widened by the same 30%.
export const PAGE_CONTENT_NARROW_COLUMN_MAX_WIDTH_CLASS = 'max-w-[728px]'

export interface PageContentProps extends HTMLAttributes<HTMLDivElement> {
  as?: 'div' | 'section'
  width?: 'standard' | 'narrow'
}

// Keep gutters on the scroll owner so centering does not move its scrollbar.
export function PageContent({
  as: Component = 'div',
  width = 'standard',
  className,
  ...props
}: PageContentProps) {
  const content = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => animatePageSurface(content.current), [])
  return (
    <Component
      ref={content}
      data-studio-page-content="true"
      className={cn(
        'mx-auto min-w-0 w-full',
        width === 'narrow'
          ? PAGE_CONTENT_NARROW_COLUMN_MAX_WIDTH_CLASS
          : PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS,
        className
      )}
      {...props}
    />
  )
}
