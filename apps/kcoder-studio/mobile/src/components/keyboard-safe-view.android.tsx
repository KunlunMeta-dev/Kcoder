import { useEffect, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, View, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { requireNativeViewManager } from "expo-modules-core";
import { reduceKeyboardGeometry, type KeyboardGeometry, type KeyboardGeometryState } from "./keyboard-geometry-state";

type GeometryProps = ViewProps & { legacyKeyboardVisible: boolean | null; keyboardEpoch: number; onGeometryChange(event: NativeSyntheticEvent<KeyboardGeometry>): void };
const NativeKeyboardGeometry = requireNativeViewManager<GeometryProps>("KCoderKeyboardGeometry");

/** Android native geometry applies only to the Activity; dialogs retain their own KAV. */
export function KeyboardSafeView({ scope = "activity", children, ...props }: ViewProps & { scope?: "activity" | "modal" }) {
  const [overlap, setOverlap] = useState(0);
  const [keyboard, setKeyboard] = useState<{ visible: boolean | null; epoch: number }>(() => {
    const metrics = Keyboard.metrics?.();
    return { visible: metrics ? metrics.height > 0 : Keyboard.isVisible?.() ? true : null, epoch: 0 };
  });
  const keyboardRef = useRef(keyboard);
  const mounted = useRef(true);
  const geometry = useRef<KeyboardGeometryState>({ generation: 0, sequence: 0, overlap: 0 });
  useEffect(() => {
    mounted.current = true;
    const transition = (visible: boolean) => {
      if (!mounted.current) return;
      const next = { visible, epoch: keyboardRef.current.epoch + 1 };
      keyboardRef.current = next;
      if (!visible) setOverlap(0);
      setKeyboard(next);
    };
    const show = Keyboard.addListener("keyboardDidShow", () => transition(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => transition(false));
    return () => { mounted.current = false; show.remove(); hide.remove(); };
  }, []);
  if (scope === "modal") return <KeyboardAvoidingView {...props} behavior="padding" enabled={keyboard.visible !== false} keyboardVerticalOffset={0}>{children}</KeyboardAvoidingView>;
  return <NativeKeyboardGeometry {...props} legacyKeyboardVisible={keyboard.visible} keyboardEpoch={keyboard.epoch}
    onGeometryChange={({ nativeEvent }) => {
      if (!mounted.current || nativeEvent.keyboardEpoch !== keyboardRef.current.epoch ||
        (keyboardRef.current.visible === false && nativeEvent.imeVisible === true)) return;
      const next = reduceKeyboardGeometry(geometry.current, nativeEvent);
      if (next === geometry.current) return;
      geometry.current = next;
      setOverlap(next.overlap);
    }}>
    <View testID="keyboard-safe-content" style={{ flex: 1, paddingBottom: overlap }}>{children}</View>
  </NativeKeyboardGeometry>;
}
