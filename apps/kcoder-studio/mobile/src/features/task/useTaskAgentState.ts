import { filterMobileSlashCommands } from "@/components/composer-slash";
import {
  initialMessageFollowState,
  shouldAnchorLatest,
} from "@/components/message-follow-state";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { taskMessageQueue } from "@/runtime/task-message-queue";
import {
  listModels,
  type ChatMessage,
  type ModelOption,
} from "@/runtime/task-runtime";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, FlatList, Keyboard, TextInput } from "react-native";
import { releaseLocalAttachmentPreview } from "./attachmentPreparation";
import { type AgentPanelProps, type ComposerStagedAttachment } from "./types";

export function useTaskAgentState({
  task,
  profile,
  server,
  bottomInset,
  demo,
  initialDraft,
  initialQueuedMessages,
  onDraftChange,
  onQueuedMessagesChange,
  onTurnPreferencesChange,
  onOpenFile,
  onOpenChanges,
}: AgentPanelProps) {
  const snapshot = useSyncExternalStore(
    task.subscribe,
    task.getSnapshot,
    task.getSnapshot,
  );

  const messageQueue = useMemo(() => taskMessageQueue(task), [task]);

  const queuedMessages = useSyncExternalStore(
    messageQueue.subscribe,
    messageQueue.getSnapshot,
    messageQueue.getSnapshot,
  );

  const [input, setInput] = useState("");

  const messageInputRef = useRef<TextInput>(null);

  const goalEditExpectationRef = useRef<{
    command: "/goal" | "/goal-pro" | "/ultgoal";
    goalId: string;
    revision: number;
  } | null>(null);

  const [attachments, setAttachments] = useState<ComposerStagedAttachment[]>(
    [],
  );

  const stagedAttachmentsRef = useRef<ComposerStagedAttachment[]>([]);

  const mountedRef = useRef(true);

  const mountGeneration = useRef(0);

  stagedAttachmentsRef.current = attachments;

  const [attachmentSheet, setAttachmentSheet] = useState(false);

  const [attachmentLoading, setAttachmentLoading] = useState(false);

  const attachmentBatchRunning = useRef(false);

  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const [unarchiveError, setUnarchiveError] = useState<string | null>(null);

  const [unarchiving, setUnarchiving] = useState(false);

  const [queueError, setQueueError] = useState<string | null>(null);

  const [composerNotice, setComposerNotice] = useState<string | null>(null);

  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);

  const [modelsLoading, setModelsLoading] = useState(false);

  const [modelBusy, setModelBusy] = useState(false);

  const [modelError, setModelError] = useState<string | null>(null);

  const sendingQueued = useRef(false);

  const queueHydrated = useRef(false);

  const lastQueuePersistence = useRef<string | null>(null);

  const closeAttachmentSheet = () => {
    if (!attachmentLoading) setAttachmentSheet(false);
  };

  const openAttachmentSheet = () => {
    Keyboard.dismiss();
    setAttachmentError(null);
    setAttachmentSheet(true);
  };

  const attachmentSheetRef = useModalFocusTrap(
    attachmentSheet,
    closeAttachmentSheet,
  );

  const closeModelPicker = () => {
    if (!modelBusy) setModelPickerOpen(false);
  };

  const modelPickerRef = useModalFocusTrap(modelPickerOpen, closeModelPicker);

  useEffect(() => {
    const generation = ++mountGeneration.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (demo) return;
      const abandoned = [...stagedAttachmentsRef.current];
      queueMicrotask(() => {
        if (mountedRef.current || mountGeneration.current !== generation)
          return;
        for (const attachment of abandoned) {
          releaseLocalAttachmentPreview(attachment);
          void task
            .request("attachment/delete", { path: attachment.path })
            .catch(() => {});
        }
      });
    };
  }, [demo, task]);

  const messageListRef = useRef<FlatList<ChatMessage>>(null);

  const messageListLayoutHeight = useRef(0);

  const messageFollowState = useRef(initialMessageFollowState());

  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const webPrependAnchor = useRef<{
    scroller: HTMLElement;
    height: number;
    top: number;
    applying: boolean;
    adjusting: boolean;
  } | null>(null);

  const draftHydrated = useRef(false);

  useEffect(() => {
    if (draftHydrated.current || initialDraft === undefined) return;
    draftHydrated.current = true;
    setInput((current) => current || initialDraft);
  }, [initialDraft]);

  useEffect(() => {
    const timer = setTimeout(() => onDraftChange?.(input || undefined), 350);
    return () => clearTimeout(timer);
  }, [input, onDraftChange]);

  useEffect(() => {
    if (
      !queueHydrated.current &&
      messageQueue.getSnapshot().length === 0 &&
      initialQueuedMessages?.length
    ) {
      messageQueue.replace(initialQueuedMessages);
      return;
    }
    queueHydrated.current = true;
    const signature = JSON.stringify(queuedMessages);
    if (lastQueuePersistence.current === signature) return;
    lastQueuePersistence.current = signature;
    onQueuedMessagesChange?.(
      queuedMessages.length > 0
        ? queuedMessages.map((message) => ({
            ...message,
            attachments: [...message.attachments],
          }))
        : undefined,
    );
  }, [
    initialQueuedMessages,
    messageQueue,
    onQueuedMessagesChange,
    queuedMessages,
  ]);

  const latestInputRef = useRef(input);

  const onDraftChangeRef = useRef(onDraftChange);

  latestInputRef.current = input;

  onDraftChangeRef.current = onDraftChange;

  useEffect(
    () => () => {
      onDraftChangeRef.current?.(latestInputRef.current || undefined);
    },
    [],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active")
        onDraftChange?.(latestInputRef.current || undefined);
    });
    return () => subscription.remove();
  }, [onDraftChange]);

  useEffect(() => {
    if (!shouldAnchorLatest(messageFollowState.current)) return;
    const timer = setTimeout(
      () => messageListRef.current?.scrollToEnd({ animated: false }),
      90,
    );
    return () => clearTimeout(timer);
  }, [snapshot.messages.at(-1)?.id, snapshot.messages.at(-1)?.content]);

  const slashCommands = useMemo(
    () => filterMobileSlashCommands(input),
    [input],
  );
  function openModelPicker() {
    Keyboard.dismiss();
    setModelPickerOpen(true);
    setModelError(null);
    if (modelOptions.length > 0 || modelsLoading) return;
    setModelsLoading(true);
    const operation = demo
      ? Promise.resolve<ModelOption[]>([
          {
            id: "demo-minimax",
            model: "MiniMax-M3",
            displayName: "MiniMax-M3",
            providerId: "kunlunmeta",
            providerName: "KCoder Meta",
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
          },
          {
            id: "demo-kimi",
            model: "kimi-for-coding",
            displayName: "Kimi for Coding",
            providerId: "kimi",
            providerName: "Kimi",
            supportedReasoningEfforts: ["medium", "high"],
            defaultReasoningEffort: "medium",
          },
        ])
      : profile && server
        ? listModels(profile, server)
        : Promise.reject(new Error("Gateway 或服务器尚未就绪"));
    void operation
      .then(setModelOptions)
      .catch((value) =>
        setModelError(value instanceof Error ? value.message : String(value)),
      )
      .finally(() => setModelsLoading(false));
  }
  return {
    openModelPicker,
    task,
    profile,
    server,
    bottomInset,
    demo,
    initialDraft,
    initialQueuedMessages,
    onDraftChange,
    onQueuedMessagesChange,
    onTurnPreferencesChange,
    onOpenFile,
    onOpenChanges,
    snapshot,
    messageQueue,
    queuedMessages,
    input,
    setInput,
    messageInputRef,
    goalEditExpectationRef,
    attachments,
    setAttachments,
    stagedAttachmentsRef,
    mountedRef,
    mountGeneration,
    attachmentSheet,
    setAttachmentSheet,
    attachmentLoading,
    setAttachmentLoading,
    attachmentBatchRunning,
    attachmentError,
    setAttachmentError,
    unarchiveError,
    setUnarchiveError,
    unarchiving,
    setUnarchiving,
    queueError,
    setQueueError,
    composerNotice,
    setComposerNotice,
    modelPickerOpen,
    setModelPickerOpen,
    modelOptions,
    setModelOptions,
    modelsLoading,
    setModelsLoading,
    modelBusy,
    setModelBusy,
    modelError,
    setModelError,
    sendingQueued,
    queueHydrated,
    lastQueuePersistence,
    closeAttachmentSheet,
    openAttachmentSheet,
    attachmentSheetRef,
    closeModelPicker,
    modelPickerRef,
    messageListRef,
    messageListLayoutHeight,
    messageFollowState,
    showJumpToLatest,
    setShowJumpToLatest,
    webPrependAnchor,
    draftHydrated,
    latestInputRef,
    onDraftChangeRef,
    slashCommands,
  };
}
