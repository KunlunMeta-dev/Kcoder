import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Check, ChevronLeft, Plus, Server } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Field } from "@/components/ui";
import { deleteServer, saveServer, testServer } from "@/gateway/http";
import { taskRuntimeRegistry } from "@/runtime/task-runtime";
import type { KCoderServer, KCoderServerDraft } from "@/gateway/types";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { requestConfirmation } from "@/platform/confirmation";
import { backOrReplace } from "@/navigation/back-or-replace";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";

function emptyDraft(): KCoderServerDraft {
  return {
    id: "",
    label: "",
    runtime: "kcoder",
    transport: "ssh",
    host: "",
    command: "kcoder",
    workspace: "/",
    acceptNewHostKey: false,
  };
}

function fromServer(server: KCoderServer): KCoderServerDraft {
  return {
    id: server.id,
    label: server.label,
    description: server.description,
    runtime: "kcoder",
    transport: "ssh",
    host: server.host ?? "",
    user: server.user,
    port: server.port,
    command: server.command ?? "kcoder",
    workspace: server.workspacePath ?? "/",
    profile: server.profile,
    settingsFile: server.settingsFile,
    chromiumBin: server.chromiumBin,
    chromiumNoSandbox: server.chromiumNoSandbox ?? false,
    acceptNewHostKey: server.acceptNewHostKey ?? false,
  };
}

function connectionError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  if (/timed? out|timeout/i.test(message))
    return t("server_editor.ssh_timeout", { detail: message });
  if (/permission denied|authentication/i.test(message))
    return t("server_editor.ssh_authentication_failed", { detail: message });
  if (/host key|known_hosts/i.test(message))
    return t("server_editor.ssh_host_key_failed", { detail: message });
  if (/not found|no such file|command/i.test(message))
    return t("server_editor.remote_command_missing", { detail: message });
  if (/resolve|name or service|enotfound/i.test(message))
    return t("server_editor.ssh_host_unresolved", { detail: message });
  return t("server_editor.connection_failed", { detail: message });
}

function draftSignature(draft: KCoderServerDraft): string {
  return JSON.stringify({
    id: draft.id,
    label: draft.label,
    description: draft.description ?? "",
    host: draft.host,
    user: draft.user ?? "",
    port: draft.port ?? 22,
    command: draft.command ?? "kcoder",
    workspace: draft.workspace ?? "/",
    profile: draft.profile ?? "",
    settingsFile: draft.settingsFile ?? "",
    chromiumBin: draft.chromiumBin ?? "",
    chromiumNoSandbox: Boolean(draft.chromiumNoSandbox),
    acceptNewHostKey: Boolean(draft.acceptNewHostKey),
  });
}

export default function ServerEditorRoute() {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { serverId } = useLocalSearchParams<{ serverId?: string }>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { activeProfile, runtime, refresh } = useApp();
  const sshServers = runtime.servers.filter(
    (server) => server.transport === "ssh",
  );
  const preferredServer =
    sshServers.find((server) => server.id === serverId) ?? sshServers[0];
  const activeProfileId = activeProfile?.id ?? null;
  const [draft, setDraft] = useState<KCoderServerDraft>(emptyDraft);
  const [baseline, setBaseline] = useState<KCoderServerDraft>(emptyDraft);
  const [editingExisting, setEditingExisting] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsSuccess, setMessageIsSuccess] = useState(false);
  const loadedProfileRef = useRef<string | null>(null);
  const activeProfileIdRef = useRef(activeProfileId);
  const editorRevisionRef = useRef(0);
  const initializedRef = useRef(false);
  const observedLoadingRef = useRef(false);
  const dirty = draftSignature(draft) !== draftSignature(baseline);
  const canUseServerEditor =
    Boolean(activeProfileId) &&
    loadedProfileRef.current === activeProfileId &&
    editorReady &&
    !runtime.loading &&
    !runtime.error;
  const canUseServerEditorRef = useRef(canUseServerEditor);
  const renderEditorRevision = editorRevisionRef.current;
  useLayoutEffect(() => {
    if (activeProfileIdRef.current !== activeProfileId) {
      activeProfileIdRef.current = activeProfileId;
      editorRevisionRef.current += 1;
    }
    canUseServerEditorRef.current = canUseServerEditor;
  }, [activeProfileId, canUseServerEditor]);
  const editorUnavailable = !canUseServerEditor || busy;

  const showDraft = (next: KCoderServerDraft, existing: boolean) => {
    editorRevisionRef.current += 1;
    setDraft(next);
    setBaseline(next);
    setEditingExisting(existing);
    setMessage(null);
    setMessageIsSuccess(false);
  };

  const confirmDiscard = (onConfirm: () => void, leaving = false) => {
    const detail = t("server_editor.unsaved_changes_body");
    if (Platform.OS === "web" && typeof globalThis.confirm === "function") {
      if (globalThis.confirm(`${t("server_editor.unsaved_changes_title")}\n\n${detail}`)) onConfirm();
      return;
    }
    Alert.alert(t("server_editor.unsaved_changes_title"), detail, [
      { text: t("server_editor.continue_editing"), style: "cancel" },
      {
        text: leaving ? t("server_editor.discard_and_leave") : t("server_editor.discard_changes"),
        style: "destructive",
        onPress: onConfirm,
      },
    ]);
  };

  const changeSelection = (next: KCoderServerDraft, existing: boolean) => {
    const profileIdAtPrompt = activeProfileId;
    const revisionAtPrompt = editorRevisionRef.current;
    if (
      !canUseServerEditorRef.current ||
      activeProfileIdRef.current !== profileIdAtPrompt
    )
      return;
    if (!dirty) {
      showDraft(next, existing);
      return;
    }
    confirmDiscard(() => {
      if (
        canUseServerEditorRef.current &&
        activeProfileIdRef.current === profileIdAtPrompt &&
        editorRevisionRef.current === revisionAtPrompt
      )
        showDraft(next, existing);
    });
  };

  usePreventRemove(dirty, ({ data }) => {
    const profileIdAtPrompt = activeProfileId;
    const revisionAtPrompt = renderEditorRevision;
    confirmDiscard(() => {
      if (
        activeProfileIdRef.current === profileIdAtPrompt &&
        editorRevisionRef.current === revisionAtPrompt
      )
        navigation.dispatch(data.action);
    }, true);
  });

  useEffect(() => {
    if (Platform.OS !== "web" || !dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", beforeUnload);
    return () => globalThis.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  useEffect(() => {
    const profileId = activeProfile?.id ?? null;
    if (loadedProfileRef.current !== profileId) {
      loadedProfileRef.current = profileId;
      initializedRef.current = false;
      observedLoadingRef.current = false;
      setEditorReady(false);
      showDraft(emptyDraft(), false);
      if (profileId && runtime.loading) observedLoadingRef.current = true;
      else if (profileId && !runtime.error && runtime.servers.length > 0) {
        initializedRef.current = true;
        showDraft(
          preferredServer ? fromServer(preferredServer) : emptyDraft(),
          Boolean(preferredServer),
        );
        setEditorReady(true);
      }
      return;
    }
    if (!profileId) return;
    if (runtime.loading) {
      observedLoadingRef.current = true;
      return;
    }
    if (
      !initializedRef.current &&
      !runtime.error &&
      (observedLoadingRef.current ||
        runtime.servers.length > 0)
    ) {
      initializedRef.current = true;
      // Even with programmatic input on a very slow gateway, late initialization must never overwrite a user draft.
      if (!dirty)
        showDraft(
          preferredServer ? fromServer(preferredServer) : emptyDraft(),
          Boolean(preferredServer),
        );
      setEditorReady(true);
      return;
    }
    if (
      initializedRef.current &&
      editingExisting &&
      !runtime.error &&
      !dirty &&
      !sshServers.some((server) => server.id === draft.id)
    ) {
      showDraft(
        preferredServer ? fromServer(preferredServer) : emptyDraft(),
        Boolean(preferredServer),
      );
    }
  }, [
    activeProfile?.id,
    dirty,
    draft.id,
    editingExisting,
    preferredServer?.id,
    runtime.error,
    runtime.loading,
    runtime.servers,
    serverId,
  ]);

  const update = <K extends keyof KCoderServerDraft>(
    key: K,
    value: KCoderServerDraft[K],
  ) => {
    if (
      !canUseServerEditorRef.current ||
      activeProfileIdRef.current !== activeProfileId
    )
      return;
    editorRevisionRef.current += 1;
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const validate = () => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(draft.id))
      throw new Error(t("server_editor.invalid_id"));
    if (!draft.label.trim() || !draft.host.trim())
      throw new Error(t("server_editor.required_name_host"));
  };
  const run = async (
    action: (isCurrentEditor: () => boolean) => Promise<string | null>,
  ) => {
    const operationProfileId = activeProfileId;
    const isCurrentEditor = () =>
      Boolean(operationProfileId) &&
      activeProfileIdRef.current === operationProfileId &&
      editorRevisionRef.current === renderEditorRevision &&
      canUseServerEditorRef.current;
    if (busyRef.current || !isCurrentEditor()) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    setMessageIsSuccess(false);
    try {
      if (!isCurrentEditor()) return;
      validate();
      if (!isCurrentEditor()) return;
      const successMessage = await action(isCurrentEditor);
      if (
        successMessage &&
        activeProfileIdRef.current === operationProfileId
      ) {
        setMessage(successMessage);
        setMessageIsSuccess(true);
      }
    } catch (value) {
      if (isCurrentEditor()) {
        setMessage(connectionError(value));
        setMessageIsSuccess(false);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <View
      testID="server-editor-route"
      style={[styles.root, { paddingTop: insets.top }]}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityLabel={t("common.back")}
          onPress={() => backOrReplace(router, "/settings")}
          style={styles.headerButton}
        >
          <ChevronLeft size={23} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("server_editor.title")}</Text>
        <Pressable
          accessibilityLabel={t("server_editor.add_ssh_server")}
          disabled={editorUnavailable}
          onPress={() => changeSelection(emptyDraft(), false)}
          style={[styles.headerButton, editorUnavailable && styles.disabled]}
        >
          <Plus size={22} color={colors.text} />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + spacing.xl },
        ]}
      >
        <Text style={styles.sectionTitle}>{t("server_editor.current_ssh_servers")}</Text>
        {runtime.error ? (
          <View testID="server-list-read-error" style={styles.readError}>
            <Text
              accessibilityRole="alert"
              selectable
              style={styles.readErrorMessage}
            >
              {runtime.error}
            </Text>
            <Button
              testID="server-list-read-retry"
              disabled={runtime.loading || busy || !activeProfile}
              onPress={() => void refresh()}
            >
              {t("server_editor.reload_server_config")}
            </Button>
          </View>
        ) : null}
        {!runtime.error && (!editorReady || runtime.loading) ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.textMuted} />
            <Text style={styles.loadingText}>{t("server_editor.loading_gateway_config")}</Text>
          </View>
        ) : null}
        <View style={styles.serverList}>
          {sshServers.map((server) => (
            <Pressable
              key={server.id}
              disabled={editorUnavailable}
              onPress={() => changeSelection(fromServer(server), true)}
              style={[
                styles.serverRow,
                editingExisting && draft.id === server.id && styles.selected,
                editorUnavailable && styles.disabled,
              ]}
            >
              <Server size={18} color={colors.textMuted} />
              <View style={styles.serverCopy}>
                <Text style={styles.serverName}>{server.label}</Text>
                <Text style={styles.serverMeta}>
                  {server.user ? `${server.user}@` : ""}
                  {server.host}:{server.port ?? 22}
                </Text>
              </View>
              {editingExisting && draft.id === server.id ? (
                <Check size={18} color={colors.green} />
              ) : null}
            </Pressable>
          ))}
        </View>
        <Text style={styles.sectionTitle}>
          {editingExisting ? t("server_editor.edit_connection") : t("server_editor.new_connection")}
        </Text>
        <Field
          testID="server-id"
          label={t("server_editor.id")}
          value={draft.id}
          editable={!editorUnavailable && !editingExisting}
          autoCapitalize="none"
          onChangeText={(value) => update("id", value)}
          placeholder="gpu-lab"
        />
        <Field
          label={t("server_editor.display_name")}
          value={draft.label}
          editable={!editorUnavailable}
          onChangeText={(value) => update("label", value)}
          placeholder={t("server_editor.display_name_placeholder")}
        />
        <Field
          label={t("server_editor.ssh_host")}
          value={draft.host}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("host", value)}
          placeholder="127.0.0.1"
        />
        <View style={styles.split}>
          <View style={styles.flex}>
            <Field
              label={t("server_editor.user")}
              value={draft.user ?? ""}
              editable={!editorUnavailable}
              autoCapitalize="none"
              onChangeText={(value) => update("user", value || undefined)}
            />
          </View>
          <View style={styles.port}>
            <Field
              label={t("server_editor.port")}
              value={String(draft.port ?? 22)}
              editable={!editorUnavailable}
              keyboardType="number-pad"
              onChangeText={(value) =>
                update("port", Number(value) || undefined)
              }
            />
          </View>
        </View>
        <Field
          label={t("server_editor.remote_working_directory")}
          value={draft.workspace ?? "/"}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("workspace", value)}
        />
        <Field
          label={t("server_editor.kcoder_command")}
          value={draft.command ?? "kcoder"}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("command", value)}
        />
        <Text style={styles.sectionTitle}>{t("server_editor.advanced_settings")}</Text>
        <Field
          label={t("server_editor.provider_profile_optional")}
          value={draft.profile ?? ""}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("profile", value || undefined)}
          placeholder="kunlunmeta"
        />
        <Field
          label={t("server_editor.settings_file_optional")}
          value={draft.settingsFile ?? ""}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("settingsFile", value || undefined)}
          placeholder="/srv/config/kcoder.json"
        />
        <Field
          label={t("server_editor.remote_chromium_path_optional")}
          value={draft.chromiumBin ?? ""}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("chromiumBin", value || undefined)}
          placeholder="/usr/bin/chromium"
        />
        <Pressable
          testID="server-chromium-no-sandbox"
          accessibilityLabel={t("server_editor.chromium_no_sandbox")}
          accessibilityRole="checkbox"
          accessibilityState={{
            checked: Boolean(draft.chromiumNoSandbox),
            disabled: editorUnavailable,
          }}
          aria-checked={Boolean(draft.chromiumNoSandbox)}
          disabled={editorUnavailable}
          onPress={() => update("chromiumNoSandbox", !draft.chromiumNoSandbox)}
          style={[styles.toggle, editorUnavailable && styles.disabled]}
        >
          <View
            style={[styles.checkbox, draft.chromiumNoSandbox && styles.checked]}
          >
            {draft.chromiumNoSandbox ? <Check size={14} color={colors.accentText} /> : null}
          </View>
          <View style={styles.flex}>
            <Text style={styles.toggleTitle}>{t("server_editor.chromium_no_sandbox")}</Text>
            <Text style={styles.toggleBody}>
              {t("server_editor.chromium_no_sandbox_note")}
            </Text>
          </View>
        </Pressable>
        <Pressable
          testID="server-accept-new-host-key"
          accessibilityLabel={t("server_editor.accept_new_host_key")}
          accessibilityRole="checkbox"
          accessibilityState={{
            checked: Boolean(draft.acceptNewHostKey),
            disabled: editorUnavailable,
          }}
          aria-checked={Boolean(draft.acceptNewHostKey)}
          disabled={editorUnavailable}
          onPress={() => update("acceptNewHostKey", !draft.acceptNewHostKey)}
          style={[styles.toggle, editorUnavailable && styles.disabled]}
        >
          <View
            style={[styles.checkbox, draft.acceptNewHostKey && styles.checked]}
          >
            {draft.acceptNewHostKey ? <Check size={14} color={colors.accentText} /> : null}
          </View>
          <View style={styles.flex}>
            <Text style={styles.toggleTitle}>{t("server_editor.accept_new_host_key")}</Text>
            <Text style={styles.toggleBody}>
              {t("server_editor.accept_new_host_key_note")}
            </Text>
          </View>
        </Pressable>
        {message ? (
          <Text
            style={messageIsSuccess ? styles.success : styles.error}
          >
            {message}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            disabled={editorUnavailable || !activeProfile}
            onPress={() =>
              void run(async (isCurrentEditor) => {
                const result = await testServer(activeProfile!, draft);
                if (!isCurrentEditor()) return null;
                if (!result.ok) throw new Error(result.error || t("server_editor.connection_test_failed"));
                return t("server_editor.connection_test_success");
              })
            }
          >
            {t("server_editor.test_connection")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={editorUnavailable || !activeProfile}
            onPress={() =>
              void run(async (isCurrentEditor) => {
                const profileId = activeProfile!.id;
                const savedDraft = { ...draft };
                const wasEditingExisting = editingExisting;
                await saveServer(activeProfile!, savedDraft);
                if (wasEditingExisting)
                  taskRuntimeRegistry.removeServer(profileId, savedDraft.id);
                if (!isCurrentEditor()) return null;
                setBaseline(savedDraft);
                setEditingExisting(true);
                if (activeProfileIdRef.current !== profileId) return null;
                await refresh();
                return wasEditingExisting
                  ? t("server_editor.saved_and_old_connection_closed")
                  : t("server_editor.server_saved");
              })
            }
          >
            {t("common.save")}
          </Button>
        </View>
        {editingExisting ? (
          <Button
            variant="danger"
            disabled={editorUnavailable || !activeProfile}
            onPress={() => {
              const profileIdAtPrompt = activeProfileId;
              if (
                !canUseServerEditorRef.current ||
                !profileIdAtPrompt ||
                activeProfileIdRef.current !== profileIdAtPrompt
              )
                return;
              const revisionAtPrompt = editorRevisionRef.current;
              requestConfirmation({
                title: t("server_editor.delete_server_title"),
                message: t("server_editor.delete_server_message", { label: draft.label }),
                confirmLabel: t("common.delete"),
                destructive: true,
                onConfirm: () => {
                  if (
                    !canUseServerEditorRef.current ||
                    activeProfileIdRef.current !== profileIdAtPrompt ||
                    editorRevisionRef.current !== revisionAtPrompt
                  )
                    return;
                  void run(async (isCurrentEditor) => {
                    const profileId = profileIdAtPrompt;
                    const removedId = draft.id;
                    await deleteServer(activeProfile!, removedId);
                    taskRuntimeRegistry.removeServer(profileId, removedId);
                    if (!isCurrentEditor()) return null;
                    showDraft(emptyDraft(), false);
                    if (activeProfileIdRef.current !== profileId) return null;
                    await refresh();
                    return t("server_editor.server_deleted");
                  });
                },
              })
            }}
          >
            {t("server_editor.delete_server")}
          </Button>
        ) : null}
        <Text style={styles.note}>
          {t("server_editor.built_in_server_note")}
        </Text>
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    height: 60,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.sm,
  },
  headerButton: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  content: {
    width: "100%",
    maxWidth: 680,
    alignSelf: "center",
    padding: spacing.lg,
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
    marginTop: spacing.sm,
  },
  loadingRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  loadingText: { color: colors.textMuted, fontSize: 12 },
  readError: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.red,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  readErrorMessage: { color: colors.red, fontSize: 12, lineHeight: 17 },
  serverList: { gap: spacing.sm },
  serverRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  selected: { borderColor: colors.green },
  serverCopy: { flex: 1 },
  serverName: { color: colors.text, fontSize: 14, fontWeight: "700" },
  serverMeta: { color: colors.textDim, fontSize: 11, marginTop: 4 },
  split: { flexDirection: "row", gap: spacing.md },
  flex: { flex: 1 },
  port: { width: 110 },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    borderRadius: radius.md,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    alignItems: "center",
    justifyContent: "center",
  },
  checked: { backgroundColor: colors.green, borderColor: colors.green },
  toggleTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  toggleBody: {
    color: colors.textDim,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  actions: { flexDirection: "row", gap: spacing.sm },
  disabled: { opacity: 0.45 },
  success: { color: colors.green, fontSize: 12 },
  error: { color: colors.red, fontSize: 12 },
  note: {
    color: colors.textDim,
    fontSize: 11,
    lineHeight: 17,
    textAlign: "center",
    marginTop: spacing.md,
  },
});
