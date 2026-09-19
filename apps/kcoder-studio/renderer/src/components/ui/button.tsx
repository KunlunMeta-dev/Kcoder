import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-[background-color,border-color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:ring-offset-2 active:translate-y-px motion-reduce:transform-none motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',

  {
    variants: {
      variant: {
        primary:
          'border border-transparent bg-text-primary text-background shadow-sm hover:bg-text-primary/85',
        default:
          'border border-transparent bg-text-primary text-background shadow-sm hover:bg-text-primary/85',
        destructive:
          'border border-red-500/15 bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400',
        outline:
          'border border-border bg-background text-text-primary shadow-sm hover:border-text-muted/30 hover:bg-surface/50',
        secondary:
          'border border-transparent bg-text-primary/5 text-text-primary hover:bg-text-primary/10',
        ghost:
          'border border-transparent text-text-secondary hover:bg-text-primary/5 hover:text-text-primary',
        link: 'text-blue-500 underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-lg px-3',
        lg: 'h-11 rounded-lg px-6',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    )
  }
)
Button.displayName = 'Button'

export { Button }
