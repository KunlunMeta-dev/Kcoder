"use dom";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type { DOMProps } from "expo/dom";
import { useDOMImperativeHandle, type DOMImperativeFactory } from "expo/dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { TerminalCommandQueue } from "./terminal-command-queue";
import { terminalFileLinksForBufferLine } from "./terminal-links";

export interface TerminalEmulatorHandle {
  write(data: string, sequence: number): void;
  replace(data: string, sequence: number): void;
  focus(): void;
  blur(): void;
  fit(): void;
  paste(data: string): void;
}

export interface TerminalEmulatorProps {
  dom?: DOMProps;
  ref: Ref<TerminalEmulatorHandle>;
  streamKey: string;
  scrollbackLines?: number;
  onInput?(data: string): void;
  onResize?(size: { rows: number; cols: number }): void;
  onSnapshot?(snapshot: string, sequence: number): void;
  onReadyChange?(ready: boolean): void;
  onOpenFile?(value: string): void;
}

export default function TerminalEmulator({ ref, streamKey, scrollbackLines = 10_000, onInput, onResize, onSnapshot, onReadyChange, onOpenFile }: TerminalEmulatorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const fitAndNotifyRef = useRef<() => void>(() => {});
  const callbacks = useRef({ onInput, onResize, onSnapshot, onReadyChange, onOpenFile });
  callbacks.current = { onInput, onResize, onSnapshot, onReadyChange, onOpenFile };
  const serializerRef = useRef<SerializeAddon | null>(null);
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollbackLinesRef = useRef(scrollbackLines);
  scrollbackLinesRef.current = scrollbackLines;
  const commandQueueRef = useRef(new TerminalCommandQueue());
  const scheduleSnapshot = (sequence: number) => {
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      const serializer = serializerRef.current;
      if (serializer) callbacks.current.onSnapshot?.(serializer.serialize({ scrollback: scrollbackLinesRef.current }), sequence);
    }, 180);
  };

  const bridgeRef = useRef<DOMImperativeFactory | null>(null);
  useDOMImperativeHandle(bridgeRef, () => ({
    write: (...args) => {
      const sequence = typeof args[1] === "number" ? args[1] : 0;
      const terminal = terminalRef.current;
      if (terminal) commandQueueRef.current.enqueue(terminal, { type: "write", data: typeof args[0] === "string" ? args[0] : "", sequence }, scheduleSnapshot);
    },
    replace: (...args) => {
      const data = typeof args[0] === "string" ? args[0] : "";
      const sequence = typeof args[1] === "number" ? args[1] : 0;
      const terminal = terminalRef.current;
      if (terminal) commandQueueRef.current.enqueue(terminal, { type: "replace", data, sequence }, scheduleSnapshot);
    },
    focus: () => terminalRef.current?.focus(),
    blur: () => terminalRef.current?.blur(),
    fit: () => fitAndNotifyRef.current(),
    paste: (...args) => terminalRef.current?.paste(typeof args[0] === "string" ? args[0] : ""),
  }), []);
  useImperativeHandle(ref, () => ({
    write: (data, sequence) => {
      const terminal = terminalRef.current;
      if (terminal) commandQueueRef.current.enqueue(terminal, { type: "write", data, sequence }, scheduleSnapshot);
    },
    replace: (data, sequence) => {
      const terminal = terminalRef.current;
      if (terminal) commandQueueRef.current.enqueue(terminal, { type: "replace", data, sequence }, scheduleSnapshot);
    },
    focus: () => terminalRef.current?.focus(),
    blur: () => terminalRef.current?.blur(),
    fit: () => fitAndNotifyRef.current(),
    paste: (data) => terminalRef.current?.paste(data),
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    commandQueueRef.current.invalidate();
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: scrollbackLines,
      screenReaderMode: true,
      convertEol: false,
      allowTransparency: false,
      theme: {
        background: "#101114",
        foreground: "#e8e8e8",
        cursor: "#f5f5f5",
        selectionBackground: "#365f7d",
        black: "#101114",
        red: "#fb7185",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e5e7eb",
      },
    });
    const fit = new FitAddon();
    const serializer = new SerializeAddon();
    const webLinks = new WebLinksAddon((_event, uri) => {
      window.open(uri, "_blank", "noopener,noreferrer");
    });
    terminal.loadAddon(fit);
    terminal.loadAddon(serializer);
    terminal.loadAddon(webLinks);
    terminal.open(host);
    const fileLinks = terminal.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        callback(terminalFileLinksForBufferLine(terminal.buffer.active, lineNumber).map((link) => ({
          range: link.range,
          text: link.text,
          activate: () => callbacks.current.onOpenFile?.(link.text),
        })));
      },
    });
    terminalRef.current = terminal;
    serializerRef.current = serializer;
    fitRef.current = fit;
    let rendererReady = false;
    let previous = "";
    const resize = () => {
      try { fit.fit(); } catch { return; }
      const key = `${terminal.rows}x${terminal.cols}`;
      if (key !== previous) {
        previous = key;
        callbacks.current.onResize?.({ rows: terminal.rows, cols: terminal.cols });
      }
      if (!rendererReady) {
        rendererReady = true;
        callbacks.current.onReadyChange?.(true);
      }
    };
    fitAndNotifyRef.current = resize;
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const input = terminal.onData((data) => callbacks.current.onInput?.(data));
    const timer = setTimeout(resize, 0);
    return () => {
      callbacks.current.onReadyChange?.(false);
      commandQueueRef.current.invalidate();
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
      clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      fileLinks.dispose();
      terminal.dispose();
      if (fitAndNotifyRef.current === resize) fitAndNotifyRef.current = () => {};
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
      if (serializerRef.current === serializer) serializerRef.current = null;
    };
  }, [streamKey]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.scrollback = scrollbackLines;
  }, [scrollbackLines]);

  return <div data-testid="terminal-emulator" onPointerDown={() => terminalRef.current?.focus()} style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden", background: "#101114" }}><div ref={hostRef} style={{ width: "100%", height: "100%" }} /></div>;
}
