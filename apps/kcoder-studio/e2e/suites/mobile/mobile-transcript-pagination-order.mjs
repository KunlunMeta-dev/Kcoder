/**
 * Reassemble chronological pages fetched newest-to-oldest for display order.
 * Each page already contains rows in chronological order.
 */
export function flattenNewestFirstPages(pagesNewestFirst) {
  return [...pagesNewestFirst].reverse().flat();
}

/** Convert the inverted Mobile Web list's DOM order into its displayed order. */
export function webTranscriptDomOrderToDisplayOrder(rowsInDomOrder) {
  return [...rowsInDomOrder].reverse();
}
