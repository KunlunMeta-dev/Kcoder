export const TOOLS_CATALOG_INVALIDATED_EVENT = 'kcoder:tools-catalog-invalidated'

/** Invalidate presentation for the changed target, without granting tool access. */
export function notifyToolsCatalogChanged(deviceId?: string): void {
  window.dispatchEvent(new CustomEvent(TOOLS_CATALOG_INVALIDATED_EVENT, { detail: { deviceId } }))
}

/** Older unscoped notices still require a read; scoped notices leave peers alone. */
export function toolsCatalogChangeApplies(event: Event, deviceId?: string): boolean {
  const changedTarget = (event as CustomEvent<{ deviceId?: string }>).detail?.deviceId
  return !changedTarget || !deviceId || changedTarget === deviceId
}
