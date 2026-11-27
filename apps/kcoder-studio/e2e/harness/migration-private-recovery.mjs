export const PRIVATE_RECOVERY_PREFIXES = Object.freeze([
  'kcoder.migration.private:', 'kcoder.migration.private-prepare:',
  'kcoder.mobile.private-prepare:', 'kcoder.mobile.private-cancel:',
]);

/** Remove only rebuildable migration metadata; account and authentication storage remains owned by the client. */
export function clearPrivateMigrationRecovery(page) {
  return page.evaluate(prefixes => {
    const keys = Object.keys(localStorage).filter(key => prefixes.some(prefix => key.startsWith(prefix)));
    for (const key of keys) localStorage.removeItem(key);
    return { removed: keys.length, remaining: Object.keys(localStorage).filter(key => prefixes.some(prefix => key.startsWith(prefix))).length };
  }, PRIVATE_RECOVERY_PREFIXES);
}
