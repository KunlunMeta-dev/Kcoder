import type { TerminalTheme } from "./terminal-theme";

export interface TerminalWebViewOptions {
  scrollbackLines: number;
  theme: TerminalTheme;
}

export interface TerminalOptionsMessage extends TerminalWebViewOptions {
  type: "options";
}

/** Keeps the current options ready to replay whenever the WebView renderer starts. */
export class TerminalWebViewOptionsSync {
  private options: TerminalWebViewOptions;
  private ready = false;

  constructor(options: TerminalWebViewOptions) {
    this.options = options;
  }

  setOptions(options: TerminalWebViewOptions): void {
    this.options = options;
  }

  optionsChanged(): TerminalOptionsMessage | null {
    return this.ready ? this.createMessage() : null;
  }

  rendererReady(): TerminalOptionsMessage {
    this.ready = true;
    return this.createMessage();
  }

  rendererLoading(): void {
    this.ready = false;
  }

  private createMessage(): TerminalOptionsMessage {
    return { type: "options", ...this.options };
  }
}
