/** A dismissal belongs to one visible lifecycle, including its animation. */
export class DrawerDismissal {
  private generation = 0;
  private visible = false;
  closing = false;

  constructor(visible: boolean) { this.updateVisible(visible); }

  updateVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.generation += 1;
    this.closing = false;
  }

  begin(): number | undefined {
    if (!this.visible || this.closing) return;
    this.closing = true;
    return this.generation;
  }

  finish(generation: number): boolean {
    if (!this.visible || !this.closing || this.generation !== generation) return false;
    this.visible = false;
    this.generation += 1;
    return true;
  }
}

type DrawerWorkSession = {
  controller: AbortController;
  pagers: Map<string, { pager: { close(): void } }>;
};

/** Cancel only the captured work generation; a late cleanup cannot clear a new one. */
export function stopDrawerSession<T extends DrawerWorkSession>(
  reference: { current: T | null },
  session: T | null = reference.current,
): void {
  if (!session) return;
  session.controller.abort();
  for (const entry of session.pagers.values()) entry.pager.close();
  if (reference.current === session) reference.current = null;
}
