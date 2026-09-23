export class TerminalTouchTracker {
  private identifier: number | null = null;
  private startX = 0;
  private startY = 0;
  private lastY = 0;
  private moved = false;
  private mode: "vertical" | "horizontal" | null = null;

  begin(identifier: number, x: number, y: number): void {
    this.identifier = identifier;
    this.startX = x;
    this.startY = y;
    this.lastY = y;
    this.moved = false;
    this.mode = null;
  }

  move(identifier: number, x: number, y: number): number {
    if (identifier !== this.identifier) return 0;
    const deltaY = y - this.lastY;
    this.lastY = y;
    const totalX = Math.abs(x - this.startX);
    const totalY = Math.abs(y - this.startY);
    if (!this.mode && (totalX > 8 || totalY > 8)) this.mode = totalY >= totalX ? "vertical" : "horizontal";
    if (this.mode) this.moved = true;
    return this.mode === "vertical" ? deltaY : 0;
  }

  end(identifier: number): boolean {
    const tapped = identifier === this.identifier && !this.moved;
    this.cancel();
    return tapped;
  }

  cancel(): void {
    this.identifier = null;
    this.moved = false;
    this.mode = null;
  }
}
