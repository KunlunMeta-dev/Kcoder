// Raw target paths are not browser URLs. Read those through the target-scoped
// attachment/file API instead of granting a renderer arbitrary filesystem access.
export function clientResourceUrl(value: string): string | null {
  return /^(?:https?:|blob:|data:)/i.test(value) ? value : null
}
