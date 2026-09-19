import { Alert, Platform } from "react-native";

export interface ConfirmationOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm(): void;
}

export function requestConfirmation({
  title,
  message,
  confirmLabel,
  cancelLabel = "取消",
  destructive = false,
  onConfirm,
}: ConfirmationOptions): void {
  if (Platform.OS === "web" && typeof globalThis.confirm === "function") {
    if (globalThis.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: cancelLabel, style: "cancel" },
    { text: confirmLabel, style: destructive ? "destructive" : "default", onPress: onConfirm },
  ]);
}
