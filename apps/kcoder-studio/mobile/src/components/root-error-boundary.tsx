import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { AlertTriangle, RotateCcw } from "lucide-react-native";
import { t, type Locale } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

interface State {
  hasError: boolean;
  error: Error;
  retryKey: number;
}

interface BoundaryProps extends React.PropsWithChildren {
  colors: ThemeColors;
  locale: Locale;
  styles: ReturnType<typeof makeStyles>;
}

export function RootErrorBoundary(props: React.PropsWithChildren) {
  const { colors } = useTheme();
  const locale = useLocale();
  const styles = useThemedStyles(makeStyles);
  return <RootErrorBoundaryView colors={colors} locale={locale} styles={styles}>{props.children}</RootErrorBoundaryView>;
}

class RootErrorBoundaryView extends React.Component<BoundaryProps, State> {
  state: State = { hasError: false, error: new Error(""), retryKey: 0 };

  static getDerivedStateFromError(value: unknown): Partial<State> {
    const error = value instanceof Error ? value : new Error(value == null ? "" : String(value));
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
      <View style={this.props.styles.root} accessibilityLanguage={this.props.locale}>
        <View style={this.props.styles.card}>
          <View style={this.props.styles.icon}><AlertTriangle size={30} color={this.props.colors.red} /></View>
          <Text accessibilityRole="header" style={this.props.styles.title}>{t("mobile.root_error.title")}</Text>
          <Text style={this.props.styles.body}>{t("mobile.root_error.body")}</Text>
          <Text selectable style={this.props.styles.detail}>{this.state.error.message || t("mobile.root_error.unknown")}</Text>
          <Pressable accessibilityRole="button" onPress={this.retry} style={this.props.styles.button}><RotateCcw size={18} color={this.props.colors.accentText} /><Text style={this.props.styles.buttonText}>{t("mobile.root_error.retry")}</Text></Pressable>
        </View>
      </View>
    );
  }
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, backgroundColor: colors.background },
  card: { width: "100%", maxWidth: 440, alignItems: "center", gap: spacing.lg, padding: spacing.xl, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surfaceRaised },
  icon: { width: 64, height: 64, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.surfaceHover },
  title: { color: colors.text, fontSize: 20, fontWeight: "700", textAlign: "center" },
  body: { color: colors.textMuted, fontSize: 14, lineHeight: 21, textAlign: "center" },
  detail: { width: "100%", maxHeight: 120, padding: spacing.md, color: colors.red, fontFamily: "monospace", fontSize: 12, borderRadius: radius.md, backgroundColor: colors.surface },
  button: { minWidth: 180, minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.accent },
  buttonText: { color: colors.accentText, fontSize: 15, fontWeight: "700" },
});
