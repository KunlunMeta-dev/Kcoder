import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import type { TaskRuntime } from "@/runtime/task-runtime";
import type {
  ExpertChoice,
  ExpertDirectoryItem,
  ExpertDirectoryPage,
  ExpertVersionPage,
} from "@/runtime/task-runtime";
import type { TaskSnapshot } from "@/runtime/task-runtime/types";
import type { ThreadExpertResult } from "../../../../shared/generated/contracts";
import { spacing } from "@/theme";
import { Bot, Check, ChevronLeft, Search, X } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTaskAppearance } from "./taskStyles";

export type ExpertAvailability = "ready" | "loading" | "error" | "disconnected" | "archived" | "unsupported";

export type TaskExpertSelectorProps = {
  owner: object;
  selection: ExpertChoice | null | undefined;
  disabled: boolean;
  loadExperts(cursor: string | null, signal: AbortSignal): Promise<ExpertDirectoryPage>;
  loadVersions(expertId: string, cursor: string | null, signal: AbortSignal): Promise<ExpertVersionPage>;
  onSelect(choice: ExpertChoice | null): Promise<void> | void;
  nextTurn?: boolean;
  availability?: ExpertAvailability;
  availabilityMessage?: string;
  onRetryCurrent?(): Promise<void> | void;
  onOpenChange?(open: boolean): void;
  openRequest?: object;
  hideTrigger?: boolean;
  onTriggerPressIn?(): void;
  onBusyChange?(busy: boolean): void;
};

function sameReference(left: ExpertChoice["reference"] | null | undefined, right: ExpertChoice["reference"] | null | undefined): boolean {
  return Boolean(left && right && left.id === right.id && left.version === right.version &&
    left.definitionSha256 === right.definitionSha256);
}

function sameIdentity<T extends { id: string }>(items: T[], item: T): boolean {
  return items.some(existing => existing.id === item.id);
}

function sameChoice(items: ExpertChoice[], item: ExpertChoice): boolean {
  return items.some(existing => sameReference(existing.reference, item.reference));
}

function availabilityLabel(status: ExpertAvailability): string {
  switch (status) {
    case "loading": return t("expert.status_loading_short");
    case "error": return t("expert.status_error_short");
    case "disconnected": return t("expert.status_disconnected_short");
    case "archived": return t("expert.status_archived_short");
    case "unsupported": return t("expert.status_unsupported_short");
    case "ready": return "";
  }
}

function searchMatches(value: string | undefined, query: string): boolean {
  return !query || Boolean(value?.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
}

function catalogLoadError(error: unknown, fallbackKey: "expert.load_failed" | "expert.versions_load_failed"): string {
  return error instanceof Error && error.message === "AGENT_EXPERTS_OFFICE_DISABLED"
    ? t("expert.office_disabled")
    : t(fallbackKey);
}

export function TaskExpertSelector({
  owner,
  selection,
  disabled,
  loadExperts,
  loadVersions,
  onSelect,
  nextTurn = true,
  availability = selection === undefined ? "loading" : "ready",
  availabilityMessage,
  onRetryCurrent,
  onOpenChange,
  openRequest,
  hideTrigger = false,
  onTriggerPressIn,
  onBusyChange,
}: TaskExpertSelectorProps) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [visible, setVisible] = useState(false);
  const [directory, setDirectory] = useState<ExpertDirectoryItem[]>([]);
  const [directoryCursor, setDirectoryCursor] = useState<string | null>(null);
  const [versions, setVersions] = useState<ExpertChoice[]>([]);
  const [versionCursor, setVersionCursor] = useState<string | null>(null);
  const [activeExpert, setActiveExpert] = useState<ExpertDirectoryItem | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentRetryState, setCurrentRetryState] = useState<{ owner: object; retrying: boolean }>({ owner, retrying: false });
  const [selectBusyState, setSelectBusyState] = useState<{ owner: object; busy: boolean }>({ owner, busy: false });
  const [selectError, setSelectError] = useState<string | null>(null);
  const visibleRef = useRef(visible);
  const ownerRef = useRef(owner);
  const currentRetrying = currentRetryState.owner === owner && currentRetryState.retrying;
  const openedOwnerRef = useRef<object | null>(null);
  const handledOpenRequest = useRef<object | undefined>(undefined);
  const directoryRequestedRef = useRef(false);
  const requestRef = useRef<{ controller: AbortController; owner: object } | null>(null);
  const selectBusyRef = useRef<{ owner: object; busy: boolean }>({ owner, busy: false });
  visibleRef.current = visible;
  ownerRef.current = owner;

  const stopRead = useCallback(() => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
    setLoading(false);
  }, []);

  const close = useCallback((force = false) => {
    const busy = selectBusyRef.current.owner === ownerRef.current && selectBusyRef.current.busy;
    if (!visibleRef.current || (busy && !force)) return;
    visibleRef.current = false;
    openedOwnerRef.current = null;
    directoryRequestedRef.current = false;
    stopRead();
    setVisible(false);
    setQuery("");
    setActiveExpert(null);
    setLoadError(null);
    setSelectError(null);
    onOpenChange?.(false);
  }, [onOpenChange, stopRead]);

  const beginRead = useCallback(() => {
    requestRef.current?.controller.abort();
    const request = { controller: new AbortController(), owner: ownerRef.current };
    requestRef.current = request;
    return {
      ...request,
      isCurrent: () => visibleRef.current && ownerRef.current === request.owner &&
        openedOwnerRef.current === request.owner && requestRef.current === request &&
        !request.controller.signal.aborted,
    };
  }, []);

  const loadDirectoryPage = useCallback(async (cursor: string | null, reset = false) => {
    if (loading || (selectBusyRef.current.owner === ownerRef.current && selectBusyRef.current.busy) || !visibleRef.current || !openedOwnerRef.current) return;
    setLoading(true);
    setLoadError(null);
    const request = beginRead();
    if (reset) {
      setDirectory([]);
      setDirectoryCursor(null);
    }
    try {
      const page = await loadExperts(cursor, request.controller.signal);
      if (!request.isCurrent()) return;
      setDirectory(previous => {
        const base = reset ? [] : previous;
        return page.items.reduce<ExpertDirectoryItem[]>((items, item) =>
          sameIdentity(items, item) ? items : [...items, item], base);
      });
      setDirectoryCursor(page.nextCursor);
    } catch (error) {
      if (request.isCurrent()) setLoadError(catalogLoadError(error, "expert.load_failed"));
    } finally {
      if (request.isCurrent()) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [beginRead, loadExperts, loading]);

  const loadVersionPage = useCallback(async (expert: ExpertDirectoryItem, cursor: string | null, reset = false) => {
    if (loading || (selectBusyRef.current.owner === ownerRef.current && selectBusyRef.current.busy) || !visibleRef.current || !openedOwnerRef.current) return;
    setLoading(true);
    setLoadError(null);
    const request = beginRead();
    if (reset) {
      setVersions([]);
      setVersionCursor(null);
    }
    try {
      const page = await loadVersions(expert.id, cursor, request.controller.signal);
      if (!request.isCurrent()) return;
      setVersions(previous => {
        const base = reset ? [] : previous;
        return page.items.reduce<ExpertChoice[]>((items, item) =>
          sameChoice(items, item) ? items : [...items, item], base);
      });
      setVersionCursor(page.nextCursor);
    } catch (error) {
      if (request.isCurrent()) setLoadError(catalogLoadError(error, "expert.versions_load_failed"));
    } finally {
      if (request.isCurrent()) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [beginRead, loadVersions, loading]);

  const open = () => {
    if (disabled || (selectBusyRef.current.owner === ownerRef.current && selectBusyRef.current.busy)) return;
    openedOwnerRef.current = ownerRef.current;
    directoryRequestedRef.current = false;
    visibleRef.current = true;
    setVisible(true);
    setDirectory([]);
    setDirectoryCursor(null);
    setVersions([]);
    setVersionCursor(null);
    setActiveExpert(null);
    setQuery("");
    setLoadError(null);
    setSelectError(null);
    onOpenChange?.(true);
  };

  useEffect(() => {
    if (!openRequest || handledOpenRequest.current === openRequest) return;
    handledOpenRequest.current = openRequest;
    // Consume unavailable requests too; reconnect must not replay a stale menu action.
    if (!disabled) open();
  }, [openRequest, disabled]);

  useEffect(() => {
    if (!visible || availability !== "ready" || directoryRequestedRef.current) return;
    directoryRequestedRef.current = true;
    void loadDirectoryPage(null, true);
  }, [availability, loadDirectoryPage, visible]);

  const openExpert = (expert: ExpertDirectoryItem) => {
    if (disabled || availability !== "ready" || loading || (selectBusyRef.current.owner === ownerRef.current && selectBusyRef.current.busy)) return;
    setActiveExpert(expert);
    setQuery("");
    setVersions([]);
    setVersionCursor(null);
    setLoadError(null);
    void loadVersionPage(expert, null, true);
  };

  const backToDirectory = () => {
    if (selectBusyRef.current.owner === ownerRef.current && selectBusyRef.current.busy) return;
    stopRead();
    setActiveExpert(null);
    setQuery("");
    setLoadError(null);
  };

  const select = async (choice: ExpertChoice | null) => {
    const clearUnavailableDraft = !nextTurn && availability === "unsupported" && choice === null &&
      selection !== null && selection !== undefined;
    if (disabled || (availability !== "ready" && !clearUnavailableDraft) || selection === undefined ||
        (selectBusyRef.current.owner === ownerRef.current && selectBusyRef.current.busy) || loading) return;
    if (choice && !versions.some(item => sameReference(item.reference, choice.reference))) return;
    if (choice && sameReference(selection?.reference, choice.reference)) {
      close();
      return;
    }
    if (!choice && selection === null) {
      close();
      return;
    }
    const selectionOwner = ownerRef.current;
    if (selectionOwner !== openedOwnerRef.current) return;
    selectBusyRef.current = { owner: selectionOwner, busy: true };
    setSelectBusyState({ owner: selectionOwner, busy: true });
    setSelectError(null);
    onBusyChange?.(true);
    try {
      await onSelect(choice);
      if (ownerRef.current !== selectionOwner || openedOwnerRef.current !== selectionOwner) return;
      close(true);
    } catch (error) {
      if (ownerRef.current === selectionOwner && openedOwnerRef.current === selectionOwner) {
        setSelectError(error instanceof Error ? error.message : t("expert.selection_failed"));
      }
    } finally {
      if (ownerRef.current === selectionOwner) {
        selectBusyRef.current = { owner: selectionOwner, busy: false };
        setSelectBusyState({ owner: selectionOwner, busy: false });
        onBusyChange?.(false);
      }
    }
  };

  const retryCurrent = async () => {
    if (!onRetryCurrent || currentRetrying || availability !== "error") return;
    const retryOwner = ownerRef.current;
    setCurrentRetryState({ owner: retryOwner, retrying: true });
    setSelectError(null);
    try {
      await onRetryCurrent();
    } catch (error) {
      if (ownerRef.current === retryOwner) setSelectError(error instanceof Error ? error.message : t("expert.current_read_failed"));
    } finally {
      if (ownerRef.current === retryOwner) setCurrentRetryState({ owner: retryOwner, retrying: false });
    }
  };

  useEffect(() => {
    return () => {
      requestRef.current?.controller.abort();
      requestRef.current = null;
    };
  }, []);

  const previousOwnerRef = useRef(owner);
  useEffect(() => {
    if (previousOwnerRef.current === owner) return;
    previousOwnerRef.current = owner;
    close(true);
    setDirectory([]);
    setDirectoryCursor(null);
    setVersions([]);
    setVersionCursor(null);
    setActiveExpert(null);
    setQuery("");
    setLoadError(null);
    setSelectError(null);
    selectBusyRef.current = { owner, busy: false };
    setSelectBusyState({ owner, busy: false });
  }, [close, owner]);

  useEffect(() => {
    if (!visible || !openedOwnerRef.current || openedOwnerRef.current === owner) return;
    close(true);
  }, [close, owner, visible]);

  const selectBusy = selectBusyState.owner === owner && selectBusyState.busy;
  useEffect(() => {
    if (disabled && !(selectBusyRef.current.owner === owner && selectBusyRef.current.busy)) close();
  }, [close, disabled, owner]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => {
      if (state !== "active") close(true);
    });
    return () => subscription.remove();
  }, [close]);

  const queryText = query.trim();
  const filteredDirectory = directory.filter(item =>
    searchMatches(item.title, queryText) || searchMatches(item.description, queryText));
  const filteredVersions = versions.filter(item =>
    searchMatches(item.title, queryText) || searchMatches(item.description, queryText));
  const status = availabilityMessage ?? (availability === "ready" ? "" : t(`expert.status_${availability}`));
  const triggerText = selection === undefined
    ? t("expert.selection_unknown_short")
    : selection?.title ?? t("expert.select");
  const accessibilityLabel = selection === undefined
    ? t("expert.selection_unknown")
    : selection ? t("expert.trigger_selected", { p0: selection.title }) : t("expert.select");
  const statusShort = availability === "ready" ? "" : availabilityLabel(availability);
  const canClearUnavailableDraft = !nextTurn && availability === "unsupported" && selection !== null && selection !== undefined;
  const canSelect = !disabled && availability === "ready" && selection !== undefined && !loading && !selectBusy;
  const sheetRefocus = useModalFocusTrap(visible, () => close(), '[data-testid="composer-expert-close"]', true);
  const filteredLoadedNothing = queryText.length > 0 &&
    (activeExpert ? filteredVersions.length === 0 : filteredDirectory.length === 0);
  const hasMore = activeExpert ? versionCursor !== null : directoryCursor !== null;
  const retryList = () => {
    if (loading) return;
    if (activeExpert) void loadVersionPage(activeExpert, versionCursor === null ? null : versionCursor, versionCursor === null);
    else void loadDirectoryPage(directoryCursor === null ? null : directoryCursor, directoryCursor === null);
  };

  return (
    <>
      {!hideTrigger ? <Pressable
        testID="composer-expert-selector"
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={status || (nextTurn ? t("expert.applies_next_turn") : t("expert.applies_when_created"))}
        accessibilityState={{ disabled, selected: selection !== null && selection !== undefined, expanded: visible }}
        aria-expanded={Platform.OS === "web" ? visible : undefined}
        disabled={disabled}
        onPressIn={onTriggerPressIn}
        onPress={open}
        style={[styles.permissionTrigger, { maxWidth: "40%" }, selection && styles.permissionTriggerSelected, disabled && styles.sendDisabled]}
      >
        <Bot size={16} color={disabled ? colors.textDim : colors.textMuted} />
        <View style={styles.expertTriggerCopy}>
          <Text testID="composer-expert-selector-label" numberOfLines={1} ellipsizeMode="tail" style={styles.permissionTriggerLabel}>
            {triggerText}
          </Text>
          {statusShort ? <Text numberOfLines={1} style={styles.expertTriggerStatus}>{statusShort}</Text> : null}
        </View>
      </Pressable> : null}
      <Modal
        testID="task-expert-selector-sheet"
        visible={visible}
        transparent
        animationType={Platform.OS === "web" ? "none" : "slide"}
        onRequestClose={() => close()}
        accessibilityLabel={t("expert.select_title")}
      >
        <View style={{ flex: 1, justifyContent: "flex-end", alignItems: "center" }}>
          <Pressable testID="composer-expert-backdrop" accessibilityRole="button" accessibilityLabel={t("common.close")}
            style={styles.permissionSheetBackdrop} onPress={() => close()} />
          <View ref={sheetRefocus} testID="task-expert-selector-sheet-content" role="dialog" accessibilityViewIsModal
            style={[styles.permissionSheet, { width: "100%", maxWidth: 720, maxHeight: Math.max(0, window.height - insets.top), paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
            <View style={styles.permissionSheetHeader}>
              {activeExpert ? <Pressable testID="composer-expert-back" accessibilityRole="button" accessibilityLabel={t("expert.back_to_experts")}
                disabled={selectBusy} onPress={backToDirectory} style={styles.permissionSheetClose}>
                <ChevronLeft size={20} color={colors.textMuted} />
              </Pressable> : null}
              <View style={{ flex: 1, minWidth: 0, paddingHorizontal: activeExpert ? spacing.xs : spacing.sm }}>
                <Text accessibilityRole="header" style={styles.permissionSheetTitle}>
                  {activeExpert?.title ?? t("expert.select_title")}
                </Text>
                <Text style={styles.permissionSheetSubtitle}>
                  {nextTurn ? t("expert.applies_next_turn") : t("expert.applies_when_created")}
                </Text>
              </View>
              <Pressable testID="composer-expert-close" accessibilityRole="button" accessibilityLabel={t("common.close")}
                disabled={selectBusy} onPress={() => close()} style={styles.permissionSheetClose}>
                <X size={20} color={colors.textMuted} />
              </Pressable>
            </View>
            {availability !== "ready" ? (
              <View>
                <Text testID={availability === "error" ? "composer-expert-current-error" : "composer-expert-status"}
                  accessibilityRole={availability === "error" ? "alert" : undefined}
                  style={styles.expertStatus}>{status}</Text>
                {availability === "error" && onRetryCurrent ? <Pressable testID="composer-expert-retry-current" accessibilityRole="button"
                  accessibilityState={{ disabled: currentRetrying, busy: currentRetrying }} disabled={currentRetrying}
                  onPress={() => void retryCurrent()} style={styles.expertRetryButton}>
                  {currentRetrying ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
                  <Text style={styles.expertRetryText}>{currentRetrying ? t("expert.checking_current") : t("expert.retry_current")}</Text>
                </Pressable> : null}
              </View>
            ) : null}
            <View style={styles.expertSearch}>
              <Search size={16} color={colors.textDim} />
              <TextInput testID="composer-expert-search" accessibilityLabel={t("expert.search")}
                value={query} onChangeText={setQuery} editable={!loading && !selectBusy}
                placeholder={t("expert.search")} placeholderTextColor={colors.textDim}
                returnKeyType="search" style={styles.expertSearchInput} />
            </View>
            {loadError ? <Text testID="composer-expert-load-error" accessibilityRole="alert" style={styles.expertStatus}>{loadError}</Text> : null}
            {selectError ? <Text testID="composer-expert-selection-error" accessibilityRole="alert" style={styles.expertStatus}>{selectError}</Text> : null}
            <ScrollView
              testID={activeExpert ? "composer-expert-versions" : "composer-expert-list"}
              style={styles.modelPickerList}
              contentContainerStyle={styles.modelPickerContent}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              {!activeExpert ? <Pressable testID="composer-expert-none" accessibilityRole="radio"
                accessibilityState={{ checked: selection === null, disabled: !canSelect && !canClearUnavailableDraft }}
                aria-checked={Platform.OS === "web" ? selection === null : undefined}
                disabled={!canSelect && !canClearUnavailableDraft} onPress={() => void select(null)} style={[styles.permissionOption, selection === null && styles.permissionOptionSelected]}>
                <View style={styles.expertOptionCopy}>
                  <Text style={styles.permissionOptionText}>{t("expert.no_expert")}</Text>
                  <Text style={styles.expertOptionDescription}>{t("expert.no_expert_description")}</Text>
                </View>
                {selection === null ? <Check size={18} color={colors.text} /> : null}
              </Pressable> : null}
              {activeExpert ? filteredVersions.map((item, index) => {
                const checked = Boolean(selection && sameReference(selection.reference, item.reference));
                return <Pressable key={index}
                  testID={`composer-expert-option-${index}`} accessibilityRole="radio"
                  accessibilityLabel={item.description ? `${item.title}. ${item.description}` : item.title}
                  accessibilityState={{ checked, disabled: !canSelect }}
                  aria-checked={Platform.OS === "web" ? checked : undefined}
                  disabled={!canSelect} onPress={() => void select(item)} style={[styles.permissionOption, checked && styles.permissionOptionSelected]}>
                  <View style={styles.expertOptionCopy}>
                    <Text style={styles.permissionOptionText}>{item.title}</Text>
                    {item.description ? <Text style={styles.expertOptionDescription}>{item.description}</Text> : null}
                  </View>
                  {checked ? <Check size={18} color={colors.text} /> : null}
                </Pressable>;
              }) : filteredDirectory.map((item, index) => {
                const selected = Boolean(selection && selection.reference.id === item.id);
                return <Pressable key={item.id} testID={`composer-expert-item-${index}`} accessibilityRole="button"
                  accessibilityLabel={item.description ? `${item.title}. ${item.description}` : item.title}
                  accessibilityState={{ selected, disabled: disabled || availability !== "ready" || loading || selectBusy }}
                  disabled={disabled || availability !== "ready" || loading || selectBusy} onPress={() => openExpert(item)}
                  style={[styles.permissionOption, selected && styles.permissionOptionSelected]}>
                  <View style={styles.expertOptionCopy}>
                    <Text style={styles.permissionOptionText}>{item.title}</Text>
                    {item.description ? <Text style={styles.expertOptionDescription}>{item.description}</Text> : null}
                  </View>
                  <ChevronLeft style={{ transform: [{ rotate: "180deg" }] }} size={18} color={colors.textDim} />
                </Pressable>;
              })}
              {activeExpert && !loading && !loadError && versions.length === 0 && !queryText ? <Text testID="composer-expert-versions-empty" style={styles.modelPickerEmpty}>{t("expert.no_versions")}</Text> : null}
              {!activeExpert && availability === "ready" && !loading && !loadError && directory.length === 0 && directoryCursor === null && !queryText ? <Text testID="composer-expert-empty" style={styles.modelPickerEmpty}>{t("expert.no_saved_experts")}</Text> : null}
              {availability === "ready" && filteredLoadedNothing && !loading ? <Text testID="composer-expert-search-empty" style={styles.modelPickerEmpty}>
                {hasMore ? t("expert.search_more_results") : t("expert.no_search_results")}
              </Text> : null}
              {loading ? <View testID="composer-expert-loading" style={styles.expertLoading}><ActivityIndicator size="small" color={colors.textMuted} />
                <Text style={styles.expertStatus}>{activeExpert ? t("expert.loading_versions") : t("expert.loading_experts")}</Text></View> : null}
            </ScrollView>
            {hasMore && !loadError ? <Pressable testID={activeExpert ? "composer-expert-load-more-versions" : "composer-expert-load-more-experts"}
              accessibilityRole="button" accessibilityState={{ disabled: loading }} disabled={loading}
              onPress={() => activeExpert ? void loadVersionPage(activeExpert, versionCursor, false) : void loadDirectoryPage(directoryCursor, false)}
              style={styles.expertRetryButton}>
              <Text style={styles.expertRetryText}>{activeExpert ? t("expert.load_more_versions") : t("expert.load_more_experts")}</Text>
            </Pressable> : null}
            {loadError ? <Pressable testID="composer-expert-retry-list" accessibilityRole="button" accessibilityState={{ disabled: loading }} disabled={loading}
              onPress={retryList} style={styles.expertRetryButton}>
              <Text style={styles.expertRetryText}>{loading ? t("expert.loading") : t("expert.retry")}</Text>
            </Pressable> : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

export type LiveTaskExpertSelectorProps = Omit<TaskExpertSelectorProps,
  "disabled" | "loadExperts" | "loadVersions" | "onSelect" | "onRetryCurrent" | "selection" | "availability" | "availabilityMessage"> & {
  busyOwner: object;
  task: TaskRuntime;
  snapshot: TaskSnapshot;
  scopeActive: boolean;
};

type ExpertReadState =
  | { owner: object; phase: "loading" }
  | { owner: object; phase: "error"; error: string }
  | { owner: object; phase: "ready"; result: ThreadExpertResult };

export function LiveTaskExpertSelector({ task, snapshot, scopeActive, busyOwner, ...props }: LiveTaskExpertSelectorProps) {
  const language = useLocale();
  const owner = props.owner;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const busyOwnerRef = useRef(busyOwner);
  busyOwnerRef.current = busyOwner;
  const scopeActiveRef = useRef(scopeActive);
  scopeActiveRef.current = scopeActive;
  const client = task.client;
  const clientGeneration = task.clientGeneration;
  const runtimeInstanceNonce = task.runtimeInstanceNonce;
  const reconnectContext = task.reconnectContext;
  const threadId = snapshot.threadId;
  const cwd = snapshot.cwd;
  const archivedAt = snapshot.archivedAt;
  const configurationReady = snapshot.configurationReady;
  const isCurrentOwner = useCallback(() => ownerRef.current === owner && scopeActiveRef.current &&
    task.client === client && task.clientGeneration === clientGeneration &&
    task.runtimeInstanceNonce === runtimeInstanceNonce && task.reconnectContext === reconnectContext &&
    task.snapshot.threadId === threadId && task.snapshot.cwd === cwd && task.snapshot.connected &&
    task.snapshot.archivedAt === archivedAt && task.snapshot.configurationReady === configurationReady &&
    configurationReady !== false && !archivedAt && !task.isDisposed(),
  [archivedAt, client, clientGeneration, configurationReady, cwd, owner, reconnectContext, runtimeInstanceNonce, task, threadId]);
  const [readState, setReadState] = useState<ExpertReadState>({ owner, phase: "loading" });
  const [mutationState, setMutationState] = useState<{ owner: object; locked: boolean }>({ owner: busyOwner, locked: false });
  const mutationUnknownRef = useRef<{ owner: object; locked: boolean }>({ owner: busyOwner, locked: false });
  const inFlightRef = useRef<{ busyOwner: object; owner: object; phase: "pending" | "unknown" } | null>(null);
  const mutationPending = (mutationState.owner === busyOwner && mutationState.locked) ||
    inFlightRef.current?.busyOwner === busyOwner;
  const readControllerRef = useRef<AbortController | null>(null);
  const supported = task.supportsExperts();
  const canRead = scopeActive && snapshot.connected && snapshot.configurationReady !== false &&
    !snapshot.archivedAt && supported && !task.isDisposed();
  const state = readState.owner === owner ? readState : { owner, phase: "loading" as const };
  const onBusyChange = props.onBusyChange;
  const setMutationLock = useCallback((ownerAtStart: object, locked: boolean) => {
    if (busyOwnerRef.current !== ownerAtStart) return;
    mutationUnknownRef.current = { owner: ownerAtStart, locked };
    setMutationState({ owner: ownerAtStart, locked });
    const inFlight = inFlightRef.current?.busyOwner === ownerAtStart && inFlightRef.current.phase === "pending";
    onBusyChange?.(locked || inFlight);
  }, [onBusyChange]);
  const selectorBusyChange = useCallback((busy: boolean) => {
    if (busyOwnerRef.current !== busyOwner) return;
    const locked = mutationUnknownRef.current.owner === busyOwner && mutationUnknownRef.current.locked;
    const inFlight = inFlightRef.current?.busyOwner === busyOwner && inFlightRef.current.phase === "pending";
    onBusyChange?.(busy || locked || inFlight);
  }, [busyOwner, onBusyChange]);

  const readCurrent = useCallback(async (ownerAtStart: object) => {
    if (ownerAtStart !== owner || !isCurrentOwner()) return null;
    readControllerRef.current?.abort();
    const controller = new AbortController();
    readControllerRef.current = controller;
    setReadState({ owner: ownerAtStart, phase: "loading" });
    try {
      const result = await task.readExpert(controller.signal);
      if (ownerAtStart !== owner || !isCurrentOwner() || controller.signal.aborted || result.threadId !== threadId) return null;
      setReadState({ owner: ownerAtStart, phase: "ready", result });
      const flight = inFlightRef.current;
      const stillInFlight = flight?.busyOwner === busyOwner && flight.phase === "pending";
      if (!stillInFlight) {
        if (flight?.busyOwner === busyOwner) inFlightRef.current = null;
        if (mutationUnknownRef.current.owner === busyOwner && mutationUnknownRef.current.locked) {
          mutationUnknownRef.current = { owner: busyOwner, locked: false };
          setMutationState({ owner: busyOwner, locked: false });
        }
        onBusyChange?.(false);
      }
      return result;
    } catch {
      if (ownerAtStart !== owner || !isCurrentOwner() || controller.signal.aborted) return null;
      setReadState({ owner: ownerAtStart, phase: "error", error: t("expert.current_read_failed") });
      throw new Error(t("expert.current_read_failed"));
    } finally {
      if (readControllerRef.current === controller) readControllerRef.current = null;
    }
  }, [busyOwner, isCurrentOwner, onBusyChange, owner, task, threadId]);

  useEffect(() => {
    readControllerRef.current?.abort();
    if (!canRead || !isCurrentOwner()) {
      if (snapshot.archivedAt || !supported || !snapshot.connected || snapshot.configurationReady === false) return;
      setReadState({ owner, phase: "loading" });
      return;
    }
    void readCurrent(owner).catch(() => {});
    const controller = readControllerRef.current;
    return () => {
      if (controller && readControllerRef.current === controller) {
        controller.abort();
        readControllerRef.current = null;
      }
    };
  }, [canRead, isCurrentOwner, owner, readCurrent, snapshot.archivedAt, snapshot.connected, snapshot.configurationReady, supported]);

  useEffect(() => () => readControllerRef.current?.abort(), []);

  const loadExperts = useCallback((cursor: string | null, signal: AbortSignal) => {
    if (!isCurrentOwner()) return Promise.reject(new Error(t("expert.current_read_failed")));
    return task.listExperts(language, cursor ?? undefined, signal);
  }, [isCurrentOwner, language, task]);
  const loadVersions = useCallback((expertId: string, cursor: string | null, signal: AbortSignal) => {
    if (!isCurrentOwner()) return Promise.reject(new Error(t("expert.current_read_failed")));
    return task.listExpertVersions(expertId, cursor ?? undefined, signal);
  }, [isCurrentOwner, task]);

  const retryCurrent = useCallback(async () => {
    if (!canRead || !isCurrentOwner()) throw new Error(t("expert.current_read_failed"));
    const result = await readCurrent(owner);
    if (!result) throw new Error(t("expert.current_read_failed"));
  }, [canRead, isCurrentOwner, owner, readCurrent]);

  const choose = useCallback(async (choice: ExpertChoice | null) => {
    if (!isCurrentOwner()) return;
    const before = readState.owner === owner && readState.phase === "ready" ? readState.result : null;
    if (!canRead || !before || before.threadId !== threadId ||
        (mutationUnknownRef.current.owner === busyOwner && mutationUnknownRef.current.locked) ||
        inFlightRef.current?.busyOwner === busyOwner)
      throw new Error(t("expert.current_read_failed"));
    const desired = choice?.reference ?? null;
    inFlightRef.current = { busyOwner, owner, phase: "pending" };
    try {
      const result = await task.selectExpert(desired, before.revision);
      if (!isCurrentOwner() || result.threadId !== threadId) {
        if (inFlightRef.current?.owner === owner) inFlightRef.current = { busyOwner, owner, phase: "unknown" };
        setMutationLock(busyOwner, true);
        return;
      }
      if (inFlightRef.current?.owner === owner) inFlightRef.current = null;
      setReadState({ owner, phase: "ready", result });
      setMutationLock(busyOwner, false);
      return;
    } catch {
      if (inFlightRef.current?.owner === owner) inFlightRef.current = { busyOwner, owner, phase: "unknown" };
      setMutationLock(busyOwner, true);
      if (!isCurrentOwner()) return;
      if (busyOwnerRef.current !== busyOwner) return;
      let observed: ThreadExpertResult | null;
      try {
        observed = await readCurrent(owner);
      } catch {
        throw new Error(t("expert.current_read_failed"));
      }
      if (!observed || observed.threadId !== threadId) throw new Error(t("expert.current_read_failed"));
      const matches = desired === null
        ? observed.expert === null || observed.expert === undefined
        : observed.expert?.definition?.id === desired.id &&
          observed.expert.definition.version === desired.version &&
          observed.expert.definition.definitionSha256 === desired.definitionSha256;
      if (matches) return;
      throw new Error(t("expert.selection_conflict"));
    }
  }, [busyOwner, canRead, isCurrentOwner, owner, readCurrent, readState, setMutationLock, task, threadId]);

  const availability: ExpertAvailability = snapshot.archivedAt ? "archived"
    : !snapshot.connected ? "disconnected"
    : snapshot.configurationReady === false || !scopeActive ? "loading"
    : !supported ? "unsupported"
    : state.phase;
  const selection: ExpertChoice | null | undefined = !mutationPending && state.phase === "ready"
    ? state.result.expert ? { reference: state.result.expert.definition,
      title: `${state.result.expert.title} · ${state.result.expert.definition.version}` } : null
    : undefined;
  const disabled = !scopeActive || !snapshot.connected || Boolean(snapshot.archivedAt) ||
    snapshot.configurationReady === false || !supported || (state.phase === "loading" && !mutationPending && !props.openRequest);
  const effectiveAvailability = snapshot.archivedAt || !snapshot.connected ? availability
    : mutationPending ? "error" : availability;
  const availabilityMessage = effectiveAvailability === "ready"
    ? t("expert.applies_next_turn")
    : effectiveAvailability === "error" && state.phase === "error" ? state.error
    : mutationPending ? t("expert.current_read_failed") : t(`expert.status_${effectiveAvailability}`);

  return <TaskExpertSelector {...props} owner={owner} selection={selection} disabled={disabled}
    availability={effectiveAvailability} availabilityMessage={availabilityMessage}
    loadExperts={loadExperts} loadVersions={loadVersions} onSelect={choose} onRetryCurrent={retryCurrent}
    onBusyChange={selectorBusyChange} nextTurn />;
}
