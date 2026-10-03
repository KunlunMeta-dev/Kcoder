import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { AlertTriangle, RotateCcw } from "lucide-react-native";
import { colors, radius, spacing } from "@/theme";

interface State {
  hasError: boolean;
  error: Error;
  retryKey: number;
}

export class RootErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { hasError: false, error: new Error("未知渲染错误"), retryKey: 0 };

  static getDerivedStateFromError(value: unknown): Partial<State> {
    const error = value instanceof Error ? value : new Error(value == null ? "未知渲染错误" : String(value));
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[KCoder Studio] 页面渲染失败", error, info.componentStack);
  }

  private retry = () => {
    if (Platform.OS === "web" && typeof globalThis.location?.reload === "function") {
      globalThis.location.reload();
      return;
    }
    this.setState((current) => ({ hasError: false, retryKey: current.retryKey + 1 }));
  };

  render() {
    if (!this.state.hasError) return <React.Fragment key={this.state.retryKey}>{this.props.children}</React.Fragment>;
    return (
      <View style={styles.root}>
        <View style={styles.card}>
          <View style={styles.icon}><AlertTriangle size={30} color={colors.red} /></View>
          <Text accessibilityRole="header" style={styles.title}>KCoder Studio 遇到问题</Text>
          <Text style={styles.body}>任务和远端进程仍在服务器运行。可以重新加载客户端后继续。</Text>
          <Text selectable style={styles.detail}>{this.state.error.message || "未知渲染错误"}</Text>
          <Pressable accessibilityRole="button" onPress={this.retry} style={styles.button}><RotateCcw size={18} color={colors.accentText} /><Text style={styles.buttonText}>重新加载</Text></Pressable>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, backgroundColor: colors.background },
  card: { width: "100%", maxWidth: 440, alignItems: "center", gap: spacing.lg, padding: spacing.xl, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surfaceRaised },
  icon: { width: 64, height: 64, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: "rgba(251,113,133,0.1)" },
  title: { color: colors.text, fontSize: 20, fontWeight: "700", textAlign: "center" },
  body: { color: colors.textMuted, fontSize: 14, lineHeight: 21, textAlign: "center" },
  detail: { width: "100%", maxHeight: 120, padding: spacing.md, color: colors.red, fontFamily: "monospace", fontSize: 12, borderRadius: radius.md, backgroundColor: colors.surface },
  button: { minWidth: 180, minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.accent },
  buttonText: { color: colors.accentText, fontSize: 15, fontWeight: "700" },
});
