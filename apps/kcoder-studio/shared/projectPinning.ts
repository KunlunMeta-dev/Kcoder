export interface ProjectPinState {
  pinned?: boolean | null;
  pinnedOrder?: number | null;
}

/** Desktop sidebar semantics shared by clients; connection state never invents pin state. */
export function partitionPinnedProjects<T>(
  items: readonly T[],
  state: (item: T) => ProjectPinState | undefined | null,
): { pinned: T[]; regular: T[] } {
  const pinned: T[] = [], regular: T[] = [];
  for (const item of items) (state(item)?.pinned === true ? pinned : regular).push(item);
  pinned.sort((left, right) => (state(left)?.pinnedOrder ?? Number.MAX_SAFE_INTEGER) - (state(right)?.pinnedOrder ?? Number.MAX_SAFE_INTEGER));
  return { pinned, regular };
}
