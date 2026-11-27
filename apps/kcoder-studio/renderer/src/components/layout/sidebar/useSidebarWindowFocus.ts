import { useEffect, useState } from 'react'

export function useSidebarWindowFocus(): boolean {
  const [focused, setFocused] = useState(() =>
    typeof document === 'undefined' ? true : document.hasFocus()
  )
  useEffect(() => {
    const handleFocus = () => setFocused(true)
    const handleBlur = () => setFocused(false)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
    }
  }, [])
  return focused
}
