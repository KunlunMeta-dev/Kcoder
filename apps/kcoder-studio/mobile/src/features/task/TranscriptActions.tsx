import { t } from "@/i18n";
import { useInterfaceVersion } from "@/storage/interface-version";
import { useLocale } from "@/i18n/use-locale";
import { Copy, Link, MoreHorizontal, ThumbsUp, ThumbsDown } from "lucide-react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View, type PressableProps } from "react-native";
import {
  copyAssistantText,
  shareAssistantText,
  supportsAssistantSharing,
  type TranscriptActionResult,
} from "./transcript-actions";
import { useTaskAppearance } from "./taskStyles";
import { TaskMenuSheet } from "./TaskMenu";

function ResponseIconButton({ children, alignEnd, ...props }: Omit<PressableProps, "children"> & { children: ReactNode; alignEnd?: boolean }) {
  const { styles } = useTaskAppearance();
  return <Pressable {...props} style={[styles.messageAction, styles.responseActionTarget, alignEnd && { marginLeft: "auto" }]}>
    <View style={styles.assistantResponseAction}>{children}</View>
  </Pressable>;
}

export function TranscriptActions({ text, onFork }: { text: string; onFork?(): void }) {
  useLocale();
  const version = useInterfaceVersion();
  const iconSize = version === "v3" ? 14 : 16;
  const { styles, colors } = useTaskAppearance();
  const [feedback, setFeedback] = useState<{
    key: string;
    failed: boolean;
    text: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const currentText = useRef(text);
  currentText.current = text;
  const shareAvailable = supportsAssistantSharing();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async (
    action: () => Promise<TranscriptActionResult>,
    successKey: string,
    failureKey: string,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const requestedText = text;
    setPending(true);
    setFeedback(null);
    try {
      const result = await action();
      if (!mounted.current || currentText.current !== requestedText) return;
      if (result === "success")
        setFeedback({ key: successKey, failed: false, text: requestedText });
      else if (result === "failed" || result === "unavailable")
        setFeedback({ key: failureKey, failed: true, text: requestedText });
    } catch {
      if (mounted.current && currentText.current === requestedText)
        setFeedback({ key: failureKey, failed: true, text: requestedText });
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const visibleFeedback = feedback?.text === text ? feedback : null;
  const copy = () => void run(() => copyAssistantText(text), "task.response_copied", "task.response_copy_failed");
  const share = () => void run(
    () => shareAvailable ? shareAssistantText(text, t("task.share_response")) : copyAssistantText(text),
    shareAvailable ? "task.response_shared" : "task.response_copied", shareAvailable ? "task.response_share_failed" : "task.response_copy_failed",
  );

  return (
    <>
    <View testID="assistant-response-actions" style={[styles.messageActions, styles.assistantResponseActions]}>
      {/* TODO: Connect response ratings to a real feedback contract before enabling these controls. */}
      {text ? <>
      {version === "modern" || version === "v3" ? <>
      <ResponseIconButton testID="assistant-response-like" accessibilityRole="button" accessibilityLabel={t("task.response_like")}
        disabled accessibilityState={{ disabled: true }}>
        <ThumbsUp size={iconSize} color={colors.textDim} />
      </ResponseIconButton>
      <ResponseIconButton testID="assistant-response-dislike" accessibilityRole="button" accessibilityLabel={t("task.response_dislike")}
        disabled accessibilityState={{ disabled: true }}>
        <ThumbsDown size={iconSize} color={colors.textDim} />
      </ResponseIconButton>
      </> : null}
      <ResponseIconButton
        testID="assistant-response-copy"
        accessibilityRole="button"
        accessibilityLabel={t("task.copy_response")}
        accessibilityState={{ disabled: pending, busy: pending }}
        disabled={pending}
        onPress={copy}

      >
        <Copy size={iconSize} color={colors.textMuted} />
      </ResponseIconButton>
        <ResponseIconButton
          testID="assistant-response-share"
          accessibilityRole="button"
          accessibilityLabel={t(shareAvailable ? "task.share_response" : "task.copy_for_sharing")}
          accessibilityState={{ disabled: pending, busy: pending }}
          disabled={pending}
          onPress={share}

        >
          <Link size={iconSize} color={colors.textMuted} />
        </ResponseIconButton>
      </> : null}
      <ResponseIconButton testID="assistant-response-more" accessibilityRole="button" accessibilityLabel={t("task.more")}
        onPress={() => setMenuOpen(true)} alignEnd>
        <MoreHorizontal size={16} color={colors.textDim} />
      </ResponseIconButton>
      {visibleFeedback ? (
        <Text
          testID="assistant-response-action-feedback"
          accessibilityRole={visibleFeedback.failed ? "alert" : "text"}
          accessibilityLiveRegion={visibleFeedback.failed ? "assertive" : "polite"}
          style={[
            styles.messageActionFeedback, { flexBasis: "100%" },
            visibleFeedback.failed && { color: colors.red },
          ]}
        >
          {t(visibleFeedback.key)}
        </Text>
      ) : null}
    </View>
    {menuOpen ? <TaskMenuSheet visible onClose={() => setMenuOpen(false)} title={t("task.response_actions")} testID="assistant-response-menu">
      {text ? <Pressable accessibilityRole="button" onPress={() => { setMenuOpen(false); copy(); }} style={styles.taskMenuRow}>
        <Text style={styles.taskMenuText}>{t("task.copy_response")}</Text>
      </Pressable> : null}
      {onFork ? <Pressable testID="message-fork" accessibilityRole="button" onPress={() => { setMenuOpen(false); onFork(); }} style={styles.taskMenuRow}>
        <Text style={styles.taskMenuText}>{t("task.fork_at_turn")}</Text>
      </Pressable> : null}
    </TaskMenuSheet> : null}
    </>
  );
}
