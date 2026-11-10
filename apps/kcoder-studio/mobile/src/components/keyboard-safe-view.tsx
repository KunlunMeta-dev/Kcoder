import { KeyboardAvoidingView, Platform, View, type ViewProps } from "react-native";

/** iOS/Web implementation; Metro resolves Android's native adapter from .android.tsx. */
export function KeyboardSafeView({ scope: _scope, ...props }: ViewProps & { scope?: "activity" | "modal" }) {
  if (Platform.OS === "android") return <View {...props} />;
  return <KeyboardAvoidingView {...props}
    behavior={Platform.OS === "ios" ? "padding" : undefined}
    keyboardVerticalOffset={0} />;
}
