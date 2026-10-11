export type KeyboardPlatform = 'mac' | 'windows' | 'linux' | 'other'

export function getKeyboardPlatform(): KeyboardPlatform {
  if (typeof navigator === 'undefined') return 'other'
  // Shortcuts follow the client keyboard, never the connected runtime's OS.
  const platform = navigator.platform || navigator.userAgent || ''
  if (/Mac|iPhone|iPad|iPod/i.test(platform)) return 'mac'
  if (/Win/i.test(platform)) return 'windows'
  if (/Linux/i.test(platform)) return 'linux'
  return 'other'
}

export function keybindingPartDisplay(
  value: string,
  platform = getKeyboardPlatform()
): { text: string; label: string } {
  const isMac = platform === 'mac'
  if (value === 'CommandOrControl')
    return keybindingPartDisplay(isMac ? 'Command' : 'Control', platform)
  if (value === 'Command') {
    // A stored Command is an explicit Meta key, not a portable primary modifier.
    const label = isMac ? 'Command' : platform === 'windows' ? 'Win' : 'Super'
    return { text: isMac ? '⌘' : label, label }
  }
  if (value === 'Control') return { text: isMac ? '⌃' : 'Ctrl', label: 'Control' }
  if (value === 'Alt') return { text: isMac ? '⌥' : 'Alt', label: isMac ? 'Option' : 'Alt' }
  if (value === 'Shift') return { text: isMac ? '⇧' : 'Shift', label: 'Shift' }
  if (value === 'Plus') return { text: '+', label: 'Plus' }
  if (value === 'Minus') return { text: '−', label: 'Minus' }
  return { text: value, label: value }
}
