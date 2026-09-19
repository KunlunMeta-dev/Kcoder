import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { TerminalCommandQueue } from "@/components/terminal-command-queue";
import { TerminalTouchTracker } from "@/components/terminal-touch-tracker";
import { terminalFileLinksForBufferLine } from "@/components/terminal-links";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __KCODER_TERMINAL_RECEIVE__?: (message: InboundMessage) => void;
  }
}

type InboundMessage =
  | { type: "write"; data: string; sequence: number }
  | { type: "replace"; data: string; sequence: number }
  | { type: "options"; scrollbackLines: number }
  | { type: "paste"; data: string }
  | { type: "focus" }
  | { type: "blur" }
  | { type: "fit" };

const send = (message: unknown) => window.ReactNativeWebView?.postMessage(JSON.stringify(message));
const terminal = new Terminal({
  cursorBlink: true,
  cursorStyle: "block",
  fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.18,
  scrollback: 10_000,
  screenReaderMode: true,
  convertEol: false,
  theme: {
    background: "#101114",
    foreground: "#e8e8e8",
    cursor: "#f5f5f5",
    selectionBackground: "#365f7d",
    red: "#fb7185",
    green: "#4ade80",
    yellow: "#facc15",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
  },
});
const fit = new FitAddon();
const serializer = new SerializeAddon();
const webLinks = new WebLinksAddon((_event, uri) => send({ type: "external-link", value: uri }));
terminal.loadAddon(fit);
terminal.loadAddon(serializer);
terminal.loadAddon(webLinks);
const host = document.getElementById("terminal");
if (!host) throw new Error("terminal host missing");
terminal.open(host);
terminal.registerLinkProvider({
  provideLinks(lineNumber, callback) {
    callback(terminalFileLinksForBufferLine(terminal.buffer.active, lineNumber).map((link) => ({
      range: link.range,
      text: link.text,
      activate: () => send({ type: "link", value: link.text }),
    })));
  },
});

let previousSize = "";
let rendererReady = false;
let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
const commandQueue = new TerminalCommandQueue();
const scheduleSnapshot = (sequence: number) => {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => send({
    type: "snapshot",
    data: serializer.serialize({ scrollback: terminal.options.scrollback }),
    sequence,
  }), 180);
};
const resize = () => {
  try { fit.fit(); } catch { return; }
  const size = `${terminal.rows}x${terminal.cols}`;
  if (size !== previousSize) {
    previousSize = size;
    send({ type: "resize", rows: terminal.rows, cols: terminal.cols });
  }
  if (!rendererReady) {
    rendererReady = true;
    send({ type: "ready" });
  }
};
new ResizeObserver(resize).observe(host);
terminal.onData((data) => send({ type: "input", data }));
document.addEventListener("pointerdown", (event) => { if (event.pointerType !== "touch") terminal.focus(); });
const touchTracker = new TerminalTouchTracker();
let touchScrollRemainder = 0;
const terminalViewport = host.querySelector<HTMLElement>(".xterm-viewport");
if (terminalViewport) {
  terminalViewport.style.touchAction = "pan-y";
  terminalViewport.style.overscrollBehavior = "none";
  terminalViewport.style.setProperty("-webkit-overflow-scrolling", "touch");
}
document.addEventListener("touchstart", (event) => {
  const touch = event.touches.length === 1 ? event.touches[0] : undefined;
  if (touch) {
    touchScrollRemainder = 0;
    touchTracker.begin(touch.identifier, touch.clientX, touch.clientY);
  }
  else touchTracker.cancel();
}, { passive: true });
document.addEventListener("touchmove", (event) => {
  const touch = event.touches[0];
  if (!touch) return;
  touchScrollRemainder += touchTracker.move(touch.identifier, touch.clientX, touch.clientY);
  const row = host.querySelector<HTMLElement>(".xterm-rows > div");
  const lineHeight = row?.getBoundingClientRect().height || 16;
  const lines = Math.trunc(touchScrollRemainder / lineHeight);
  if (lines !== 0) {
    terminal.scrollLines(-lines);
    touchScrollRemainder -= lines * lineHeight;
    event.preventDefault();
  }
}, { passive: false });
document.addEventListener("touchend", (event) => {
  const touch = event.changedTouches[0];
  if (touch && touchTracker.end(touch.identifier)) terminal.focus();
  else touchTracker.cancel();
}, { passive: true });
document.addEventListener("touchcancel", () => touchTracker.cancel(), { passive: true });

window.__KCODER_TERMINAL_RECEIVE__ = (message) => {
  if (message.type === "write" || message.type === "replace") commandQueue.enqueue(terminal, message, scheduleSnapshot);
  else if (message.type === "options") {
    const requested = Number(message.scrollbackLines);
    if (Number.isFinite(requested)) terminal.options.scrollback = Math.max(1_000, Math.min(100_000, Math.round(requested)));
  }
  else if (message.type === "focus") terminal.focus();
  else if (message.type === "paste") terminal.paste(message.data);
  else if (message.type === "blur") terminal.blur();
  else if (message.type === "fit") resize();
};
setTimeout(resize, 0);
