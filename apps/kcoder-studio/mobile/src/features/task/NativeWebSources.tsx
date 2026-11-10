import { TranscriptDisclosureHeader } from "./TranscriptDisclosure";
import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { ChevronLeft, ChevronRight, Globe } from "lucide-react-native";
import { formatWebSourceRetrievedAt, type WebSourcesV1 } from "../../../../shared/webSources";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useTaskAppearance } from "./taskStyles";

export function NativeWebSources({ receipt }: { receipt: WebSourcesV1 }) {
  const locale = useLocale();
  const { styles, colors } = useTaskAppearance();
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(receipt.sources.length > 0 && receipt.sources.length <= 3);
  const attempts = receipt.attempts ?? [];
  const terminal = ["success", "partial", "empty", "failed", "cancelled"].includes(receipt.status);
  const switched = terminal && receipt.operation === "search" && attempts.length > 1;
  const pages = Math.ceil(receipt.sources.length / 10);
  const current = Math.min(page, Math.max(0, pages - 1));
  return (
    <View testID="native-web-sources" style={styles.toolDetails}>
      <TranscriptDisclosureHeader
        testID={`native-sources-toggle-${receipt.toolCallId}`}
        label={`${t(`web_sources.${receipt.operation}`)} · ${t(`web_sources.${receipt.status}`)}${switched ? ` · ${t("web_sources.switched")}` : ""}`}
        expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        icon={<Globe size={20} color={colors.textMuted} />}
      >
        <View style={styles.toolCopy}>
          <Text style={styles.toolName}>
            {t(`web_sources.${receipt.operation}`)} ·{" "}
            {t(`web_sources.${receipt.status}`)}
            {receipt.sources.length ? ` (${receipt.sources.length})` : ""}
          </Text>
          {switched ? (
            <Text testID="native-source-switch" style={styles.timelineDetail}>
              {t("web_sources.switched")}
            </Text>
          ) : null}
        </View>
      </TranscriptDisclosureHeader>
      {expanded ? (
        <View>
          {switched ? (
            <View testID="native-source-attempts" style={styles.sourceAttemptList}>
              <Text style={styles.timelineDetail}>{t("web_sources.attempts")}</Text>
              {attempts.map((attempt, index) => (
                <Text
                  key={`${index}-${attempt.provider}`}
                  testID="native-source-attempt"
                  style={styles.timelineDetail}
                >
                  {attempt.provider} · {t(`web_sources.${attempt.status}`)}
                </Text>
              ))}
            </View>
          ) : null}
          {receipt.provider ? (
            <Text style={styles.timelineDetail}>{receipt.provider}</Text>
          ) : null}
          {receipt.sources
            .slice(current * 10, current * 10 + 10)
            .map((source) => (
              <View key={source.sourceId}>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={source.title || source.url}
                  onPress={() => {
                    void Linking.openURL(source.url).catch(() => {});
                  }}
                  style={styles.errorDetailsButton}
                >
                  <Text style={styles.toolName}>
                    {source.title || source.url}
                  </Text>
                </Pressable>
                <Text selectable style={styles.timelineDetail}>
                  {source.url}
                </Text>
                <Text style={styles.timelineDetail}>
                  {t(`web_sources.read_${source.readStatus}`)}
                  {source.cacheHit ? ` · ${t("web_sources.cached")}` : ""}
                </Text>
                {source.author ? (
                  <Text style={styles.timelineDetail}>{source.author}</Text>
                ) : null}
                {source.publishedAt ? (
                  <Text style={styles.timelineDetail}>
                    {t("web_sources.published")} {source.publishedAt}
                  </Text>
                ) : null}
                <Text style={styles.timelineDetail} accessibilityHint={source.retrievedAt}>
                  {t("web_sources.retrieved")} {formatWebSourceRetrievedAt(source.retrievedAt, locale)}
                </Text>
              </View>
            ))}
          {receipt.failure ? (
            <Text style={styles.timelineDetail}>
              {t("web_sources.unavailable")}
            </Text>
          ) : null}
          {pages > 1 ? (
            <View style={styles.timelineHeader}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("web_sources.previous")}
                disabled={current === 0}
                onPress={() => setPage((value) => value - 1)}
                style={styles.errorDetailsButton}
              >
                <ChevronLeft size={20} color={colors.textMuted} />
              </Pressable>
              <Text style={styles.timelineDetail}>
                {current + 1} / {pages}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("web_sources.next")}
                disabled={current + 1 === pages}
                onPress={() => setPage((value) => value + 1)}
                style={styles.errorDetailsButton}
              >
                <ChevronRight size={20} color={colors.textMuted} />
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
