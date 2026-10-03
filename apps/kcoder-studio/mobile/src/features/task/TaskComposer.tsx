import { MAX_TASK_MESSAGE_CHARACTERS } from "@/protocol/task-message-limits";
import { colors } from "@/theme";
import { ArrowUp, Paperclip, Square } from "lucide-react-native";
import { Pressable, TextInput, View } from "react-native";
import { styles } from "./taskStyles";
import type { useTaskModelPreferences } from "./useTaskModelPreferences";

export function TaskComposer({
  model,
}: {
  model: ReturnType<typeof useTaskModelPreferences>;
}) {
  const {
    task,
    snapshot,
    input,
    setInput,
    messageInputRef,
    setQueueError,
    setComposerNotice,
    openAttachmentSheet,
    submit,
    canSend,
  } = model;
  return (
    <>
      <View testID="message-input-root" style={styles.composer}>
        <Pressable
          testID="composer-attachment"
          accessibilityLabel="添加附件"
          disabled={!snapshot.connected}
          accessibilityState={{ disabled: !snapshot.connected }}
          onPress={openAttachmentSheet}
          style={[
            styles.attachButton,
            !snapshot.connected && styles.sendDisabled,
          ]}
        >
          <Paperclip size={19} color={colors.textMuted} />
        </Pressable>
        <TextInput
          ref={messageInputRef}
          testID="message-input"
          value={input}
          onChangeText={(value) => {
            setInput(value);
            setQueueError(null);
            setComposerNotice(null);
          }}
          maxLength={MAX_TASK_MESSAGE_CHARACTERS}
          multiline
          placeholder={snapshot.running ? "输入后加入发送队列…" : "发送消息…"}
          placeholderTextColor={colors.textDim}
          style={styles.composerInput}
          editable={snapshot.connected}
        />
        {snapshot.running ? (
          <Pressable
            testID="stop-turn"
            accessibilityRole="button"
            accessibilityLabel="停止"
            onPress={() => void task.interrupt()}
            style={styles.stopButton}
          >
            <Square size={14} fill={colors.text} color={colors.text} />
          </Pressable>
        ) : null}
        <Pressable
          testID={snapshot.running ? "queue-message" : "send-message"}
          accessibilityRole="button"
          accessibilityLabel={snapshot.running ? "排队发送" : "发送"}
          disabled={!canSend}
          accessibilityState={{ disabled: !canSend }}
          onPress={() => void submit()}
          style={[styles.sendButton, !canSend && styles.sendDisabled]}
        >
          <ArrowUp size={19} color={colors.accentText} />
        </Pressable>
      </View>
    </>
  );
}
