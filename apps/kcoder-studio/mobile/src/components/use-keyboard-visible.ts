import { useEffect, useState } from "react";
import { Keyboard } from "react-native";

export function composerBottomPadding(platform: string, visible: boolean, bottomInset: number, minimum: number): number {
  return platform === "android" && visible ? minimum : Math.max(bottomInset, minimum);
}

/** IME owns the bottom edge while visible; navigation safe-area padding must not stack. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(() => Keyboard.isVisible?.() ?? false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return visible;
}
