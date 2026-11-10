import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Lightbulb } from "lucide-react-native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useTaskAppearance } from "./taskStyles";
import { TranscriptDisclosureHeader } from "./TranscriptDisclosure";
import { resolveDisclosureExpanded, toggleDisclosureChoice } from "./disclosure-state";
import { getAppPreferencesSnapshot, subscribeAppPreferences } from "@/storage/app-preferences";

export const THINKING_CONTENT_CHUNK_SIZE = 8_000;

export function ThinkingDisclosure({
  content,
  renderContent,
  testID,
}: {
  content: string;
  renderContent(content: string): ReactNode;
  testID: string;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const preferences = useSyncExternalStore(
    subscribeAppPreferences,
    getAppPreferencesSnapshot,
    getAppPreferencesSnapshot,
  );
  const [defaultExpanded] = useState(() => !preferences.thinkingCollapsedByDefault);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [limit, setLimit] = useState(THINKING_CONTENT_CHUNK_SIZE);
  const expanded = resolveDisclosureExpanded(userExpanded, defaultExpanded);

  return (
    <View testID={testID} style={styles.orderedMessageThinking}>
      <TranscriptDisclosureHeader
        testID={`${testID}-toggle`}
        label={t("output.process")}
        expanded={expanded}
        onPress={() => setUserExpanded((value) => toggleDisclosureChoice(value, defaultExpanded))}
        icon={<Lightbulb size={20} color={colors.textMuted} />}
      >
        <Text style={[styles.toolCopy, styles.thinkingTitle]}>
          {t("output.process")}
        </Text>
      </TranscriptDisclosureHeader>
      {expanded ? (
        <ThinkingContent
          testID={testID}
          content={content}
          renderContent={renderContent}
          limit={limit}
          onMore={() => setLimit((value) => value + THINKING_CONTENT_CHUNK_SIZE)}
        />
      ) : null}
    </View>
  );
}

export function ThinkingContent({
  content,
  renderContent,
  testID,
  limit,
  onMore,
}: {
  content: string;
  renderContent(content: string): ReactNode;
  testID: string;
  limit: number;
  onMore(): void;
}) {
  useLocale();
  const { styles } = useTaskAppearance();
  const end = safeThinkingContentEnd(content, limit);

  return (
    <ScrollView
      testID={`${testID}-content`}
      nestedScrollEnabled
      style={styles.thinkingContent}
      contentContainerStyle={{ minWidth: 0 }}
    >
      <View style={{ maxWidth: "100%", minWidth: 0 }}>
        {renderContent(content.slice(0, end))}
      </View>
      {end < content.length ? (
        <Pressable
          testID={`${testID}-more`}
          accessibilityRole="button"
          accessibilityLabel={t("output.more")}
          onPress={onMore}
          style={styles.disclosureHeader}
        >
          <Text style={styles.thinkingPreview}>{t("output.more")}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

export function safeThinkingContentEnd(content: string, limit: number) {
  const end = Math.min(limit, content.length);
  if (end > 0 && isHighSurrogate(content.charCodeAt(end - 1))) return end - 1;
  return end;
}

function isHighSurrogate(codeUnit: number) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
