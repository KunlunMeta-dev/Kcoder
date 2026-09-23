import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  type GestureResponderEvent,
  Image,
  Keyboard,
  LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  File,
  Folder,
  Globe2,
  Image as ImageIcon,
  RefreshCw,
  Save,
  Search,
  TerminalSquare,
  X,
} from "lucide-react-native";
import { GatewayRpcClient } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import type { TaskRuntime } from "@/runtime/task-runtime";
import type { WorkspaceFileDraft } from "@/storage/workspace-preferences";
import {
  getAppPreferencesSnapshot,
  subscribeAppPreferences,
} from "@/storage/app-preferences";
import TerminalEmulator, {
  type TerminalEmulatorHandle,
} from "./terminal-emulator";
import { Button, EmptyState } from "./ui";
import {
  browserAddressAfterFrame,
  browserViewportForLayout,
  browserWheelDelta,
  classifyBrowserGesture,
  normalizeBrowserUrl,
  type BrowserGestureMode,
} from "./browser-viewport";
import { editorScrollOffsetY } from "./editor-scroll";
import {
  isWorkspacePath,
  joinWorkspacePath,
  workspaceRelativePath,
} from "./workspace-path";
import { colors, radius, spacing } from "@/theme";
import { requestConfirmation } from "@/platform/confirmation";
import {
  TerminalTranscriptBuffer,
  terminalTranscriptCharacterLimit,
} from "./terminal-transcript-buffer";
import {
  TerminalModifierLatch,
  TerminalVirtualKeyboard,
} from "./terminal-virtual-keyboard";
import {
  isWorkspaceFileConflictError,
  workspaceImageMimeType,
} from "./workspace-file-links";
import * as Clipboard from "expo-clipboard";
import { fromByteArray, toByteArray } from "base64-js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function TerminalPanel({
  task,
  demo,
  paneActive = true,
  panelId = "terminal",
  initialSessionId,
  onSessionIdChange,
  onOpenFile,
}: {
  task: TaskRuntime;
  demo: boolean;
  paneActive?: boolean;
  panelId?: string;
  initialSessionId?: string;
  onSessionIdChange?(sessionId: string | undefined): void;
  onOpenFile?(value: string): boolean;
}) {
  const appPreferences = useSyncExternalStore(
    subscribeAppPreferences,
    getAppPreferencesSnapshot,
    getAppPreferencesSnapshot,
  );
  const taskSnapshot = useSyncExternalStore(
    task.subscribe,
    task.getSnapshot,
    task.getSnapshot,
  );
  const [restartRevision, setRestartRevision] = useState(0);
  const [terminalLinkError, setTerminalLinkError] = useState<string | null>(
    null,
  );
  const terminalSession = useMemo(
    () => (demo ? null : task.terminalSession(panelId, initialSessionId)),
    [demo, initialSessionId, panelId, task],
  );
  const demoTerminalSnapshot = useMemo(
    () => ({
      panelId,
      sessionId: null,
      cwd: taskSnapshot.cwd,
      status: "running" as const,
      error: null,
      sequence: 0,
    }),
    [panelId, taskSnapshot.cwd],
  );
  const emptyTerminalSubscribe = useCallback(() => () => {}, []);
  const readDemoTerminalSnapshot = useCallback(
    () => demoTerminalSnapshot,
    [demoTerminalSnapshot],
  );
  const terminalSnapshot = useSyncExternalStore(
    terminalSession?.subscribe ?? emptyTerminalSubscribe,
    terminalSession?.getSnapshot ?? readDemoTerminalSnapshot,
    terminalSession?.getSnapshot ?? readDemoTerminalSnapshot,
  );
  const sessionId = terminalSnapshot.sessionId;
  const emulatorRef = useRef<TerminalEmulatorHandle | null>(null);
  const emulatorReady = useRef(false);
  const terminalTranscript = useRef(new TerminalTranscriptBuffer());
  const outputSequence = useRef(0);
  const demoInitialized = useRef(false);
  const lastTerminalSize = useRef({ rows: 28, cols: 100 });
  const terminalModifiers = useRef(new TerminalModifierLatch());

  useEffect(() => {
    if (!demo) onSessionIdChange?.(sessionId ?? undefined);
  }, [demo, onSessionIdChange, sessionId]);

  useEffect(() => {
    if (!terminalLinkError) return;
    const timer = setTimeout(() => setTerminalLinkError(null), 4_000);
    return () => clearTimeout(timer);
  }, [terminalLinkError]);

  const openTerminalFile = useCallback(
    (value: string) => {
      if (onOpenFile?.(value)) {
        setTerminalLinkError(null);
        return;
      }
      setTerminalLinkError(`无法在当前工作区打开：${value}`);
    },
    [onOpenFile],
  );

  useEffect(() => {
    const lines = appPreferences.terminalScrollbackLines;
    terminalTranscript.current.setLimits(
      terminalTranscriptCharacterLimit(lines),
      lines,
    );
    terminalSession?.setScrollbackLines(lines);
  }, [appPreferences.terminalScrollbackLines, terminalSession]);

  const attachEmulator = useCallback(
    (handle: TerminalEmulatorHandle | null) => {
      emulatorRef.current = handle;
      if (!handle) emulatorReady.current = false;
    },
    [],
  );

  const renderOutput = useCallback((data: string) => {
    terminalTranscript.current.append(data);
    outputSequence.current += 1;
    if (emulatorReady.current)
      emulatorRef.current?.write(data, outputSequence.current);
  }, []);

  const replaceOutput = useCallback((data: string) => {
    terminalTranscript.current.replace(data);
    outputSequence.current += 1;
    if (!emulatorReady.current) return;
    emulatorRef.current?.replace(
      terminalTranscript.current.toString(),
      outputSequence.current,
    );
  }, []);

  const rendererReadyChanged = useCallback((ready: boolean) => {
    emulatorReady.current = ready;
    if (!ready || !emulatorRef.current) return;
    emulatorRef.current.replace(
      terminalTranscript.current.toString(),
      outputSequence.current,
    );
  }, []);
  const rendererSnapshotChanged = useCallback(
    (snapshot: string, sequence: number) => {
      // Asynchronous rendering may return an old snapshot after new output arrives; accept only snapshots covering all known output.
      if (sequence !== outputSequence.current) return;
      terminalTranscript.current.replace(snapshot);
      terminalSession?.captureSnapshot(snapshot, sequence);
    },
    [terminalSession],
  );

  useEffect(() => {
    if (!demo || demoInitialized.current) return;
    demoInitialized.current = true;
    replaceOutput(
      "\u001b[1;32mKCoder Terminal\u001b[0m · /data/projects/kcoder\r\n$ pwd\r\n/data/projects/kcoder\r\n$ ",
    );
  }, [demo, replaceOutput]);

  useEffect(() => {
    if (!terminalSession) return;
    const synchronize = () => {
      const current = terminalSession.getSnapshot();
      const transcript = terminalSession.getTranscript();
      terminalTranscript.current.replace(transcript);
      outputSequence.current = current.sequence;
      if (emulatorReady.current)
        emulatorRef.current?.replace(transcript, current.sequence);
    };
    synchronize();
    const unsubscribe = terminalSession.subscribeOutput((event) => {
      if (event.sequence <= outputSequence.current) return;
      if (
        event.kind === "append" &&
        event.sequence === outputSequence.current + 1
      )
        renderOutput(event.data);
      else synchronize();
    });
    void terminalSession.start();
    return unsubscribe;
  }, [renderOutput, terminalSession]);

  useEffect(() => {
    if (paneActive) {
      const timer = setTimeout(() => emulatorRef.current?.fit(), 60);
      return () => clearTimeout(timer);
    }
    emulatorRef.current?.blur();
    terminalModifiers.current.clear();
    Keyboard.dismiss();
  }, [paneActive]);

  useEffect(() => {
    if (!paneActive) return;
    const refit = () => {
      requestAnimationFrame(() => emulatorRef.current?.fit());
      setTimeout(() => emulatorRef.current?.fit(), 180);
    };
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      refit,
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      refit,
    );
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") refit();
    });
    return () => {
      show.remove();
      hide.remove();
      appState.remove();
    };
  }, [paneActive]);

  const writeRaw = useCallback(
    (data: string) => {
      if (demo) {
        renderOutput(
          data === "\r" || data === "\n"
            ? "\r\ncommand: not executed in demo\r\n$ "
            : data,
        );
        return;
      }
      terminalSession?.write(data);
    },
    [demo, renderOutput, terminalSession],
  );

  const write = useCallback(
    (data: string) => {
      writeRaw(terminalModifiers.current.consume(data));
    },
    [writeRaw],
  );

  const pasteClipboard = useCallback(() => {
    void Clipboard.getStringAsync()
      .then((value) => {
        if (value) emulatorRef.current?.paste(value);
      })
      .catch(() =>
        setTerminalLinkError(
          "当前 HTTP 浏览器无法读取剪贴板；请点终端后使用系统 Ctrl+V 或键盘粘贴",
        ),
      );
  }, []);

  useEffect(() => {
    // A modifier applies only to the next input on the current PTY and cannot leak into a new session after disconnect or restart.
    terminalModifiers.current.clear();
  }, [restartRevision, sessionId]);

  const resize = useCallback(
    ({ rows, cols }: { rows: number; cols: number }) => {
      if (
        !Number.isFinite(rows) ||
        !Number.isFinite(cols) ||
        rows < 1 ||
        cols < 1
      )
        return;
      const size = { rows: Math.floor(rows), cols: Math.floor(cols) };
      lastTerminalSize.current = size;
      // Send the latest size to runtime before session start as well. Under remote SSH,
      // terminal/start may follow xterm's first fit; runtime applies or resends the size when creating the PTY.
      if (!paneActive || AppState.currentState !== "active" || demo) return;
      terminalSession?.resize(size.rows, size.cols);
    },
    [demo, paneActive, sessionId, terminalSession],
  );

  return (
    <View testID="terminal-panel" style={panelStyles.root}>
      <View style={styles.terminalHeader}>
        <TerminalSquare size={17} color={colors.textMuted} />
        <Text numberOfLines={1} style={styles.terminalTitle}>
          Shell · {taskSnapshot.cwd.split("/").filter(Boolean).at(-1) ?? "/"}
        </Text>
        <View
          style={[
            styles.connectionDot,
            sessionId || demo ? styles.online : styles.pending,
          ]}
        />
        {!sessionId && !demo && taskSnapshot.connected ? (
          <Pressable
            testID="terminal-restart"
            accessibilityRole="button"
            accessibilityLabel="重新启动终端"
            onPress={() => {
              setRestartRevision((value) => value + 1);
              void terminalSession?.restart();
            }}
            style={styles.terminalRestart}
          >
            <RefreshCw size={15} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.terminalSurface}>
        <TerminalEmulator
          ref={attachEmulator}
          streamKey={`${demo ? "demo" : panelId}-${restartRevision}`}
          scrollbackLines={appPreferences.terminalScrollbackLines}
          onInput={write}
          onResize={resize}
          onSnapshot={rendererSnapshotChanged}
          onReadyChange={rendererReadyChanged}
          onOpenFile={openTerminalFile}
          dom={{ matchContents: false, style: styles.terminalDom }}
        />
        {terminalSnapshot.error || terminalLinkError ? (
          <Text accessibilityRole="alert" style={styles.terminalError}>
            {terminalSnapshot.error ?? terminalLinkError}
          </Text>
        ) : null}
      </View>
      <TerminalVirtualKeyboard
        latch={terminalModifiers.current}
        disabled={!sessionId && !demo}
        onInput={writeRaw}
        onPaste={pasteClipboard}
        onFocusKeyboard={() => emulatorRef.current?.focus()}
      />
    </View>
  );
}

interface BrowserFrame {
  data_base64: string;
  mime_type: string;
  width: number;
  height: number;
  page?: {
    url?: string;
    title?: string;
    canGoBack?: boolean;
    canGoForward?: boolean;
  };
}

export function BrowserPanel({
  profile,
  server,
  cwd,
  demo,
  active,
  initialUrl,
  onUrlChange,
}: {
  profile: GatewayProfile;
  server: KCoderServer;
  cwd: string;
  demo: boolean;
  active: boolean;
  initialUrl?: string;
  onUrlChange?(url: string): void;
}) {
  const [url, setUrl] = useState(() =>
    normalizeBrowserUrl(initialUrl ?? profile.baseUrl),
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyboardText, setKeyboardText] = useState("");
  const [appActive, setAppActive] = useState(
    AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
  );
  const [layout, setLayout] = useState({ width: 1, height: 1 });
  const [panelLayout, setPanelLayout] = useState({ width: 1, height: 1 });
  const refreshInFlight = useRef<{
    generation: number;
    sessionId: string;
    operation: Promise<void>;
  } | null>(null);
  const browserClient = useRef<GatewayRpcClient | null>(null);
  const browserUnsubscribe = useRef<(() => void) | null>(null);
  const browserSession = useRef<string | null>(null);
  const browserGeneration = useRef(0);
  const browserStartInFlight = useRef<Promise<void> | null>(null);
  const dragActive = useRef(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragLastPoint = useRef<{ x: number; y: number } | null>(null);
  const dragMoved = useRef(false);
  const gestureMode = useRef<BrowserGestureMode>("pending");
  const browserActionQueue = useRef<Promise<unknown>>(Promise.resolve());
  const lastPointerMove = useRef(0);
  const lastBrowserInteraction = useRef(0);
  const onUrlChangeRef = useRef(onUrlChange);
  const urlEditing = useRef(false);
  onUrlChangeRef.current = onUrlChange;

  const screenshot = useCallback(
    async (id = sessionId, forceAfterCurrent = false) => {
      if (!id || demo) return;
      const client = browserClient.current;
      if (!client) return;
      const generation = browserGeneration.current;
      if (
        refreshInFlight.current?.generation === generation &&
        refreshInFlight.current.sessionId === id
      ) {
        await refreshInFlight.current.operation;
        if (!forceAfterCurrent) return;
        if (
          generation !== browserGeneration.current ||
          browserClient.current !== client ||
          browserSession.current !== id
        )
          return;
      }
      const operation = (async () => {
        try {
          const next = await client.request<BrowserFrame>(
            "browser/screenshot",
            { session_id: id },
            20_000,
          );
          if (
            generation !== browserGeneration.current ||
            browserClient.current !== client ||
            browserSession.current !== id
          )
            return;
          if (!next) throw new Error("远程浏览器连接尚未建立");
          setFrame(next);
          setUrl((current) =>
            browserAddressAfterFrame(
              current,
              next.page?.url,
              urlEditing.current,
            ),
          );
          setError(null);
        } catch (value) {
          if (
            generation !== browserGeneration.current ||
            browserClient.current !== client ||
            browserSession.current !== id
          )
            return;
          const message =
            value instanceof Error ? value.message : String(value);
          // During page navigation CDP briefly detaches from the old target and recovers automatically on the next poll.
          if (!message.includes("Not attached to an active page"))
            setError(message);
        }
      })();
      const tracked = { generation, sessionId: id, operation };
      refreshInFlight.current = tracked;
      try {
        await operation;
      } finally {
        if (refreshInFlight.current === tracked) refreshInFlight.current = null;
      }
    },
    [demo, sessionId],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!url.trim()) return;
    const timer = setTimeout(() => onUrlChangeRef.current?.(url.trim()), 400);
    return () => clearTimeout(timer);
  }, [url]);

  useEffect(() => {
    if (!sessionId || demo || !active || !appActive) return;
    let stopped = false;
    const tick = async () => {
      await screenshot(sessionId);
      const recentlyInteractive =
        Date.now() - lastBrowserInteraction.current < 4_000;
      if (!stopped) timer = setTimeout(tick, recentlyInteractive ? 700 : 2_000);
    };
    let timer = setTimeout(tick, 400);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, appActive, demo, screenshot, sessionId]);

  useEffect(
    () => () => {
      browserGeneration.current += 1;
      browserUnsubscribe.current?.();
      browserUnsubscribe.current = null;
      const client = browserClient.current;
      if (browserSession.current && client && !demo) {
        void client
          .request("browser/close", { session_id: browserSession.current })
          .catch(() => {});
      }
      client?.close();
      browserClient.current = null;
      browserSession.current = null;
    },
    [demo],
  );

  const start = async (): Promise<void> => {
    if (browserStartInFlight.current) return browserStartInFlight.current;
    const rawUrl = url.trim();
    if (!rawUrl) {
      setError("请输入要打开的网页地址");
      return;
    }
    const targetUrl = normalizeBrowserUrl(rawUrl);
    setUrl(targetUrl);
    const generation = ++browserGeneration.current;
    const operation = (async () => {
      setLoading(true);
      setError(null);
      if (demo) {
        setSessionId("demo-browser");
        return;
      }
      let client = browserClient.current;
      try {
        const currentSession = browserSession.current;
        if (currentSession && client) {
          await client.request("browser/action", {
            session_id: currentSession,
            action: "navigate",
            url: targetUrl,
          });
          if (generation === browserGeneration.current)
            await screenshot(currentSession, true);
          return;
        }
        client = await GatewayRpcClient.connect(
          profile,
          server,
          cwd,
          "browser",
        );
        if (generation !== browserGeneration.current) {
          client.close();
          return;
        }
        browserClient.current = client;
        browserUnsubscribe.current?.();
        browserUnsubscribe.current = client.subscribe((message) => {
          if (
            message.method !== "connection/closed" ||
            browserClient.current !== client
          )
            return;
          browserGeneration.current += 1;
          browserUnsubscribe.current?.();
          browserUnsubscribe.current = null;
          browserSession.current = null;
          browserClient.current = null;
          setSessionId(null);
          setFrame(null);
          setLoading(false);
          setError("远程浏览器连接已断开，点击打开即可重建会话");
        });
        const viewport = browserViewportForLayout(layout);
        const result = await client.request<{ session_id?: string }>(
          "browser/start",
          { url: targetUrl, ...viewport },
          30_000,
        );
        if (!result.session_id)
          throw new Error("app-server 未返回 browser session id");
        if (
          generation !== browserGeneration.current ||
          browserClient.current !== client
        ) {
          await client
            .request("browser/close", { session_id: result.session_id })
            .catch(() => {});
          client.close();
          return;
        }
        browserSession.current = result.session_id;
        setSessionId(result.session_id);
        await screenshot(result.session_id);
      } catch (value) {
        if (generation === browserGeneration.current) {
          setError(value instanceof Error ? value.message : String(value));
          setLoading(false);
          browserGeneration.current += 1;
          browserUnsubscribe.current?.();
          browserUnsubscribe.current = null;
          if (browserClient.current === client) browserClient.current = null;
          browserSession.current = null;
          setSessionId(null);
          setFrame(null);
        }
        client?.close();
      } finally {
        if (generation === browserGeneration.current) setLoading(false);
      }
    })();
    browserStartInFlight.current = operation;
    try {
      await operation;
    } finally {
      if (browserStartInFlight.current === operation)
        browserStartInFlight.current = null;
    }
  };

  const action = async (
    actionName: string,
    extra: Record<string, unknown> = {},
    refreshFrame = true,
  ) => {
    if (!sessionId || demo) return;
    const client = browserClient.current;
    if (!client) return;
    await client.request("browser/action", {
      session_id: sessionId,
      action: actionName,
      ...extra,
    });
    if (refreshFrame) await screenshot(sessionId, true);
  };

  const runAction = async (
    actionName: string,
    extra: Record<string, unknown> = {},
    refreshFrame = true,
  ) => {
    try {
      lastBrowserInteraction.current = Date.now();
      await action(actionName, extra, refreshFrame);
      setError(null);
      return true;
    } catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      if (!message.includes("Not attached to an active page"))
        setError(message);
      return false;
    }
  };

  useEffect(() => {
    if (!sessionId || demo || layout.width < 80 || layout.height < 80) return;
    const viewport = browserViewportForLayout(layout);
    if (
      frame &&
      Math.abs(frame.width - viewport.width) < 8 &&
      Math.abs(frame.height - viewport.height) < 8
    )
      return;
    const timer = setTimeout(() => {
      lastBrowserInteraction.current = Date.now();
      void runAction("resize", {
        width: viewport.width,
        height: viewport.height,
      });
    }, 250);
    return () => clearTimeout(timer);
    // runAction is recreated on every render; trigger remote resize only for actual session or layout changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, layout.height, layout.width, sessionId]);

  const remotePoint = (
    event: GestureResponderEvent,
  ): { x: number; y: number } | null => {
    if (!frame || !sessionId || demo) return null;
    const scale = Math.min(
      layout.width / frame.width,
      layout.height / frame.height,
    );
    const displayedWidth = frame.width * scale;
    const displayedHeight = frame.height * scale;
    const offsetX = (layout.width - displayedWidth) / 2;
    const offsetY = (layout.height - displayedHeight) / 2;
    const x = (event.nativeEvent.locationX - offsetX) / scale;
    const y = (event.nativeEvent.locationY - offsetY) / scale;
    return x >= 0 && y >= 0 && x <= frame.width && y <= frame.height
      ? { x, y }
      : null;
  };

  const pointerGrant = (event: GestureResponderEvent) => {
    const point = remotePoint(event);
    if (!point) return;
    dragActive.current = true;
    lastBrowserInteraction.current = Date.now();
    dragStart.current = point;
    dragLastPoint.current = point;
    dragMoved.current = false;
    gestureMode.current = "pending";
  };

  const pointerMove = (event: GestureResponderEvent) => {
    if (!dragActive.current || Date.now() - lastPointerMove.current < 45)
      return;
    const point = remotePoint(event);
    if (!point) return;
    const start = dragStart.current;
    if (!start) return;
    const previous = dragLastPoint.current ?? start;
    if (gestureMode.current === "pending")
      gestureMode.current = classifyBrowserGesture(start, point);
    if (gestureMode.current === "pending") return;
    lastPointerMove.current = Date.now();
    dragLastPoint.current = point;
    if (gestureMode.current === "scroll") {
      const deltaY = browserWheelDelta(previous, point);
      if (!deltaY) return;
      dragMoved.current = true;
      browserActionQueue.current = browserActionQueue.current
        .catch(() => {})
        .then(() =>
          action(
            "wheel",
            {
              x: point.x,
              y: point.y,
              delta_x: 0,
              delta_y: deltaY,
            },
            false,
          ),
        )
        .catch((value) => runActionError(value, setError));
      return;
    }
    const firstMove = !dragMoved.current;
    dragMoved.current = true;
    browserActionQueue.current = browserActionQueue.current
      .catch(() => {})
      .then(async () => {
        if (firstMove) {
          await action("pointer_move", start, false);
          await action("pointer_down", start, false);
        }
        await action("pointer_move", point, false);
      })
      .catch((value) => runActionError(value, setError));
  };

  const pointerRelease = (event: GestureResponderEvent) => {
    const eventPoint = remotePoint(event);
    const point = eventPoint ?? dragLastPoint.current;
    const mode = gestureMode.current;
    dragActive.current = false;
    const moved = dragMoved.current;
    dragStart.current = null;
    dragLastPoint.current = null;
    dragMoved.current = false;
    gestureMode.current = "pending";
    if (!point) return;
    if (!moved || mode === "pending") {
      // Do not interpret cancellation as a click after the finger leaves the screenshot area.
      if (!eventPoint) return;
      browserActionQueue.current = browserActionQueue.current
        .catch(() => {})
        .then(() => action("click", point))
        .catch((value) => runActionError(value, setError));
      return;
    }
    if (mode === "scroll") {
      browserActionQueue.current = browserActionQueue.current
        .catch(() => {})
        .then(() => screenshot(sessionId, true))
        .catch((value) => runActionError(value, setError));
      return;
    }
    browserActionQueue.current = browserActionQueue.current
      .catch(() => {})
      .then(async () => {
        await action("pointer_move", point, false);
        await action("pointer_up", point, false);
        await screenshot(sessionId, true);
      })
      .catch((value) => runActionError(value, setError));
  };

  const pointerCancel = () => {
    const point = dragLastPoint.current ?? dragStart.current;
    const moved = dragMoved.current;
    const mode = gestureMode.current;
    dragActive.current = false;
    dragStart.current = null;
    dragLastPoint.current = null;
    dragMoved.current = false;
    gestureMode.current = "pending";
    // Never click when the system or a multi-touch gesture takes the responder; if pointer_down was sent, always follow with pointer_up.
    if (!point || !moved || mode !== "drag") return;
    browserActionQueue.current = browserActionQueue.current
      .catch(() => {})
      .then(async () => {
        await action("pointer_move", point, false);
        await action("pointer_up", point, false);
      })
      .catch((value) => runActionError(value, setError));
  };

  const sendKeyboardText = async () => {
    const value = keyboardText;
    if (!value || !sessionId || demo) return;
    setKeyboardText("");
    const sent = await runAction("text", { text: value });
    if (!sent) setKeyboardText((current) => current || value);
  };
  const compactControls = layout.width < 700;
  const shortControls = panelLayout.height > 1 && panelLayout.height < 420;
  const scrollControls = (
    <>
      <Pressable
        accessibilityLabel="向上滚动"
        disabled={!sessionId}
        onPress={() =>
          void runAction("wheel", {
            x: Math.round((frame?.width ?? 390) / 2),
            y: Math.round((frame?.height ?? 640) / 2),
            delta_x: 0,
            delta_y: -540,
          })
        }
        style={styles.browserControl}
      >
        <Text style={styles.browserControlText}>上滚</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="向下滚动"
        disabled={!sessionId}
        onPress={() =>
          void runAction("wheel", {
            x: Math.round((frame?.width ?? 390) / 2),
            y: Math.round((frame?.height ?? 640) / 2),
            delta_x: 0,
            delta_y: 540,
          })
        }
        style={styles.browserControl}
      >
        <Text style={styles.browserControlText}>下滚</Text>
      </Pressable>
    </>
  );
  const keyboardControls = (
    <>
      <TextInput
        testID="browser-keyboard-input"
        value={keyboardText}
        onChangeText={setKeyboardText}
        onSubmitEditing={() => void sendKeyboardText()}
        autoCapitalize="none"
        placeholder="向页面输入文字"
        placeholderTextColor={colors.textDim}
        style={[
          styles.browserKeyboardInput,
          shortControls && styles.browserKeyboardInputShort,
        ]}
      />
      <Pressable
        accessibilityLabel="输入"
        disabled={!keyboardText || !sessionId}
        onPress={() => void sendKeyboardText()}
        style={styles.browserControl}
      >
        <Text style={styles.browserControlText}>输入</Text>
      </Pressable>
    </>
  );
  const specialKeyControls = (
    <>
      <Pressable
        accessibilityLabel="全选"
        disabled={!sessionId}
        onPress={() =>
          void runAction("shortcut", { key: "a", modifiers: ["Control"] })
        }
        style={styles.browserControl}
      >
        <Text style={styles.browserControlText}>Ctrl+A</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="退格"
        disabled={!sessionId}
        onPress={() => void runAction("key", { key: "Backspace" })}
        style={styles.browserControl}
      >
        <Text style={styles.browserControlText}>⌫</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Tab"
        disabled={!sessionId}
        onPress={() => void runAction("key", { key: "Tab" })}
        style={styles.browserControl}
      >
        <Text style={styles.browserControlText}>Tab</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Escape"
        disabled={!sessionId}
        onPress={() => void runAction("key", { key: "Escape" })}
        style={styles.browserControl}
      >
        <Text style={styles.browserControlText}>Esc</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="回车"
        disabled={!sessionId}
        onPress={() => void runAction("key", { key: "Enter" })}
        style={styles.browserControl}
      >
        <Text style={styles.browserControlText}>↵</Text>
      </Pressable>
    </>
  );

  return (
    <View
      testID="browser-panel"
      onLayout={(event) => setPanelLayout(event.nativeEvent.layout)}
      style={panelStyles.root}
    >
      <View style={styles.browserBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="后退"
          aria-disabled={!sessionId || frame?.page?.canGoBack !== true}
          disabled={!sessionId || frame?.page?.canGoBack !== true}
          accessibilityState={{
            disabled: !sessionId || frame?.page?.canGoBack !== true,
          }}
          onPress={() => void runAction("back")}
          style={[
            styles.browserIcon,
            (!sessionId || frame?.page?.canGoBack !== true) &&
              styles.controlDisabled,
          ]}
        >
          <ArrowLeft size={17} color={colors.textMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="前进"
          aria-disabled={!sessionId || frame?.page?.canGoForward !== true}
          disabled={!sessionId || frame?.page?.canGoForward !== true}
          accessibilityState={{
            disabled: !sessionId || frame?.page?.canGoForward !== true,
          }}
          onPress={() => void runAction("forward")}
          style={[
            styles.browserIcon,
            (!sessionId || frame?.page?.canGoForward !== true) &&
              styles.controlDisabled,
          ]}
        >
          <ArrowRight size={17} color={colors.textMuted} />
        </Pressable>
        <TextInput
          testID="browser-url-input"
          accessibilityLabel="浏览器地址"
          value={url}
          onChangeText={setUrl}
          onFocus={() => {
            urlEditing.current = true;
          }}
          onBlur={() => {
            urlEditing.current = false;
          }}
          onSubmitEditing={() => {
            urlEditing.current = false;
            void start();
          }}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.urlInput}
        />
        <Pressable
          accessibilityLabel="刷新"
          disabled={!sessionId}
          onPress={() => void runAction("reload")}
          style={styles.browserIcon}
        >
          <RefreshCw size={17} color={colors.textMuted} />
        </Pressable>
        <Pressable
          accessibilityLabel="打开"
          disabled={loading || !url.trim()}
          accessibilityState={{ disabled: loading || !url.trim() }}
          onPress={() => {
            urlEditing.current = false;
            void start();
          }}
          style={[
            styles.go,
            (loading || !url.trim()) && styles.controlDisabled,
          ]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.accentText} />
          ) : (
            <Globe2 size={17} color={colors.accentText} />
          )}
        </Pressable>
      </View>
      <View
        testID="browser-frame"
        onLayout={(event: LayoutChangeEvent) =>
          setLayout(event.nativeEvent.layout)
        }
        onStartShouldSetResponder={() => Boolean(sessionId && frame && !demo)}
        onMoveShouldSetResponder={() => Boolean(sessionId && frame && !demo)}
        onResponderGrant={pointerGrant}
        onResponderMove={pointerMove}
        onResponderRelease={pointerRelease}
        onResponderTerminate={pointerCancel}
        style={styles.frame}
      >
        {frame ? (
          <Image
            resizeMode="contain"
            source={{
              uri: `data:${frame.mime_type};base64,${frame.data_base64}`,
            }}
            style={StyleSheet.absoluteFill}
          />
        ) : sessionId && demo ? (
          <View style={styles.demoBrowser}>
            <Globe2 size={50} color={colors.blue} />
            <Text style={styles.demoBrowserTitle}>KCoder 远程浏览器</Text>
            <Text style={styles.demoBrowserBody}>
              真实连接会在此显示 app-server
              传回的浏览器截图，点击画面会映射到远程坐标。
            </Text>
          </View>
        ) : (
          <EmptyState
            icon={<Globe2 size={48} color={colors.textDim} />}
            title="打开远程网页"
            body="输入 URL 后点击打开。浏览器进程运行在所选 KCoder 服务器上。"
          />
        )}
      </View>
      {shortControls ? (
        <View
          testID="browser-short-controls"
          style={styles.browserControlsShort}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={styles.browserControlsShortContent}
          >
            {scrollControls}
            {keyboardControls}
            {specialKeyControls}
          </ScrollView>
        </View>
      ) : compactControls ? (
        <View style={styles.browserControlsCompact}>
          <View style={styles.browserCompactRow}>{scrollControls}</View>
          <View style={styles.browserCompactRow}>{keyboardControls}</View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              minHeight: 44,
              alignItems: "center",
              gap: 4,
              paddingRight: spacing.xs,
            }}
          >
            {specialKeyControls}
          </ScrollView>
        </View>
      ) : (
        <View style={styles.browserControls}>
          {scrollControls}
          {keyboardControls}
          {specialKeyControls}
        </View>
      )}
      {error ? <Text style={styles.browserError}>{error}</Text> : null}
    </View>
  );
}

interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  size?: number;
}

interface OpenFile {
  path: string;
  parent: string;
  name: string;
  content: string;
  revision: string;
  editable: boolean;
  truncated: boolean;
  size?: number;
  preview?: { kind: "image"; mimeType: string; uri?: string; message?: string };
}

const MAX_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024;
const webEditorNoWrapStyle =
  Platform.OS === "web"
    ? { whiteSpace: "pre" as const, overflow: "scroll" as const }
    : undefined;

export function FilesPanel({
  task,
  demo,
  initialDirectory,
  initialDraft,
  openFileRequest,
  onDirtyChange,
  onDirectoryChange,
  onDraftChange,
}: {
  task: TaskRuntime;
  demo: boolean;
  initialDirectory?: string;
  initialDraft?: WorkspaceFileDraft;
  openFileRequest?: {
    path: string;
    revision: number;
    line?: number;
    column?: number;
  };
  onDirtyChange?(dirty: boolean): void;
  onDirectoryChange?(path: string): void;
  onDraftChange?(draft: WorkspaceFileDraft | undefined): void;
}) {
  const root = task.getSnapshot().cwd;
  const initialDirectoryAtMount = useRef(initialDirectory).current;
  const safeInitialDirectory =
    initialDirectoryAtMount && isWorkspacePath(root, initialDirectoryAtMount)
      ? initialDirectoryAtMount
      : root;
  const [path, setPath] = useState(safeInitialDirectory);
  const [entries, setEntries] = useState<FileEntry[]>(
    demo
      ? [
          {
            name: "apps",
            path: joinWorkspacePath(root, "apps"),
            is_directory: true,
          },
          {
            name: "crates",
            path: joinWorkspacePath(root, "crates"),
            is_directory: true,
          },
          {
            name: "README.md",
            path: joinWorkspacePath(root, "README.md"),
            is_directory: false,
            size: 4280,
          },
        ]
      : [],
  );
  const [file, setFile] = useState<OpenFile | null>(null);
  const [content, setContent] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [editorScrollY, setEditorScrollY] = useState(0);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);
  const [fileConflict, setFileConflict] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const restoredDraftPath = useRef<string | null>(null);
  const lastOpenRequestRevision = useRef<number | null>(null);
  const lastLocatedRequestRevision = useRef<number | null>(null);
  const fileEditorRef = useRef<TextInput>(null);
  const pendingInitialDraft = useRef(initialDraft);
  const initialTreeLoad = useRef<Promise<void> | null>(null);
  const fileOperationGeneration = useRef(0);
  const onDirectoryChangeRef = useRef(onDirectoryChange);
  const onDraftChangeRef = useRef(onDraftChange);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirectoryChangeRef.current = onDirectoryChange;
  onDraftChangeRef.current = onDraftChange;
  onDirtyChangeRef.current = onDirtyChange;
  const dirty = Boolean(
    file && file.editable && !file.truncated && content !== file.content,
  );
  const contentStats = useMemo(() => {
    let lines = 1;
    let cursorLine = 1;
    let lastLineStart = 0;
    const boundedCursor = Math.max(0, Math.min(content.length, cursorOffset));
    for (let index = 0; index < content.length; index += 1) {
      if (content.charCodeAt(index) !== 10) continue;
      lines += 1;
      if (index < boundedCursor) {
        cursorLine += 1;
        lastLineStart = index + 1;
      }
    }
    return {
      lines,
      characters: content.length,
      cursorLine,
      cursorColumn: boundedCursor - lastLineStart + 1,
    };
  }, [content, cursorOffset]);
  const lineNumbers = useMemo(() => {
    const count = Math.min(contentStats.lines, 10_000);
    const numbers = Array.from({ length: count }, (_, index) =>
      String(index + 1),
    ).join("\n");
    return contentStats.lines > count ? `${numbers}\n…` : numbers;
  }, [contentStats.lines]);
  const fileLanguage = useMemo(() => {
    const extension = file?.name.split(".").at(-1)?.toLocaleLowerCase();
    return (
      (
        {
          ts: "TypeScript",
          tsx: "TypeScript JSX",
          js: "JavaScript",
          jsx: "JavaScript JSX",
          rs: "Rust",
          py: "Python",
          go: "Go",
          json: "JSON",
          yaml: "YAML",
          yml: "YAML",
          toml: "TOML",
          md: "Markdown",
          css: "CSS",
          html: "HTML",
          sh: "Shell",
        } as Record<string, string>
      )[extension ?? ""] ?? "Text"
    );
  }, [file?.name]);
  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...entries]
      .filter(
        (entry) => !needle || entry.name.toLocaleLowerCase().includes(needle),
      )
      .sort(
        (left, right) =>
          Number(right.is_directory) - Number(left.is_directory) ||
          left.name.localeCompare(right.name),
      );
  }, [entries, query]);
  const breadcrumbs = useMemo(() => {
    const rootName = root.split("/").filter(Boolean).at(-1) ?? "/";
    const relative = workspaceRelativePath(root, path)
      .split("/")
      .filter(Boolean);
    return [
      { label: rootName, path: root },
      ...relative.map((label, index) => ({
        label,
        path: joinWorkspacePath(root, relative.slice(0, index + 1).join("/")),
      })),
    ];
  }, [path, root]);
  const latestFileDraftRef = useRef<{
    file: OpenFile | null;
    content: string;
    dirty: boolean;
  }>({ file, content, dirty });
  latestFileDraftRef.current = { file, content, dirty };

  useEffect(
    () => () => {
      const latest = latestFileDraftRef.current;
      onDraftChangeRef.current?.(
        latest.file && latest.dirty
          ? {
              path: latest.file.path,
              revision: latest.file.revision,
              content: latest.content,
              updatedAt: Date.now(),
            }
          : undefined,
      );
    },
    [],
  );

  useEffect(
    () => () => {
      fileOperationGeneration.current += 1;
    },
    [],
  );

  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
    return () => onDirtyChangeRef.current?.(false);
  }, [dirty]);

  useEffect(() => {
    if (!file) return;
    const timer = setTimeout(() => {
      onDraftChangeRef.current?.(
        dirty
          ? {
              path: file.path,
              revision: file.revision,
              content,
              updatedAt: Date.now(),
            }
          : undefined,
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [content, dirty, file]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      const latest = latestFileDraftRef.current;
      if (!latest.file) return;
      onDraftChangeRef.current?.(
        latest.dirty
          ? {
              path: latest.file.path,
              revision: latest.file.revision,
              content: latest.content,
              updatedAt: Date.now(),
            }
          : undefined,
      );
    });
    return () => subscription.remove();
  }, []);

  const loadTree = useCallback(
    async (nextPath: string) => {
      const generation = ++fileOperationGeneration.current;
      if (demo) {
        setPath(nextPath);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await task.request<{
          stdout?: unknown;
          stderr?: string;
        }>("device/execute", {
          command_key: "workspace_tree",
          path: nextPath,
          args: [],
          max_output_bytes: 524_288,
        });
        if (generation !== fileOperationGeneration.current) return;
        const stdout = record(result.stdout);
        setEntries(
          Array.isArray(stdout.entries) ? (stdout.entries as FileEntry[]) : [],
        );
        setPath(String(stdout.path ?? nextPath));
        setQuery("");
        onDirectoryChangeRef.current?.(String(stdout.path ?? nextPath));
        setFile(null);
        setFileConflict(false);
      } catch (value) {
        if (generation === fileOperationGeneration.current)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (generation === fileOperationGeneration.current) setLoading(false);
      }
    },
    [demo, task],
  );

  const open = useCallback(
    async (entry: FileEntry): Promise<boolean> => {
      if (entry.is_directory) {
        void loadTree(entry.path);
        return true;
      }
      const generation = ++fileOperationGeneration.current;
      const slash = entry.path.lastIndexOf("/");
      const parent = slash > 0 ? entry.path.slice(0, slash) : root;
      if (demo) {
        const opened = {
          path: entry.path,
          parent,
          name: entry.name,
          content: "# KCoder\n\n这是 Web 演示模式的文件预览。",
          revision: "demo",
          editable: true,
          truncated: false,
        };
        setFile(opened);
        setContent(opened.content);
        setEditorScrollY(0);
        return true;
      }
      setLoading(true);
      setError(null);
      try {
        const imageMimeType = workspaceImageMimeType(entry.name);
        if (imageMimeType) {
          let preview: OpenFile["preview"];
          if (
            entry.size !== undefined &&
            entry.size > MAX_IMAGE_PREVIEW_BYTES
          ) {
            preview = {
              kind: "image",
              mimeType: imageMimeType,
              message: "图片超过 8 MiB，移动端未自动下载预览。",
            };
          } else {
            const chunks: Uint8Array[] = [];
            let offset = 0;
            let tooLarge = false;
            while (true) {
              const chunkResult = await task.request<{ stdout?: unknown }>(
                "device/execute",
                {
                  command_key: "workspace_read_file_chunk",
                  path: parent,
                  args: [entry.name, String(offset)],
                  max_output_bytes: 2 * 1024 * 1024,
                },
              );
              if (generation !== fileOperationGeneration.current) return false;
              const chunk = record(chunkResult.stdout);
              const bytes = toByteArray(String(chunk.content_base64 ?? ""));
              if (offset + bytes.byteLength > MAX_IMAGE_PREVIEW_BYTES) {
                tooLarge = true;
                break;
              }
              chunks.push(bytes);
              offset += bytes.byteLength;
              if (chunk.eof === true) break;
              if (bytes.byteLength === 0)
                throw new Error("图片分块读取没有继续前进");
            }
            if (tooLarge) {
              preview = {
                kind: "image",
                mimeType: imageMimeType,
                message: "图片超过 8 MiB，移动端未自动下载预览。",
              };
            } else {
              const merged = new Uint8Array(offset);
              let cursor = 0;
              for (const chunk of chunks) {
                merged.set(chunk, cursor);
                cursor += chunk.byteLength;
              }
              preview = {
                kind: "image",
                mimeType: imageMimeType,
                uri: `data:${imageMimeType};base64,${fromByteArray(merged)}`,
              };
            }
          }
          const opened: OpenFile = {
            path: entry.path,
            parent,
            name: entry.name,
            content: "",
            revision: "",
            editable: false,
            truncated: false,
            size: entry.size,
            preview,
          };
          setFile(opened);
          setContent("");
          setCursorOffset(0);
          setEditorScrollY(0);
          setFileConflict(false);
          return true;
        }
        const result = await task.request<{ stdout?: unknown }>(
          "device/execute",
          {
            command_key: "workspace_read_text_file",
            path: parent,
            args: [entry.name],
            max_output_bytes: 1_048_576,
          },
        );
        if (generation !== fileOperationGeneration.current) return false;
        const stdout = record(result.stdout);
        const editable = stdout.editable === true;
        const truncated = stdout.truncated === true;
        const rawContent = String(stdout.content ?? "");
        const content =
          editable && !truncated
            ? rawContent
            : `${rawContent.slice(0, 32 * 1024)}${rawContent.length > 32 * 1024 ? "\n\n[只读预览限制为 32 KiB]" : ""}`;
        const opened = {
          path: entry.path,
          parent,
          name: entry.name,
          content,
          revision: String(stdout.revision ?? ""),
          editable,
          truncated,
          size: typeof stdout.size === "number" ? stdout.size : undefined,
        };
        const draft =
          pendingInitialDraft.current?.path === opened.path
            ? pendingInitialDraft.current
            : undefined;
        if (draft) {
          pendingInitialDraft.current = undefined;
          restoredDraftPath.current = draft.path;
        }
        setFile(draft ? { ...opened, revision: draft.revision } : opened);
        setContent(draft?.content ?? opened.content);
        setEditorScrollY(0);
        setFileConflict(false);
        if (draft) {
          setError(
            draft.revision === opened.revision
              ? "已恢复上次未保存的本地草稿。"
              : "服务器文件已变化；已恢复本地草稿，保存时会先检查版本冲突。",
          );
        }
        return true;
      } catch (value) {
        if (generation === fileOperationGeneration.current)
          setError(value instanceof Error ? value.message : String(value));
        return false;
      } finally {
        if (generation === fileOperationGeneration.current) setLoading(false);
      }
    },
    [demo, loadTree, root, task],
  );

  useEffect(() => {
    initialTreeLoad.current = loadTree(safeInitialDirectory);
  }, [loadTree, safeInitialDirectory]);

  useEffect(() => {
    const draft = pendingInitialDraft.current;
    if (!draft || restoredDraftPath.current === draft.path) return;
    if (!isWorkspacePath(root, draft.path)) return;
    let cancelled = false;
    const slash = draft.path.lastIndexOf("/");
    const restore = async () => {
      await initialTreeLoad.current;
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        const opened = await open({
          name: draft.path.slice(slash + 1),
          path: draft.path,
          is_directory: false,
        });
        if (opened) {
          restoredDraftPath.current = draft.path;
          return;
        }
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, 600 * (attempt + 1)),
        );
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [open, root]);

  useEffect(() => {
    if (
      !openFileRequest ||
      lastOpenRequestRevision.current === openFileRequest.revision
    )
      return;
    if (!isWorkspacePath(root, openFileRequest.path)) return;
    lastOpenRequestRevision.current = openFileRequest.revision;
    let cancelled = false;
    const slash = openFileRequest.path.lastIndexOf("/");
    const parent = slash > 0 ? openFileRequest.path.slice(0, slash) : root;
    const openRequestedFile = async () => {
      await initialTreeLoad.current;
      if (cancelled) return;
      await loadTree(parent);
      if (cancelled) return;
      await open({
        name: openFileRequest.path.slice(slash + 1),
        path: openFileRequest.path,
        is_directory: false,
      });
    };
    if (dirty && file && file.path !== openFileRequest.path) {
      requestConfirmation({
        title: `放弃更改并打开 ${openFileRequest.path.slice(slash + 1)}？`,
        message: `${file.name} 还有未保存的修改。继续后将保留持久化草稿，但当前编辑器会切换到目标文件。`,
        confirmLabel: "放弃并打开",
        cancelLabel: "继续编辑",
        destructive: true,
        onConfirm: () => {
          onDraftChangeRef.current?.({
            path: file.path,
            revision: file.revision,
            content,
            updatedAt: Date.now(),
          });
          void openRequestedFile();
        },
      });
    } else {
      void openRequestedFile();
    }
    return () => {
      cancelled = true;
    };
  }, [content, dirty, file, loadTree, open, openFileRequest, root]);

  useEffect(() => {
    if (!file || !openFileRequest?.line || file.path !== openFileRequest.path)
      return;
    if (lastLocatedRequestRevision.current === openFileRequest.revision) return;
    lastLocatedRequestRevision.current = openFileRequest.revision;
    const lines = content.split("\n");
    const lineIndex = Math.max(
      0,
      Math.min(lines.length - 1, openFileRequest.line - 1),
    );
    const columnIndex = Math.max(
      0,
      Math.min(
        lines[lineIndex]?.length ?? 0,
        (openFileRequest.column ?? 1) - 1,
      ),
    );
    const offset =
      lines
        .slice(0, lineIndex)
        .reduce((total, line) => total + line.length + 1, 0) + columnIndex;
    setCursorOffset(offset);
    const frame = requestAnimationFrame(() => {
      const editor = fileEditorRef.current as unknown as {
        focus?(): void;
        setSelectionRange?(start: number, end: number): void;
        setNativeProps?(props: {
          selection: { start: number; end: number };
        }): void;
      } | null;
      if (Platform.OS === "web") {
        editor?.focus?.();
        editor?.setSelectionRange?.(offset, offset);
      } else {
        // File-link navigation should not open the mobile keyboard; enter edit mode only after the user taps the editor.
        editor?.setNativeProps?.({ selection: { start: offset, end: offset } });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [content, file, openFileRequest]);

  const save = async () => {
    if (!file || demo || !file.editable || file.truncated) return;
    const generation = ++fileOperationGeneration.current;
    const savingFile = file;
    const savingContent = content;
    setLoading(true);
    setError(null);
    try {
      const result = await task.request<{ stdout?: unknown }>(
        "device/execute",
        {
          command_key: "workspace_write_text_file",
          path: savingFile.parent,
          args: [savingFile.name, savingFile.revision],
          stdin: savingContent,
          max_output_bytes: 1_048_576,
        },
      );
      if (generation !== fileOperationGeneration.current) return;
      const stdout = record(result.stdout);
      setFile({
        ...savingFile,
        content: savingContent,
        revision: String(stdout.revision ?? savingFile.revision),
      });
      setFileConflict(false);
    } catch (value) {
      if (generation === fileOperationGeneration.current) {
        setFileConflict(isWorkspaceFileConflictError(value));
        setError(value instanceof Error ? value.message : String(value));
      }
    } finally {
      if (generation === fileOperationGeneration.current) setLoading(false);
    }
  };

  const reloadConflictedFile = () => {
    if (!file) return;
    const target = file;
    requestConfirmation({
      title: "重新载入磁盘版本？",
      message: "当前未保存的编辑会被磁盘上的最新内容替换。",
      confirmLabel: "放弃并重新载入",
      cancelLabel: "继续编辑",
      destructive: true,
      onConfirm: () => {
        setFileConflict(false);
        setError(null);
        void open({
          name: target.name,
          path: target.path,
          is_directory: false,
        });
      },
    });
  };

  const overwriteConflictedFile = () => {
    if (!file) return;
    const savingFile = file;
    const savingContent = content;
    requestConfirmation({
      title: "覆盖磁盘上的新版本？",
      message:
        "将先读取最新 revision，再用当前编辑器内容覆盖文件。这个操作无法自动合并其他人的修改。",
      confirmLabel: "确认覆盖",
      cancelLabel: "取消",
      destructive: true,
      onConfirm: () => {
        void (async () => {
          const generation = ++fileOperationGeneration.current;
          setLoading(true);
          setError(null);
          try {
            const latestResult = await task.request<{ stdout?: unknown }>(
              "device/execute",
              {
                command_key: "workspace_read_text_file",
                path: savingFile.parent,
                args: [savingFile.name],
                max_output_bytes: 1_048_576,
              },
            );
            if (generation !== fileOperationGeneration.current) return;
            const latest = record(latestResult.stdout);
            if (latest.editable !== true || latest.truncated === true)
              throw new Error("磁盘上的最新文件已不可安全编辑，不能覆盖");
            const latestRevision = String(latest.revision ?? "");
            const writeResult = await task.request<{ stdout?: unknown }>(
              "device/execute",
              {
                command_key: "workspace_write_text_file",
                path: savingFile.parent,
                args: [savingFile.name, latestRevision],
                stdin: savingContent,
                max_output_bytes: 1_048_576,
              },
            );
            if (generation !== fileOperationGeneration.current) return;
            const written = record(writeResult.stdout);
            setFile({
              ...savingFile,
              content: savingContent,
              revision: String(written.revision ?? latestRevision),
            });
            setFileConflict(false);
            setError(null);
          } catch (value) {
            if (generation === fileOperationGeneration.current) {
              setFileConflict(
                (current) => current || isWorkspaceFileConflictError(value),
              );
              setError(value instanceof Error ? value.message : String(value));
            }
          } finally {
            if (generation === fileOperationGeneration.current)
              setLoading(false);
          }
        })();
      },
    });
  };

  const closeFile = () => {
    if (file && content !== file.content && file.editable && !file.truncated) {
      requestConfirmation({
        title: "放弃未保存的更改？",
        message: file.name,
        confirmLabel: "放弃更改",
        cancelLabel: "继续编辑",
        destructive: true,
        onConfirm: () => {
          fileOperationGeneration.current += 1;
          setLoading(false);
          onDraftChangeRef.current?.(undefined);
          setFile(null);
        },
      });
      return;
    }
    fileOperationGeneration.current += 1;
    setLoading(false);
    setFile(null);
  };

  if (file) {
    const readOnly = Boolean(file.preview) || !file.editable || file.truncated;
    const unchanged = content === file.content;
    return (
      <View testID="files-panel" style={panelStyles.root}>
        <View style={styles.fileHeader}>
          <Pressable
            accessibilityLabel="返回文件树"
            onPress={closeFile}
            style={styles.fileBack}
          >
            <ChevronLeft size={20} color={colors.text} />
          </Pressable>
          <View style={styles.fileTitleCopy}>
            <Text style={styles.fileTitle} numberOfLines={1}>
              {file.name}
              {!unchanged ? " •" : ""}
            </Text>
            <Text style={styles.filePath} numberOfLines={1}>
              {file.path}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="保存"
            disabled={unchanged || demo || readOnly || loading}
            accessibilityState={{
              disabled: unchanged || demo || readOnly || loading,
            }}
            onPress={() => void save()}
            style={styles.fileSave}
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : (
              <Save
                size={18}
                color={
                  unchanged || demo || readOnly ? colors.textDim : colors.blue
                }
              />
            )}
          </Pressable>
        </View>
        {!file.preview && readOnly ? (
          <Text style={styles.readOnlyWarning}>
            {file.truncated
              ? `文件共 ${file.size ?? "?"} 字节，预览已截断，禁止覆盖保存`
              : "此文件类型暂不支持编辑或预览"}
          </Text>
        ) : null}
        {fileConflict ? (
          <View
            testID="file-conflict-banner"
            accessibilityRole="alert"
            style={styles.fileConflict}
          >
            <Text style={styles.fileConflictTitle}>磁盘上的文件已发生变化</Text>
            <Text style={styles.fileConflictBody}>
              {error ?? "请选择保留磁盘版本，或确认用当前草稿覆盖。"}
            </Text>
            <View style={styles.fileConflictActions}>
              <Pressable
                testID="file-conflict-reload"
                disabled={loading}
                onPress={reloadConflictedFile}
                style={styles.fileConflictButton}
              >
                <Text style={styles.fileConflictButtonText}>重新载入</Text>
              </Pressable>
              <Pressable
                testID="file-conflict-overwrite"
                disabled={loading}
                onPress={overwriteConflictedFile}
                style={[
                  styles.fileConflictButton,
                  styles.fileConflictOverwrite,
                ]}
              >
                <Text style={styles.fileConflictOverwriteText}>
                  覆盖磁盘版本
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {file.preview ? (
          <View testID="file-image-preview" style={styles.imagePreview}>
            {file.preview.uri ? (
              <Image
                accessibilityLabel={`预览图片 ${file.name}`}
                resizeMode="contain"
                source={{ uri: file.preview.uri }}
                style={styles.imagePreviewContent}
              />
            ) : (
              <View style={styles.imagePreviewEmpty}>
                <ImageIcon size={42} color={colors.textDim} />
                <Text style={styles.imagePreviewMessage}>
                  {file.preview.message}
                </Text>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.editorShell}>
            <View
              testID="file-line-numbers"
              pointerEvents="none"
              style={styles.lineNumberGutter}
            >
              <Text
                style={[
                  styles.lineNumbers,
                  { transform: [{ translateY: -editorScrollY }] },
                ]}
              >
                {lineNumbers}
              </Text>
            </View>
            <TextInput
              ref={fileEditorRef}
              testID="file-editor"
              accessibilityLabel={`编辑文件 ${file.name}`}
              multiline
              editable={!readOnly && !loading}
              value={content}
              onChangeText={setContent}
              onSelectionChange={(event) =>
                setCursorOffset(event.nativeEvent.selection.start)
              }
              onScroll={(event) => setEditorScrollY(editorScrollOffsetY(event))}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.editor,
                webEditorNoWrapStyle,
                readOnly && styles.editorReadOnly,
              ]}
            />
          </View>
        )}
        {error && !fileConflict ? (
          <Text style={styles.browserError}>{error}</Text>
        ) : null}
        <View style={styles.editorStatus}>
          {file.preview ? (
            <>
              <Text style={styles.editorStatusText}>
                {file.preview.mimeType}
              </Text>
              <Text style={styles.editorStatusText}>
                {file.size !== undefined
                  ? `${Math.max(1, Math.round(file.size / 1024))} KiB`
                  : "图片预览"}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.editorStatusText}>
                {readOnly ? "只读" : unchanged ? "已保存" : "未保存"} · Ln{" "}
                {contentStats.cursorLine}, Col {contentStats.cursorColumn}
              </Text>
              <Text style={styles.editorStatusText}>
                {fileLanguage} · {contentStats.lines} 行 · UTF-8
              </Text>
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <View testID="files-panel" style={panelStyles.root}>
      <View style={styles.filesToolbar}>
        <View style={styles.filesTitle}>
          <Folder size={16} color={colors.textMuted} />
          <Text style={styles.filesTitleText}>Files</Text>
          <Text style={styles.filesCount}>{visibleEntries.length}</Text>
        </View>
        <Pressable
          accessibilityLabel={searchOpen ? "关闭文件搜索" : "搜索文件"}
          onPress={() => {
            setSearchOpen((value) => !value);
            if (searchOpen) setQuery("");
          }}
          style={styles.iconTouch}
        >
          {searchOpen ? (
            <X size={17} color={colors.textMuted} />
          ) : (
            <Search size={17} color={colors.textMuted} />
          )}
        </Pressable>
        <Pressable
          accessibilityLabel="刷新"
          disabled={loading}
          onPress={() => void loadTree(path)}
          style={styles.iconTouch}
        >
          <RefreshCw size={17} color={colors.textMuted} />
        </Pressable>
      </View>
      {searchOpen ? (
        <View style={styles.fileSearchRow}>
          <Search size={15} color={colors.textDim} />
          <TextInput
            testID="file-search"
            value={query}
            onChangeText={setQuery}
            autoFocus
            placeholder="在当前目录筛选…"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.fileSearchInput}
          />
          {query ? (
            <Pressable
              accessibilityLabel="清空搜索"
              onPress={() => setQuery("")}
              style={styles.searchClear}
            >
              <X size={15} color={colors.textDim} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.breadcrumbBar}
        contentContainerStyle={styles.breadcrumbContent}
      >
        {breadcrumbs.map((crumb, index) => (
          <View key={crumb.path} style={styles.breadcrumbItem}>
            {index > 0 ? (
              <Text style={styles.breadcrumbSeparator}>/</Text>
            ) : null}
            <Pressable
              disabled={crumb.path === path}
              onPress={() => void loadTree(crumb.path)}
              style={styles.breadcrumbButton}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.breadcrumbText,
                  crumb.path === path && styles.breadcrumbActive,
                ]}
              >
                {crumb.label}
              </Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
      {loading ? (
        <ActivityIndicator style={styles.fileLoader} color={colors.textMuted} />
      ) : (
        <FlatList
          testID="file-tree-list"
          style={styles.fileList}
          data={visibleEntries}
          keyExtractor={(entry) => entry.path}
          initialNumToRender={18}
          maxToRenderPerBatch={18}
          windowSize={9}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            path !== root ? (
              <Pressable
                accessibilityLabel="返回上级目录"
                onPress={() =>
                  void loadTree(path.slice(0, path.lastIndexOf("/")) || root)
                }
                style={styles.entry}
              >
                <Folder size={19} color={colors.textMuted} />
                <Text style={styles.entryName}>..</Text>
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon={<Folder size={42} color={colors.textDim} />}
              title={query ? "没有匹配文件" : "目录为空"}
              body={
                query
                  ? `当前目录中没有名称包含“${query}”的项目。`
                  : "此目录中没有可显示的文件。"
              }
            />
          }
          renderItem={({ item: entry }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${entry.is_directory ? "目录" : "文件"} ${entry.name}`}
              onPress={() => void open(entry)}
              style={styles.entry}
            >
              {entry.is_directory ? (
                <Folder size={19} color={colors.blue} />
              ) : (
                <File size={19} color={colors.textMuted} />
              )}
              <Text style={styles.entryName} numberOfLines={1}>
                {entry.name}
              </Text>
              {!entry.is_directory && entry.size !== undefined ? (
                <Text style={styles.entrySize}>
                  {Math.max(1, Math.round(entry.size / 1024))} KB
                </Text>
              ) : null}
            </Pressable>
          )}
        />
      )}
      {error ? <Text style={styles.browserError}>{error}</Text> : null}
    </View>
  );
}

const panelStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
});
const styles = StyleSheet.create({
  terminalHeader: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  terminalTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
  },
  terminalRestart: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  connectionDot: { width: 7, height: 7, borderRadius: 7 },
  online: { backgroundColor: colors.green },
  pending: { backgroundColor: colors.yellow },
  terminalSurface: { flex: 1, backgroundColor: "#101114" },
  terminalDom: { flex: 1, backgroundColor: "#101114" },
  terminalError: {
    position: "absolute",
    left: spacing.sm,
    right: spacing.sm,
    bottom: spacing.sm,
    color: colors.red,
    backgroundColor: "rgba(16,17,20,0.92)",
    borderColor: "rgba(251,113,133,0.35)",
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.sm,
    fontSize: 11,
  },
  browserBar: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: spacing.xs,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  browserIcon: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    height: 44,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 12,
  },
  go: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
  },
  frame: {
    flex: 1,
    minHeight: 48,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  demoBrowser: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  demoBrowserTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  demoBrowserBody: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
  },
  browserControls: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  browserControlsCompact: {
    minHeight: 152,
    gap: 4,
    padding: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  browserControlsShort: {
    height: 52,
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  browserControlsShortContent: {
    minHeight: 52,
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.xs,
  },
  browserCompactRow: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  browserControl: {
    minWidth: 44,
    height: 44,
    paddingHorizontal: 7,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
  },
  browserControlText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
  },
  browserKeyboardInput: {
    flex: 1,
    minWidth: 0,
    height: 44,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: 12,
  },
  browserKeyboardInputShort: { width: 172, flexGrow: 0, flexShrink: 0 },
  browserError: {
    color: colors.red,
    fontSize: 12,
    padding: spacing.sm,
    backgroundColor: "rgba(251,113,133,0.1)",
  },
  filesToolbar: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSidebar,
  },
  filesTitle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  filesTitleText: { color: colors.text, fontSize: 13, fontWeight: "700" },
  filesCount: {
    minWidth: 20,
    height: 18,
    paddingHorizontal: 5,
    overflow: "hidden",
    borderRadius: radius.pill,
    color: colors.textDim,
    backgroundColor: colors.surfaceRaised,
    fontSize: 10,
    lineHeight: 18,
    textAlign: "center",
  },
  iconTouch: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  fileSearchRow: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    margin: spacing.sm,
    marginBottom: 0,
    paddingLeft: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  fileSearchInput: {
    flex: 1,
    minWidth: 0,
    height: 46,
    color: colors.text,
    fontSize: 12,
  },
  searchClear: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  breadcrumbBar: {
    flexGrow: 0,
    height: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  breadcrumbContent: { alignItems: "center", paddingHorizontal: spacing.sm },
  breadcrumbItem: { flexDirection: "row", alignItems: "center" },
  breadcrumbSeparator: { color: colors.textDim, fontSize: 12 },
  breadcrumbButton: {
    minHeight: 44,
    maxWidth: 150,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
  breadcrumbText: { color: colors.textDim, fontSize: 11 },
  breadcrumbActive: { color: colors.text, fontWeight: "600" },
  fileList: { flex: 1 },
  fileLoader: { marginTop: spacing.xl },
  entry: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  entryName: { flex: 1, color: colors.text, fontSize: 14 },
  entrySize: { color: colors.textDim, fontSize: 10 },
  fileHeader: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  fileBack: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  fileTitleCopy: { flex: 1 },
  fileTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
  filePath: { color: colors.textDim, fontSize: 10, marginTop: 3 },
  fileSave: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  readOnlyWarning: {
    color: colors.yellow,
    backgroundColor: "rgba(245,158,11,0.10)",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 12,
  },
  editorShell: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    backgroundColor: colors.background,
  },
  lineNumberGutter: {
    width: 46,
    overflow: "hidden",
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
    backgroundColor: colors.surfaceSidebar,
  },
  lineNumbers: {
    paddingTop: spacing.lg,
    paddingRight: spacing.sm,
    color: colors.textDim,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      web: "monospace",
    }),
    fontSize: 10,
    lineHeight: 20,
    textAlign: "right",
  },
  editor: {
    flex: 1,
    minWidth: 0,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    color: colors.text,
    backgroundColor: colors.background,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      web: "monospace",
    }),
    fontSize: 13,
    lineHeight: 20,
    textAlignVertical: "top",
  },
  editorReadOnly: { color: colors.textMuted },
  editorStatus: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceSidebar,
  },
  editorStatusText: { color: colors.textDim, fontSize: 9 },
  imagePreview: {
    flex: 1,
    minHeight: 0,
    padding: spacing.md,
    backgroundColor: "#101211",
  },
  imagePreviewContent: { width: "100%", height: "100%" },
  imagePreviewEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.xl,
  },
  imagePreviewMessage: {
    maxWidth: 280,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
  fileConflict: {
    gap: spacing.sm,
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(198,79,67,0.45)",
    backgroundColor: "rgba(198,79,67,0.12)",
  },
  fileConflictTitle: { color: colors.text, fontSize: 13, fontWeight: "700" },
  fileConflictBody: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  fileConflictActions: { flexDirection: "row", gap: spacing.sm },
  fileConflictButton: {
    minHeight: 44,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
  },
  fileConflictButtonText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
  },
  fileConflictOverwrite: {
    borderColor: "rgba(198,79,67,0.55)",
    backgroundColor: "rgba(198,79,67,0.18)",
  },
  fileConflictOverwriteText: {
    color: "#F18B80",
    fontSize: 12,
    fontWeight: "700",
  },
  controlDisabled: { opacity: 0.4 },
});

function runActionError(
  value: unknown,
  setError: (message: string | null) => void,
): void {
  const message = value instanceof Error ? value.message : String(value);
  if (!message.includes("Not attached to an active page")) setError(message);
}
