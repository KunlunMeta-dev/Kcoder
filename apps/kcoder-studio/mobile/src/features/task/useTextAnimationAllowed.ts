import { useEffect, useState } from "react";
import { AccessibilityInfo, AppState, Platform } from "react-native";

function webAllowed(): boolean {
  return typeof document !== "undefined" && document.visibilityState !== "hidden" &&
    !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** Subscribe once per transcript, rather than once per historical message. */
export function useTextAnimationAllowed(): boolean {
  const [allowed, setAllowed] = useState(() => Platform.OS === "web" && webAllowed());
  useEffect(() => {
    if (Platform.OS === "web") {
      if (typeof document === "undefined") return;
      const media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
      const update = () => setAllowed(webAllowed());
      document.addEventListener("visibilitychange", update);
      media?.addEventListener("change", update);
      update();
      return () => { document.removeEventListener("visibilitychange", update); media?.removeEventListener("change", update); };
    }
    let mounted = true, reduced = true, motionChanged = false, active = AppState.currentState === "active";
    const update = () => { if (mounted) setAllowed(active && !reduced); };
    const application = AppState.addEventListener("change", state => { active = state === "active"; update(); });
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", value => { motionChanged = true; reduced = value; update(); });
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (!motionChanged) reduced = value; update(); }).catch(() => { if (!motionChanged) reduced = true; update(); });
    return () => { mounted = false; application.remove(); motion.remove(); };
  }, []);
  return allowed;
}
