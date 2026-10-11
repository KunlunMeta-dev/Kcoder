import { t } from "@/i18n";
import { filterMobileSlashCommands } from "@/components/composer-slash";
import {
  deferMessageFollowAnchor,
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
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, FlatList, Keyboard, TextInput } from "react-native";
import { releaseLocalAttachmentPreview } from "./attachmentPreparation";
import { type AgentPanelProps, type ComposerStagedAttachment } from "./types";

function ignorePersistenceFailure(operation: void | Promise<void>): void {
  if (operation) void operation.catch(() => {});
}

export function useTaskAgentState({
  task,
  profile,
  server,
  bottomInset,
  demo,
  initialDraft,
  initialQueuedMessages,
  initialFailedSubmissions,
  onDraftChange,
  onQueuedMessagesChange,
  onFailedSubmissionsChange,
  onQueueCommit,
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

  const [input, setInputState] = useState("");
  const inputIntentRef = useRef({ value: "", revision: 0 });
  const latestInputRef = useRef("");
  const inputRevisionRef = useRef(0);
  const setInput = useCallback<Dispatch<SetStateAction<string>>>(
    (nextInput) => {
      const current = inputIntentRef.current;
      const value =
        typeof nextInput === "function" ? nextInput(current.value) : nextInput;
      inputIntentRef.current = {
        value,
        revision: current.revision + 1,
      };
      latestInputRef.current = value;
      inputRevisionRef.current = inputIntentRef.current.revision;
      setInputState(value);
    },
    [],
  );

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
  const pendingAttachmentSubmissions = useRef(new Map<string, number>());
  const removedPendingAttachments = useRef(new Set<string>());

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
          if (pendingAttachmentSubmissions.current.has(attachment.path))
            continue;
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
    // An empty input may be an intentional edit, not an unhydrated value.
    if (inputIntentRef.current.revision === 0) setInput(initialDraft);
  }, [initialDraft]);

  useEffect(() => {
    const timer = setTimeout(
      () => ignorePersistenceFailure(onDraftChange?.(input || undefined)),
      350,
    );
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
    // Staging durability is awaited explicitly by the submit path. A delayed
    // projection effect must never replace that save with an older queue.
    if (queuedMessages.some((message) => message.staging)) return;
    ignorePersistenceFailure(messageQueue.persistProjection(async () => {
      const currentMessages = messageQueue.getSnapshot();
      if (currentMessages.some((message) => message.staging)) return;
      const signature = JSON.stringify(currentMessages);
      if (lastQueuePersistence.current === signature) return;
      await onQueuedMessagesChange?.(currentMessages.length > 0 ? currentMessages.map((message) => ({ ...message, attachments: [...message.attachments] })) : undefined);
      lastQueuePersistence.current = signature;
    }));
  }, [
    initialQueuedMessages,
    messageQueue,
    onQueuedMessagesChange,
    queuedMessages,
  ]);

  const onDraftChangeRef = useRef(onDraftChange);

  onDraftChangeRef.current = onDraftChange;

  useEffect(
    () => () => {
      ignorePersistenceFailure(
        onDraftChangeRef.current?.(inputIntentRef.current.value || undefined),
      );
    },
    [],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active")
        ignorePersistenceFailure(
          onDraftChange?.(inputIntentRef.current.value || undefined),
        );
    });
    return () => subscription.remove();
  }, [onDraftChange]);

  useEffect(() => {
    const followIntent = messageFollowState.current;
    const generation = mountGeneration.current;
    if (deferMessageFollowAnchor(followIntent)) return;
    if (!shouldAnchorLatest(followIntent)) return;
    const timer = setTimeout(
      () => {
        if (!mountedRef.current || mountGeneration.current !== generation) return;
        if (deferMessageFollowAnchor(messageFollowState.current, followIntent)) return;
        if (messageFollowState.current !== followIntent ||
            !shouldAnchorLatest(messageFollowState.current)) return;
        messageListRef.current?.scrollToEnd({ animated: false });
      },
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
        : Promise.reject(
            new Error(t("task.the_gateway_or_server_is_not_ready")),
          );
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
    initialFailedSubmissions,
    onDraftChange,
    onQueuedMessagesChange,
    onFailedSubmissionsChange,
    onQueueCommit,
    onTurnPreferencesChange,
    onOpenFile,
    onOpenChanges,
    snapshot,
    messageQueue,
    queuedMessages,
    input,
    setInput,
    inputIntentRef,
    messageInputRef,
    goalEditExpectationRef,
    attachments,
    setAttachments,
    stagedAttachmentsRef,
    pendingAttachmentSubmissions,
    removedPendingAttachments,
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
    inputRevisionRef,
    onDraftChangeRef,
    slashCommands,
  };
}
