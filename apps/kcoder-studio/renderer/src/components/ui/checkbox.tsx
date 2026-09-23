import { forwardRef, useCallback, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  indeterminate?: boolean
}

// Native input semantics preserve form submission, labels, Space activation,
// change events and disabled fieldsets. Only the visual treatment is custom.
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { indeterminate = false, className, ...props },
  ref
) {
  const attach = useCallback(
    (element: HTMLInputElement | null) => {
      if (element) element.indeterminate = indeterminate
      if (typeof ref === 'function') return ref(element)
      if (ref) ref.current = element
    },
    [indeterminate, ref]
  )
  return (
    <input {...props} ref={attach} type="checkbox" className={cn('studio-checkbox', className)} />
  )
})
