import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { createGatewayRuntimeRecovery, type GatewayRecoveryState } from "./gateway-runtime-recovery";

function foreground(): boolean {
  if (Platform.OS === "web") return (typeof document === "undefined" || document.visibilityState !== "hidden") &&
    (typeof navigator === "undefined" || navigator.onLine !== false);
  return !AppState.currentState || AppState.currentState === "active";
}

/** Page restoration and network recovery share the normal fenced refresh gate. */
export function useGatewayRuntimeRecovery(input: GatewayRecoveryState & {
  owner: string;
  enabled: boolean;
  refresh(): Promise<void>;
}) {
  const latest = useRef(input);
  latest.current = input;
  const active = useRef<ReturnType<typeof createGatewayRuntimeRecovery> | null>(null);
  useEffect(() => {
    if (!input.enabled) return;
    const owner = input.owner;
    const recovery = createGatewayRuntimeRecovery({
      read: () => ({ ...latest.current, blocked: latest.current.blocked || !latest.current.enabled || latest.current.owner !== owner }),
      isForeground: foreground,
      refresh: () => latest.current.refresh(),
    });
    active.current = recovery;
    const application = AppState.addEventListener("change", state => state === "active" ? recovery.wake() : recovery.sleep());
    const wake = () => recovery.wake();
    const sleep = () => recovery.sleep();
    const visibility = () => foreground() ? wake() : sleep();
    const restored = (event: PageTransitionEvent) => { if (event.persisted) wake(); };
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.addEventListener("online", wake);
      window.addEventListener("offline", sleep);
      window.addEventListener("pageshow", restored);
      window.addEventListener("pagehide", sleep);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility);
    }
    recovery.changed();
    return () => {
      recovery.dispose();
      if (active.current === recovery) active.current = null;
      application.remove();
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.removeEventListener("online", wake);
        window.removeEventListener("offline", sleep);
        window.removeEventListener("pageshow", restored);
        window.removeEventListener("pagehide", sleep);
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility);
      }
    };
  }, [input.enabled, input.owner]);
  useEffect(() => { active.current?.changed(); }, [input.failed, input.refreshing, input.blocked]);
}
