import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'

// Deliberately process-local: navigation preserves selection; restarting Studio resets it.
const selections = new Map<string, string>()
const scopeKey = (deviceId?: string, workspacePath?: string) =>
  JSON.stringify([deviceId ?? null, workspacePath ?? null])

listenAccountContextChanges(targetId => {
  for (const key of selections.keys()) {
    const [deviceId] = JSON.parse(key) as [string | null, string | null]
    if (deviceId === null || deviceId === targetId) selections.delete(key)
  }
})

export function recallMarketplace(deviceId?: string, workspacePath?: string): string {
  return selections.get(scopeKey(deviceId, workspacePath)) ?? ''
}

export function rememberMarketplace(
  deviceId: string | undefined,
  workspacePath: string | undefined,
  marketplaceKey: string
): void {
  selections.set(scopeKey(deviceId, workspacePath), marketplaceKey)
}
