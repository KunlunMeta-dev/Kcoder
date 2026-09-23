import { CornerDownLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { keybindingPartDisplay } from '@/lib/keyboard-platform'

interface KeyboardShortcutProps {
  value: string
  className?: string
}

export function KeyboardShortcut({ value, className }: KeyboardShortcutProps) {
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center rounded-full bg-white/10 px-2 text-sm font-medium leading-none text-current',
        className
      )}
    >
      {value.split('+').map((part, index) => (
        <span key={`${part}-${index}`} className="inline-flex items-center">
          {index > 0 ? <span className="w-0.5" /> : null}
          <KeyboardShortcutPart value={part} />
        </span>
      ))}
    </span>
  )
}

function KeyboardShortcutPart({ value }: { value: string }) {
  if (value === 'Enter') return <CornerDownLeft className="h-3.5 w-3.5" aria-label="Enter" />
  const { text, label } = keybindingPartDisplay(value)
  return <span aria-label={label}>{text}</span>
}
