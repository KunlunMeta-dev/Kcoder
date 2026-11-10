/** File names are metadata candidates; only the native selector authorizes observation. */
export interface AutomationFileEntry {
  name: string
  isDirectory: boolean
  size: number
}
export interface NativeAutomationFileInputs {
  ownerKey: string
  workspaceLabel: string
  listDirectory(options: {
    relativeDirectory: string
    signal: AbortSignal
  }): Promise<AutomationFileEntry[]>
}
export const validFileSelectionName = (name: string) =>
  !!name &&
  name.length <= 255 &&
  !['.', '..'].includes(name) &&
  !/[\\/:]/.test(name) &&
  Array.from(name).every(
    character => character.codePointAt(0)! >= 32 && character.codePointAt(0)! !== 127
  )

export function validFileSelectionDirectory(value: string) {
  return (
    value === '.' ||
    (!!value && value.length <= 4096 && value.split('/').every(validFileSelectionName))
  )
}
