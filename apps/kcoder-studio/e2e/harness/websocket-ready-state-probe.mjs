// This function is evaluated in Chromium. Keep it self-contained so callers can
// install the probe either after navigation or as an init script when diagnosing
// constructor replacement.
export function installWebSocketReadyStateProbeInPage() {
  const probeKey = "__kcoderE2eWebSocketReadyStateProbe";
  const originalConstructor = window.WebSocket;
  const originalReadyStateGetter = Object.getOwnPropertyDescriptor(
    originalConstructor.prototype,
    "readyState",
  )?.get;

  const probe = {
    installed: true,
    originalConstructor,
    originalReadyStateGetter,
    wrappedConstructor: null,
    runtimeSockets: [],
    targetPrompt: null,
    targetTurnStartSendInvocations: 0,
    totalReadyStateReads: 0,
    applicationForcedClosedReadyStateReads: 0,
    diagnosticForcedClosedReadyStateReads: 0,
    diagnosticSampling: false,
    forceClosed: false,
    stateReadSources: new WeakMap(),
  };

  const wrappedConstructor = new Proxy(originalConstructor, {
    construct(target, args) {
      const socket = Reflect.construct(target, args, target);
      let isRuntimeRpc = false;
      try {
        const url = new URL(String(args[0]), window.location.href);
        isRuntimeRpc =
          url.pathname.endsWith("/rpc") &&
          url.searchParams.get("channel") === "runtime";
      } catch {
        isRuntimeRpc = false;
      }

      if (isRuntimeRpc) {
        probe.runtimeSockets.push(socket);
        const ownReadyState = Object.getOwnPropertyDescriptor(
          socket,
          "readyState",
        );
        let readUnforcedReadyState;
        let stateReadSource;
        if (originalReadyStateGetter) {
          readUnforcedReadyState = () =>
            originalReadyStateGetter.call(socket);
          stateReadSource = "prototype-getter";
          Object.defineProperty(socket, "readyState", {
            configurable: true,
            get() {
              probe.totalReadyStateReads += 1;
              if (probe.forceClosed) {
                if (probe.diagnosticSampling) {
                  probe.diagnosticForcedClosedReadyStateReads += 1;
                } else {
                  probe.applicationForcedClosedReadyStateReads += 1;
                }
                return target.CLOSED;
              }
              return readUnforcedReadyState();
            },
          });
        } else if (
          ownReadyState &&
          Object.hasOwn(ownReadyState, "value") &&
          ownReadyState.configurable
        ) {
          let unforcedReadyState = ownReadyState.value;
          readUnforcedReadyState = () => unforcedReadyState;
          stateReadSource = "routed-instance-data-property";
          Object.defineProperty(socket, "readyState", {
            configurable: true,
            enumerable: ownReadyState.enumerable,
            get() {
              probe.totalReadyStateReads += 1;
              if (probe.forceClosed) {
                if (probe.diagnosticSampling) {
                  probe.diagnosticForcedClosedReadyStateReads += 1;
                } else {
                  probe.applicationForcedClosedReadyStateReads += 1;
                }
                return target.CLOSED;
              }
              return unforcedReadyState;
            },
            set(value) {
              unforcedReadyState = value;
            },
          });
        } else {
          throw new Error(
            "captured runtime WebSocket has no supported readyState source",
          );
        }
        probe.stateReadSources.set(socket, {
          source: stateReadSource,
          readUnforcedReadyState,
        });
        const originalSend = socket.send;
        Object.defineProperty(socket, "send", {
          configurable: true,
          writable: true,
          value(data) {
            try {
              const message = JSON.parse(String(data));
              const input = JSON.stringify(message.params?.input ?? []);
              if (
                message.method === "turn/start" &&
                typeof probe.targetPrompt === "string" &&
                input.includes(probe.targetPrompt)
              ) {
                probe.targetTurnStartSendInvocations += 1;
              }
            } catch {
              // Retain only counts for a prompt-matched turn/start frame.
            }
            return originalSend.call(socket, data);
          },
        });
      }
      return socket;
    },
  });

  probe.wrappedConstructor = wrappedConstructor;
  Object.defineProperty(window, probeKey, {
    value: probe,
    configurable: false,
  });
  window.WebSocket = wrappedConstructor;
}

export async function installWebSocketReadyStateProbe(page) {
  await page.evaluate(installWebSocketReadyStateProbeInPage);
  return readWebSocketReadyStateProbe(page);
}

export async function configureWebSocketReadyStateProbe(
  page,
  { targetPrompt, forceClosed, resetTargetSendCount = false } = {},
) {
  return page.evaluate(
    ({ targetPrompt: nextPrompt, forceClosed: nextForceClosed, resetTargetSendCount: resetSendCount }) => {
      const probe = window["__kcoderE2eWebSocketReadyStateProbe"];
      if (!probe?.installed) {
        throw new Error("page-owned readyState probe is unavailable");
      }
      if (typeof nextPrompt === "string") probe.targetPrompt = nextPrompt;
      if (typeof nextForceClosed === "boolean") {
        probe.forceClosed = nextForceClosed;
      }
      if (resetSendCount) {
        probe.targetTurnStartSendInvocations = 0;
      }
      return {
        installed: probe.installed,
        forceClosed: probe.forceClosed,
        targetPromptConfigured: typeof probe.targetPrompt === "string",
      };
    },
    { targetPrompt, forceClosed, resetTargetSendCount },
  );
}

export async function readWebSocketReadyStateProbe(page) {
  return page.evaluate(() => {
    const probe = window["__kcoderE2eWebSocketReadyStateProbe"];
    if (!probe?.installed) {
      throw new Error("page-owned readyState probe is unavailable");
    }
    probe.diagnosticSampling = true;
    try {
      const sockets = probe.runtimeSockets.map((socket, index) => ({
        index,
        unforcedReadyState: probe.stateReadSources
          .get(socket)
          .readUnforcedReadyState(),
        unforcedStateSource: probe.stateReadSources.get(socket).source,
        effectiveReadyState: socket.readyState,
      }));
      return {
        boundary:
          "unforced and effective state describe the same browser-facing application WebSocket object; for Playwright-routed sockets the unforced state is the mock instance property, not an upstream or physical socket state",
        windowConstructorMatchesWrapper: window.WebSocket === probe.wrappedConstructor,
        windowConstructorMatchesOriginal: window.WebSocket === probe.originalConstructor,
        runtimeSocketCount: probe.runtimeSockets.length,
        sockets,
        unforcedReadyStates: sockets.map((socket) => socket.unforcedReadyState),
        effectiveReadyStates: sockets.map((socket) => socket.effectiveReadyState),
        totalReadyStateReads: probe.totalReadyStateReads,
        applicationForcedClosedReadyStateReads:
          probe.applicationForcedClosedReadyStateReads,
        diagnosticForcedClosedReadyStateReads:
          probe.diagnosticForcedClosedReadyStateReads,
        forceClosed: probe.forceClosed,
        targetPromptConfigured: typeof probe.targetPrompt === "string",
        targetTurnStartSendInvocations: probe.targetTurnStartSendInvocations,
      };
    } finally {
      probe.diagnosticSampling = false;
    }
  });
}
