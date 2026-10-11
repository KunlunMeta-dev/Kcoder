export interface TerminalWriter {
  reset(): void;
  write(data: string, callback: () => void): void;
}

export type TerminalCommand =
  | { type: "write"; data: string; sequence: number }
  | { type: "replace"; data: string; sequence: number };

/** Serialize asynchronous xterm parsing and reset into one ordered command stream. */
export class TerminalCommandQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  enqueue(
    writer: TerminalWriter,
    command: TerminalCommand,
    applied: (sequence: number) => void,
  ): void {
    const generation = this.generation;
    this.tail = this.tail.then(
      () =>
        new Promise<void>((resolve) => {
          if (generation !== this.generation) {
            resolve();
            return;
          }
          if (command.type === "replace") writer.reset();
          if (!command.data) {
            applied(command.sequence);
            resolve();
            return;
          }
          writer.write(command.data, () => {
            if (generation === this.generation) applied(command.sequence);
            resolve();
          });
        }),
    );
  }

  invalidate(): void {
    this.generation += 1;
    this.tail = Promise.resolve();
  }
}
