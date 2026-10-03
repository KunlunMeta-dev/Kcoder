import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Keep design-token heights in the same conflict group as caller height overrides.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: { h: [{ h: ['control-sm', 'control-md', 'control-lg', 'control-xl'] }] },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
