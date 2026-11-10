import { useRef, useState, type ComponentProps } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ChevronDown, Folder, Server } from "lucide-react-native";
import { ConversationV3Background, ConversationV3Header } from "../../../mobile/src/features/interface/ConversationV3";
import { TaskComposer } from "../../../mobile/src/features/task/TaskComposer";
import { MessageBubble } from "../../../mobile/src/features/task/MessageBubble";
import type { FailedTaskSubmission } from "../../../mobile/src/features/task/failedTaskSubmissions";
import type { TaskSnapshot } from "../../../mobile/src/runtime/task-runtime";
import { useTheme } from "../../../mobile/src/theme";

const noAction = () => {};
const noAsyncAction = async () => {};
const threadId = "synthetic-send-recovery";

/** Frozen presentation only: no TaskRuntime, Gateway, timer or real attachment. */
export default function SendRecoveryFixture() {
  const params = new URLSearchParams(window.location.search);
  const state = params.get("state") || "retaining";
  const english = params.get("language") === "en";
  const { colors } = useTheme();
  const messageInputRef = useRef<TextInput>(null);
  const [input, setInput] = useState("");
  const pending = ["preparing", "retaining", "sending"].includes(state);
  const snapshot: TaskSnapshot = {
    threadId, title: english ? "Hello" : "你好", cwd: "/workspace/KCoder",
    connected: true, configurationReady: true, running: false, activeTurnId: null,
    messages: [], hasMoreBefore: false, beforeCursor: null, loadingOlder: false,
    interaction: null, error: null,
  };
  const submission: FailedTaskSubmission = {
    id: "synthetic-send-1", content: "1+1=", attachments: [], createdAt: 1,
    outcome: state === "unknown" || state === "accepted" || state === "sending" ? "unknown" : "failed",
    retrying: pending,
    phase: state === "preparing" ? "preparing" : state === "retaining" ? "retaining" : "sending",
    ...(state === "accepted" ? { acceptedTurn: { threadId, turnId: "synthetic-turn" } } : {}),
    ...(state === "failed" ? { error: english ? "Example: the message was not sent." : "示例：消息未发送成功。" } : {}),
  };
  // The shared composer only needs a truthy owner for this presentation. No runtime is constructed.
  const task = { interrupt: noAsyncAction } as ComponentProps<typeof TaskComposer>["model"]["task"];
  const model: ComponentProps<typeof TaskComposer>["model"] = {
    task, snapshot, input, setInput, messageInputRef, attachments: [], canSend: false,
    attachmentSheet: false, modelPickerOpen: false, failedSubmissions: state === "none" ? [] : [submission],
    retainedOutbox: { rows: [], error: null, busy: [], available: false,
      resume: noAsyncAction, checkConsumer: noAsyncAction, discard: noAsyncAction },
    removeAttachment: noAsyncAction, openAttachmentSheet: noAction,
    setQueueError: noAction, setComposerNotice: noAction, submit: noAsyncAction,
    retryFailedSubmission: noAsyncAction, checkFailedSubmission: noAsyncAction,
    dismissFailedSubmission: noAction, removeFailedSubmissionAttachment: noAsyncAction,
  };
  const chip = { minHeight: 32, minWidth: 0, flexShrink: 1, maxWidth: "56%" as const, paddingHorizontal: 9, borderRadius: 18,
    backgroundColor: colors.surfaceRaised, flexDirection: "row" as const, alignItems: "center" as const, gap: 4 };
  return <SafeAreaProvider><View testID="send-recovery-fixture" style={{ flex: 1, backgroundColor: colors.background }}>
    <ConversationV3Background />
    <ConversationV3Header title={snapshot.title} subtitle={english ? "CYX server" : "CYX 服务器"}
      onBack={noAction} onNew={noAction} onMore={noAction} />
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 16 }}>
      <MessageBubble readOnly message={{ id: "synthetic-reply", role: "assistant", status: "done", timestampMs: 1,
        content: english
          ? "The conversation stays visible while the next message is being prepared.\n\nThis is synthetic history for reviewing the recovery notice above the input."
          : "回到会话后，可以继续阅读已有的回复。\n\n这是一段合成历史，用来检查发送恢复记录与输入区之间的布局。" }}
        continuationBusy={false} connected onOpenFile={() => false} onOpenChanges={noAction} />
    </ScrollView>
    <View style={{ flexDirection: "row", justifyContent: "space-between", padding: 10, gap: 8 }}>
      <Pressable disabled style={chip}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green }} />
        <Server size={14} color={colors.textMuted} /><Text numberOfLines={1} style={{ color: colors.text, flexShrink: 1 }}>{english ? "CYX server" : "CYX 服务器"}</Text><ChevronDown size={12} color={colors.textMuted} /></Pressable>
      <Pressable disabled style={chip}><Folder size={14} color={colors.textMuted} /><Text numberOfLines={1} style={{ color: colors.text, flexShrink: 1 }}>KCoder</Text><ChevronDown size={12} color={colors.textMuted} /></Pressable>
    </View>
    <TaskComposer model={model} toolbar={<View style={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}><Pressable disabled style={{ paddingHorizontal: 12, minHeight: 32, borderRadius: 18, backgroundColor: colors.surface }}>
      <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 32 }}>MiniMax-M3</Text>
    </Pressable></View>} />
  </View></SafeAreaProvider>;
}
