import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

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
  return (
    <Component
      className={cn(
        'mx-auto min-w-0 w-full',
        width === 'narrow' ? 'max-w-[560px]' : 'max-w-3xl',
        className
      )}
      {...props}
    />
  )
}
