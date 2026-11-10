export type KeyboardGeometry = {
  overlap: number;
  imeVisible: boolean | null;
  source: string;
  generation: number;
  sequence: number;
  keyboardEpoch: number;
};
export type KeyboardGeometryState = Pick<KeyboardGeometry, "overlap" | "generation" | "sequence">;

/** Native attachment IDs increase across View replacement, not just within one View. */
export function reduceKeyboardGeometry(state: KeyboardGeometryState, event: KeyboardGeometry): KeyboardGeometryState {
  if (!Number.isSafeInteger(event.generation) || event.generation <= 0 ||
    !Number.isSafeInteger(event.sequence) || event.sequence <= 0 ||
    event.generation < state.generation || (event.generation === state.generation && event.sequence <= state.sequence)) return state;
  const overlap = event.imeVisible !== true || event.source === "unknown" || !Number.isFinite(event.overlap) ? 0 : Math.max(0, event.overlap);
  return { generation: event.generation, sequence: event.sequence, overlap };
}
