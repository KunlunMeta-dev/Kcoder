import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type Ref,
} from "react";
import { Linking, StyleSheet } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { terminalWebViewHtml } from "@/terminal-webview/generated-html";

export interface TerminalEmulatorHandle {
  write(data: string, sequence: number): void;
  replace(data: string, sequence: number): void;
  focus(): void;
  blur(): void;
  fit(): void;
  paste(data: string): void;
}

export interface TerminalEmulatorProps {
  dom?: unknown;
  ref: Ref<TerminalEmulatorHandle>;
  streamKey: string;
  scrollbackLines?: number;
  onInput?(data: string): void;
  onResize?(size: { rows: number; cols: number }): void;
  onSnapshot?(snapshot: string, sequence: number): void;
  onReadyChange?(ready: boolean): void;
  onOpenFile?(value: string): void;
}

type NativeMessage =
  | { type: "ready" }
  | { type: "input"; data: string }
  | { type: "link"; value: string }
  | { type: "external-link"; value: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "snapshot"; data: string; sequence: number };

const TERMINAL_WEBVIEW_SOURCE = { html: terminalWebViewHtml };

export default function TerminalEmulator({
  ref,
  streamKey,
  scrollbackLines = 10_000,
  onInput,
  onResize,
  onSnapshot,
  onReadyChange,
  onOpenFile,
}: TerminalEmulatorProps) {
  const webViewRef = useRef<WebView>(null);
  const callbacks = useRef({
    onInput,
    onResize,
    onSnapshot,
    onReadyChange,
    onOpenFile,
  });
  callbacks.current = {
    onInput,
    onResize,
    onSnapshot,
    onReadyChange,
    onOpenFile,
  };
  const pending = useRef<Array<Record<string, unknown>>>([]);
  const pendingPaste = useRef<string[]>([]);
  const readyRef = useRef(false);
  const desiredFocusRef = useRef(false);

  const inject = useCallback((message: Record<string, unknown>) => {
    if (!readyRef.current || !webViewRef.current) {
      pending.current.push(message);
      if (pending.current.length > 256)
        pending.current.splice(0, pending.current.length - 256);
      return;
    }
    const payload = JSON.stringify(message).replace(
      /<\/script/gi,
      "<\\/script",
    );
    webViewRef.current.injectJavaScript(
      `window.__KCODER_TERMINAL_RECEIVE__?.(${payload});true;`,
    );
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      write: (data, sequence) => inject({ type: "write", data, sequence }),
      replace: (data, sequence) => inject({ type: "replace", data, sequence }),
      focus: () => {
        desiredFocusRef.current = true;
        webViewRef.current?.requestFocus();
        if (readyRef.current) inject({ type: "focus" });
      },
      blur: () => {
        desiredFocusRef.current = false;
        if (readyRef.current) inject({ type: "blur" });
      },
      fit: () => inject({ type: "fit" }),
      paste: (data) => {
        if (!readyRef.current) {
          pendingPaste.current.push(data);
          if (pendingPaste.current.length > 16)
            pendingPaste.current.splice(0, pendingPaste.current.length - 16);
          return;
        }
        inject({ type: "paste", data });
      },
    }),
    [inject],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: NativeMessage;
      try {
        message = JSON.parse(event.nativeEvent.data) as NativeMessage;
      } catch {
        return;
      }
      if (message.type === "ready") {
        readyRef.current = true;
        // The parent sends the authoritative transcript in the ready callback; discard deltas buffered during reload to prevent duplicate append.
        pending.current = [];
        callbacks.current.onReadyChange?.(true);
        inject({ type: "options", scrollbackLines });
        inject({ type: desiredFocusRef.current ? "focus" : "blur" });
        for (const data of pendingPaste.current.splice(0))
          inject({ type: "paste", data });
      } else if (message.type === "input")
        callbacks.current.onInput?.(message.data);
      else if (message.type === "link")
        callbacks.current.onOpenFile?.(message.value);
      else if (message.type === "external-link")
        void Linking.openURL(message.value).catch(() => {});
      else if (message.type === "resize")
        callbacks.current.onResize?.({
          rows: message.rows,
          cols: message.cols,
        });
      else if (message.type === "snapshot")
        callbacks.current.onSnapshot?.(message.data, message.sequence);
    },
    [inject, scrollbackLines],
  );

  useEffect(() => {
    inject({ type: "options", scrollbackLines });
  }, [inject, scrollbackLines]);

  const reloadRenderer = () => {
    readyRef.current = false;
    callbacks.current.onReadyChange?.(false);
    webViewRef.current?.reload();
  };

  const previousStreamKey = useRef(streamKey);
  useEffect(() => {
    if (previousStreamKey.current === streamKey) return;
    previousStreamKey.current = streamKey;
    readyRef.current = false;
    callbacks.current.onReadyChange?.(false);
    webViewRef.current?.reload();
  }, [streamKey]);

  return (
    <WebView
      ref={webViewRef}
      testID="terminal-emulator"
      source={TERMINAL_WEBVIEW_SOURCE}
      originWhitelist={["*"]}
      onMessage={handleMessage}
      onLoadStart={() => {
        readyRef.current = false;
        callbacks.current.onReadyChange?.(false);
      }}
      onContentProcessDidTerminate={reloadRenderer}
      onRenderProcessGone={() => {
        reloadRenderer();
        return true;
      }}
      javaScriptEnabled
      keyboardDisplayRequiresUserAction={false}
      scrollEnabled={false}
      style={styles.webView}
    />
  );
}

const styles = StyleSheet.create({
  webView: { flex: 1, backgroundColor: "#101114" },
});
