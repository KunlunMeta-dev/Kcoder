import { useEffect, useRef, useState } from "react";
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
import { colors, radius, spacing } from "@/theme";
import { requestConfirmation } from "@/platform/confirmation";
import { backOrReplace } from "@/navigation/back-or-replace";

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
    return `SSH 连接超时，请检查地址、端口和防火墙。\n${message}`;
  if (/permission denied|authentication/i.test(message))
    return `SSH 认证失败，请检查服务器上的 SSH agent 或 ~/.ssh/config。\n${message}`;
  if (/host key|known_hosts/i.test(message))
    return `SSH host key 校验失败，请先确认服务器身份。\n${message}`;
  if (/not found|no such file|command/i.test(message))
    return `远端未找到 KCoder 命令或工作目录。\n${message}`;
  if (/resolve|name or service|enotfound/i.test(message))
    return `无法解析 SSH 主机名。\n${message}`;
  return `服务器连接失败：${message}`;
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
  const [draft, setDraft] = useState<KCoderServerDraft>(emptyDraft);
  const [baseline, setBaseline] = useState<KCoderServerDraft>(emptyDraft);
  const [editingExisting, setEditingExisting] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const loadedProfileRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const observedLoadingRef = useRef(false);
  const dirty = draftSignature(draft) !== draftSignature(baseline);
  const editorUnavailable = !editorReady || runtime.loading || busy;

  const showDraft = (next: KCoderServerDraft, existing: boolean) => {
    setDraft(next);
    setBaseline(next);
    setEditingExisting(existing);
    setMessage(null);
  };

  const confirmDiscard = (onConfirm: () => void, leaving = false) => {
    const detail = "当前 SSH 服务器表单还没有保存。";
    if (Platform.OS === "web" && typeof globalThis.confirm === "function") {
      if (globalThis.confirm(`放弃未保存的更改？\n\n${detail}`)) onConfirm();
      return;
    }
    Alert.alert("放弃未保存的更改？", detail, [
      { text: "继续编辑", style: "cancel" },
      {
        text: leaving ? "放弃并离开" : "放弃更改",
        style: "destructive",
        onPress: onConfirm,
      },
    ]);
  };

  const changeSelection = (next: KCoderServerDraft, existing: boolean) => {
    if (!dirty) {
      showDraft(next, existing);
      return;
    }
    confirmDiscard(() => showDraft(next, existing));
  };

  usePreventRemove(dirty, ({ data }) => {
    confirmDiscard(() => navigation.dispatch(data.action), true);
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
      else if (profileId && (runtime.servers.length > 0 || runtime.error)) {
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
      (observedLoadingRef.current ||
        runtime.servers.length > 0 ||
        runtime.error)
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
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const validate = () => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(draft.id))
      throw new Error("ID 只能包含字母、数字、点、下划线和连字符");
    if (!draft.label.trim() || !draft.host.trim())
      throw new Error("名称和 SSH 主机不能为空");
  };
  const run = async (action: () => Promise<string>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      validate();
      setMessage(await action());
    } catch (value) {
      setMessage(connectionError(value));
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
          accessibilityLabel="返回"
          onPress={() => backOrReplace(router, "/settings")}
          style={styles.headerButton}
        >
          <ChevronLeft size={23} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>KCoder 服务器</Text>
        <Pressable
          accessibilityLabel="新增 SSH 服务器"
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
        <Text style={styles.sectionTitle}>现有 SSH 服务器</Text>
        {!editorReady || runtime.loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.textMuted} />
            <Text style={styles.loadingText}>正在读取 Gateway 配置…</Text>
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
          {editingExisting ? "编辑连接" : "新增 SSH 连接"}
        </Text>
        <Field
          testID="server-id"
          label="ID"
          value={draft.id}
          editable={!editorUnavailable && !editingExisting}
          autoCapitalize="none"
          onChangeText={(value) => update("id", value)}
          placeholder="gpu-lab"
        />
        <Field
          label="显示名称"
          value={draft.label}
          editable={!editorUnavailable}
          onChangeText={(value) => update("label", value)}
          placeholder="GPU 开发服务器"
        />
        <Field
          label="SSH 主机"
          value={draft.host}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("host", value)}
          placeholder="127.0.0.1"
        />
        <View style={styles.split}>
          <View style={styles.flex}>
            <Field
              label="用户"
              value={draft.user ?? ""}
              editable={!editorUnavailable}
              autoCapitalize="none"
              onChangeText={(value) => update("user", value || undefined)}
            />
          </View>
          <View style={styles.port}>
            <Field
              label="端口"
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
          label="远端工作目录"
          value={draft.workspace ?? "/"}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("workspace", value)}
        />
        <Field
          label="KCoder 命令"
          value={draft.command ?? "kcoder"}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("command", value)}
        />
        <Text style={styles.sectionTitle}>高级设置</Text>
        <Field
          label="Provider profile（可选）"
          value={draft.profile ?? ""}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("profile", value || undefined)}
          placeholder="kunlunmeta"
        />
        <Field
          label="Settings file（可选）"
          value={draft.settingsFile ?? ""}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("settingsFile", value || undefined)}
          placeholder="/srv/config/kcoder.json"
        />
        <Field
          label="远端 Chromium 路径（可选）"
          value={draft.chromiumBin ?? ""}
          editable={!editorUnavailable}
          autoCapitalize="none"
          onChangeText={(value) => update("chromiumBin", value || undefined)}
          placeholder="/usr/bin/chromium"
        />
        <Pressable
          testID="server-chromium-no-sandbox"
          accessibilityLabel="Chromium 使用 --no-sandbox"
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
            {draft.chromiumNoSandbox ? <Check size={14} color="#fff" /> : null}
          </View>
          <View style={styles.flex}>
            <Text style={styles.toggleTitle}>Chromium 使用 --no-sandbox</Text>
            <Text style={styles.toggleBody}>
              仅用于无法启用 Chromium sandbox 的受控服务器。
            </Text>
          </View>
        </Pressable>
        <Pressable
          testID="server-accept-new-host-key"
          accessibilityLabel="首次连接接受新 host key"
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
            {draft.acceptNewHostKey ? <Check size={14} color="#fff" /> : null}
          </View>
          <View style={styles.flex}>
            <Text style={styles.toggleTitle}>首次连接接受新 host key</Text>
            <Text style={styles.toggleBody}>
              仅应在你已通过可信渠道确认主机地址时启用。
            </Text>
          </View>
        </Pressable>
        {message ? (
          <Text
            style={message.startsWith("成功") ? styles.success : styles.error}
          >
            {message}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            disabled={busy || !activeProfile || !editorReady || runtime.loading}
            onPress={() =>
              void run(async () => {
                const result = await testServer(activeProfile!, draft);
                if (!result.ok) throw new Error(result.error || "连接测试失败");
                return "成功：SSH 与 app-server 握手通过";
              })
            }
          >
            测试连接
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!activeProfile || !editorReady || runtime.loading}
            onPress={() =>
              void run(async () => {
                const profileId = activeProfile!.id;
                await saveServer(activeProfile!, draft);
                if (editingExisting)
                  taskRuntimeRegistry.removeServer(profileId, draft.id);
                setBaseline({ ...draft });
                setEditingExisting(true);
                await refresh();
                return editingExisting
                  ? "成功：配置已保存，旧连接已关闭，请重新打开任务"
                  : "成功：服务器配置已保存";
              })
            }
          >
            保存
          </Button>
        </View>
        {editingExisting ? (
          <Button
            variant="danger"
            disabled={busy || !activeProfile || !editorReady || runtime.loading}
            onPress={() =>
              requestConfirmation({
                title: "删除 SSH 服务器？",
                message: `${draft.label} 将从 Gateway 配置中移除，并关闭该服务器的现有任务、终端和浏览器连接；远端文件不会被删除。`,
                confirmLabel: "删除",
                destructive: true,
                onConfirm: () =>
                  void run(async () => {
                    const profileId = activeProfile!.id;
                    const removedId = draft.id;
                    await deleteServer(activeProfile!, removedId);
                    taskRuntimeRegistry.removeServer(profileId, removedId);
                    showDraft(emptyDraft(), false);
                    await refresh();
                    return "成功：服务器已删除";
                  }),
              })
            }
          >
            删除此服务器
          </Button>
        ) : null}
        <Text style={styles.note}>
          内置 local 服务器由 Gateway 启动配置管理，不能在客户端删除。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
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
  serverList: { gap: spacing.sm },
  serverRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
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
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
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
