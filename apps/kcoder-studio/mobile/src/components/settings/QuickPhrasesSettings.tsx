import { useRef, useState, useSyncExternalStore } from "react";
import { Pencil, Plus, Save, Trash2, X } from "lucide-react-native";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SettingsGroup } from "@/components/settings/settings-layout";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  getAppPreferencesSnapshot,
  getAppPreferencesStorageStatus,
  retryAppPreferencesSave,
  retryHydrateAppPreferences,
  subscribeAppPreferences,
  subscribeAppPreferencesStorageStatus,
  updateAppPreferencesAndWait,
  type QuickPhrase,
} from "@/storage/app-preferences";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

interface PhraseDraft {
  id: string | null;
  title: string;
  content: string;
}

const emptyDraft = (): PhraseDraft => ({ id: null, title: "", content: "" });

export function QuickPhrasesSettings() {
  useLocale();
  const preferences = useSyncExternalStore(
    subscribeAppPreferences,
    getAppPreferencesSnapshot,
    getAppPreferencesSnapshot,
  );
  const storageStatus = useSyncExternalStore(
    subscribeAppPreferencesStorageStatus,
    getAppPreferencesStorageStatus,
    getAppPreferencesStorageStatus,
  );
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState<PhraseDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const savingRef = useRef(false);

  const savePhrases = async (quickPhrases: QuickPhrase[]) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(false);
    try {
      await updateAppPreferencesAndWait({ quickPhrases });
      setDraft(null);
    } catch {
      setSaveError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const editPhrase = (phrase: QuickPhrase) => {
    if (savingRef.current) return;
    setDraft({ id: phrase.id, title: phrase.title, content: phrase.content });
  };

  const saveDraft = () => {
    if (savingRef.current) return;
    if (!draft) return;
    const title = draft.title.trim();
    if (!title || !draft.content.trim()) return;
    const phrase: QuickPhrase = {
      id: draft.id ?? newQuickPhraseId(preferences.quickPhrases),
      title,
      content: draft.content,
    };
    const next = draft.id
      ? preferences.quickPhrases.map((item) => item.id === draft.id ? phrase : item)
      : [...preferences.quickPhrases, phrase];
    void savePhrases(next);
  };

  const deletePhrase = (id: string) => {
    if (savingRef.current) return;
    void savePhrases(preferences.quickPhrases.filter((phrase) => phrase.id !== id));
  };

  const startDraft = () => {
    if (savingRef.current) return;
    setDraft(emptyDraft());
  };

  const updateDraft = (update: Partial<PhraseDraft>) => {
    if (savingRef.current) return;
    setDraft((current) => current ? { ...current, ...update } : current);
  };

  const retryHydration = () => {
    if (savingRef.current) return;
    void retryHydrateAppPreferences();
  };

  const retrySave = () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    void retryAppPreferencesSave()
      .then(() => setSaveError(false))
      .catch(() => setSaveError(true))
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
      });
  };

  return (
    <View testID="quick-phrases-settings" style={styles.root}>
      <SettingsGroup title={t("settings_personalization.quick_phrases_title")} testID="quick-phrase-list">
        {preferences.quickPhrases.length > 0 ? preferences.quickPhrases.map((phrase) => (
          <View key={phrase.id} testID={`quick-phrase-card-${phrase.id}`} style={styles.phraseRow}>
            <View style={styles.phraseCopy}>
              <Text style={styles.phraseTitle}>{phrase.title}</Text>
              <Text numberOfLines={3} style={styles.phraseContent}>{phrase.content}</Text>
            </View>
            <Pressable
              testID={`quick-phrase-edit-${phrase.id}`}
              accessibilityRole="button"
              accessibilityLabel={t("settings_personalization.edit_phrase", { p0: phrase.title })}
              disabled={saving}
              onPress={() => editPhrase(phrase)}
              style={[styles.iconButton, saving && styles.disabled]}
            >
              <Pencil size={18} color={colors.textMuted} />
            </Pressable>
            <Pressable
              testID={`quick-phrase-delete-${phrase.id}`}
              accessibilityRole="button"
              accessibilityLabel={t("settings_personalization.delete_phrase", { p0: phrase.title })}
              disabled={saving}
              onPress={() => deletePhrase(phrase.id)}
              style={[styles.iconButton, saving && styles.disabled]}
            >
              <Trash2 size={18} color={colors.red} />
            </Pressable>
          </View>
        )) : (
          <Text testID="quick-phrases-empty" style={styles.empty}>{t("settings_personalization.quick_phrases_empty")}</Text>
        )}
        <Pressable
          testID="quick-phrase-add"
          accessibilityRole="button"
          disabled={saving}
          onPress={startDraft}
          style={({ pressed }) => [styles.addButton, saving && styles.disabled, pressed && styles.pressed]}
        >
          <Plus size={18} color={colors.accentBright} />
          <Text style={styles.addText}>{t("settings_personalization.add_phrase")}</Text>
        </Pressable>
      </SettingsGroup>

      {draft ? (
        <SettingsGroup title={draft.id ? t("settings_personalization.edit_phrase_title") : t("settings_personalization.new_phrase_title")} testID="quick-phrase-editor">
          <View style={styles.editor}>
            <Text style={styles.fieldLabel}>{t("settings_personalization.phrase_title_label")}</Text>
            <TextInput
              testID="quick-phrase-title-input"
              accessibilityLabel={t("settings_personalization.phrase_title_label")}
              value={draft.title}
              onChangeText={(title) => updateDraft({ title })}
              editable={!saving}
              placeholder={t("settings_personalization.phrase_title_placeholder")}
              placeholderTextColor={colors.textDim}
              maxLength={80}
              style={styles.input}
            />
            <Text style={styles.fieldLabel}>{t("settings_personalization.phrase_content_label")}</Text>
            <TextInput
              testID="quick-phrase-content-input"
              accessibilityLabel={t("settings_personalization.phrase_content_label")}
              value={draft.content}
              onChangeText={(content) => updateDraft({ content })}
              editable={!saving}
              placeholder={t("settings_personalization.phrase_content_placeholder")}
              placeholderTextColor={colors.textDim}
              multiline
              textAlignVertical="top"
              maxLength={20_000}
              style={[styles.input, styles.contentInput]}
            />
            <Text style={styles.editorNote}>{t("settings_personalization.quick_phrase_send_note")}</Text>
            <View style={styles.editorActions}>
              <Pressable
                testID="quick-phrase-cancel"
                accessibilityRole="button"
                disabled={saving}
                onPress={() => setDraft(null)}
                style={[styles.secondaryButton, saving && styles.disabled]}
              >
                <X size={16} color={colors.textMuted} />
                <Text style={styles.secondaryText}>{t("settings_personalization.cancel")}</Text>
              </Pressable>
              <Pressable
                testID="quick-phrase-save"
                accessibilityRole="button"
                disabled={saving || !draft.title.trim() || !draft.content.trim()}
                onPress={saveDraft}
                style={[styles.primaryButton, (saving || !draft.title.trim() || !draft.content.trim()) && styles.disabled]}
              >
                <Save size={16} color={colors.accentText} />
                <Text style={styles.primaryText}>{saving ? t("settings_personalization.saving") : t("settings_personalization.save_phrase")}</Text>
              </Pressable>
            </View>
          </View>
        </SettingsGroup>
      ) : null}

      {storageStatus.hydration === "error" ? (
        <StorageStatusAction
          testID="quick-phrases-hydration-error"
          message={t("settings_personalization.load_error")}
          actionLabel={t("settings_personalization.retry")}
          disabled={saving}
          onPress={retryHydration}
        />
      ) : null}
      {saveError || storageStatus.writeError ? (
        <StorageStatusAction
          testID="quick-phrases-save-error"
          message={t("settings_personalization.save_error")}
          actionLabel={t("settings_personalization.retry")}
          disabled={saving}
          onPress={retrySave}
        />
      ) : null}
    </View>
  );
}

function newQuickPhraseId(current: QuickPhrase[]): string {
  const existing = new Set(current.map((phrase) => phrase.id));
  let candidate = "";
  do {
    candidate = `phrase-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  } while (existing.has(candidate));
  return candidate;
}

function StorageStatusAction({
  testID,
  message,
  actionLabel,
  disabled,
  onPress,
}: {
  testID: string;
  message: string;
  actionLabel: string;
  disabled: boolean;
  onPress(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID={testID} accessibilityRole="alert" style={styles.errorRow}>
      <Text style={styles.errorText}>{message}</Text>
      <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.retryButton, disabled && styles.disabled]}>
        <Text style={styles.retryText}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { gap: spacing.md },
  phraseRow: { minHeight: 88, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  phraseCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
  phraseTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  phraseContent: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  iconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  empty: { padding: spacing.lg, color: colors.textDim, fontSize: 13 },
  addButton: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  addText: { color: colors.accentBright, fontSize: 15, fontWeight: "600" },
  editor: { padding: spacing.md, gap: spacing.sm },
  fieldLabel: { color: colors.textMuted, fontSize: 13, fontWeight: "500" },
  input: { minHeight: 44, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md, color: colors.text, backgroundColor: colors.background, fontSize: 15 },
  contentInput: { minHeight: 128, lineHeight: 21 },
  editorNote: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  editorActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.xs },
  secondaryButton: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md },
  secondaryText: { color: colors.textMuted, fontSize: 14 },
  primaryButton: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.accent },
  primaryText: { color: colors.accentText, fontSize: 14, fontWeight: "600" },
  errorRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md, borderRadius: 12, backgroundColor: colors.settingsGroupBackground },
  errorText: { flex: 1, color: colors.red, fontSize: 13 },
  retryButton: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  retryText: { color: colors.accentBright, fontSize: 14, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.72 },
});

export default QuickPhrasesSettings;
