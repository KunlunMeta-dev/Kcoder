import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Clock3, File, Folder, RefreshCw, Search, X } from "lucide-react-native";
import type { TaskRuntime } from "@/runtime/task-runtime";
import { EmptyState } from "./ui";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import {
  joinWorkspacePath,
  workspacePathName,
  workspacePathParent,
  workspaceRelativePath,
} from "./workspace-path";
import {
  searchWorkspacePaths,
  WorkspaceSearchQueryTooLongError,
  workspaceRecentFilesForRoot,
  type WorkspaceFileEntry,
} from "./workspace-file-discovery";

type DiscoveryMode = "browse" | "search" | "recent";

export function WorkspaceFileDiscoveryPanel({
  task,
  ownerKey,
  root,
  path,
  entries,
  loading,
  error,
  recentFilesError,
  demo,
  recentFiles,
  onRefresh,
  onLoadTree,
  onOpenFile,
}: {
  task: TaskRuntime;
  ownerKey: string;
  root: string;
  path: string;
  entries: WorkspaceFileEntry[];
  loading: boolean;
  error: string | null;
  recentFilesError: string | null;
  demo: boolean;
  recentFiles: string[];
  onRefresh(): void;
  onLoadTree(path: string): void;
  onOpenFile(entry: WorkspaceFileEntry): Promise<boolean>;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [mode, setMode] = useState<DiscoveryMode>("browse");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceFileEntry[]>([]);
  const [searchResultsQuery, setSearchResultsQuery] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchGeneration = useRef(0);
  const recentPaths = useMemo(
    () => workspaceRecentFilesForRoot(root, recentFiles),
    [recentFiles, root],
  );
  const breadcrumbs = useMemo(() => {
    const rootName = workspacePathName(root) || root;
    const relative = workspaceRelativePath(root, path)
      .split("/")
      .filter(Boolean);
    return [
      { label: rootName, path: root },
      ...relative.map((label, index) => ({
        label,
        path: joinWorkspacePath(root, relative.slice(0, index + 1).join("/")),
      })),
    ];
  }, [path, root]);
  const sortedEntries = useMemo(
    () =>
      [...entries].sort(
        (left, right) =>
          Number(right.is_directory) - Number(left.is_directory) ||
          left.name.localeCompare(right.name),
      ),
    [entries],
  );
  const recentEntries = useMemo<WorkspaceFileEntry[]>(
    () =>
      recentPaths.map((filePath) => ({
        path: filePath,
        name: workspacePathName(filePath),
        is_directory: false,
      })),
    [recentPaths],
  );

  useEffect(() => {
    searchGeneration.current += 1;
    setSearchResults([]);
    setSearchResultsQuery(null);
    setSearchError(null);
    setSearching(false);
    if (demo) {
      setMode("browse");
      setQuery("");
    }
  }, [demo, ownerKey, root, task]);

  useEffect(() => {
    const generation = ++searchGeneration.current;
    const normalizedQuery = query.trim();
    setSearchError(null);
    if (demo || mode !== "search" || !normalizedQuery) {
      setSearchResults([]);
      setSearchResultsQuery(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const requestTask = task;
    const requestRoot = root;
    const requestOwnerKey = ownerKey;
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      void searchWorkspacePaths(requestTask, requestRoot, normalizedQuery)
        .then((results) => {
          if (
            cancelled ||
            generation !== searchGeneration.current ||
            task !== requestTask ||
            root !== requestRoot ||
            ownerKey !== requestOwnerKey
          )
            return;
          setSearchResults(results);
          setSearchResultsQuery(normalizedQuery);
        })
        .catch((reason: unknown) => {
          if (
            cancelled ||
            generation !== searchGeneration.current ||
            task !== requestTask ||
            root !== requestRoot ||
            ownerKey !== requestOwnerKey
          )
            return;
          setSearchResults([]);
          setSearchResultsQuery(null);
          setSearchError(
            reason instanceof WorkspaceSearchQueryTooLongError
              ? t("task.search_query_too_long")
              : reason instanceof Error
                ? reason.message
                : String(reason),
          );
        })
        .finally(() => {
          if (
            !cancelled &&
            generation === searchGeneration.current &&
            task === requestTask &&
            root === requestRoot &&
            ownerKey === requestOwnerKey
          )
            setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (searchGeneration.current === generation) searchGeneration.current += 1;
    };
  }, [demo, mode, ownerKey, query, root, task]);

  const visibleSearchResults =
    searchResultsQuery === query.trim() ? searchResults : [];

  const displayedCount =
    mode === "search"
      ? visibleSearchResults.length
      : mode === "recent"
        ? recentEntries.length
        : sortedEntries.length;

  const openEntry = (entry: WorkspaceFileEntry) => {
    if (entry.is_directory) {
      setMode("browse");
      onLoadTree(entry.path);
      return;
    }
    void onOpenFile(entry);
  };

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <View style={styles.title}>
          <Folder size={16} color={colors.textMuted} />
          <Text style={styles.titleText}>{t("task.files")}</Text>
          <Text style={styles.count}>{displayedCount}</Text>
        </View>
        <Pressable
          accessibilityLabel={
            mode === "search" ? t("task.close_file_search") : t("task.search_files")
          }
          accessibilityState={{ selected: mode === "search", disabled: demo }}
          disabled={demo}
          onPress={() => {
            setMode((current) => (current === "search" ? "browse" : "search"));
            setQuery("");
          }}
          style={styles.iconButton}
          testID="workspace-path-search-toggle"
        >
          {mode === "search" ? (
            <X size={17} color={colors.textMuted} />
          ) : (
            <Search size={17} color={colors.textMuted} />
          )}
        </Pressable>
        <Pressable
          accessibilityLabel={t("task.recent_files")}
          accessibilityState={{ selected: mode === "recent" }}
          onPress={() => setMode((current) => (current === "recent" ? "browse" : "recent"))}
          style={styles.iconButton}
          testID="workspace-recent-files-toggle"
        >
          <Clock3 size={17} color={mode === "recent" ? colors.blue : colors.textMuted} />
        </Pressable>
        {mode === "browse" ? (
          <Pressable
            accessibilityLabel={t("task.refresh")}
            disabled={loading}
            onPress={onRefresh}
            style={styles.iconButton}
          >
            <RefreshCw size={17} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {mode === "search" ? (
        <>
          <View style={styles.searchRow}>
            <Search size={15} color={colors.textDim} />
            <TextInput
              testID="file-search"
              value={query}
              onChangeText={setQuery}
              autoFocus
              placeholder={t("task.search_workspace_paths")}
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.searchInput}
            />
            {query ? (
              <Pressable
                accessibilityLabel={t("task.clear_search")}
                onPress={() => setQuery("")}
                style={styles.searchClear}
              >
                <X size={15} color={colors.textDim} />
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.searchHint}>{t("task.search_paths_only")}</Text>
        </>
      ) : null}
      {mode === "browse" ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.breadcrumbBar}
          contentContainerStyle={styles.breadcrumbContent}
        >
          {breadcrumbs.map((crumb, index) => (
            <View key={crumb.path} style={styles.breadcrumbItem}>
              {index > 0 ? <Text style={styles.breadcrumbSeparator}>/</Text> : null}
              <Pressable
                disabled={crumb.path === path}
                onPress={() => onLoadTree(crumb.path)}
                style={styles.breadcrumbButton}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.breadcrumbText,
                    crumb.path === path && styles.breadcrumbActive,
                  ]}
                >
                  {crumb.label}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}
      {mode === "browse" && loading ? (
        <ActivityIndicator style={styles.loader} color={colors.textMuted} />
      ) : mode === "search" && searching ? (
        <ActivityIndicator style={styles.loader} color={colors.textMuted} />
      ) : (
        <FlatList
          testID={
            mode === "search"
              ? "workspace-path-search-results"
              : mode === "recent"
                ? "workspace-recent-files"
                : "file-tree-list"
          }
          style={styles.list}
          data={
            mode === "search"
              ? visibleSearchResults
              : mode === "recent"
                ? recentEntries
                : sortedEntries
          }
          keyExtractor={(entry) => entry.path}
          initialNumToRender={18}
          maxToRenderPerBatch={18}
          windowSize={9}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            mode === "browse" && path !== root ? (
              <Pressable
                accessibilityLabel={t("task.parent_directory")}
                onPress={() => onLoadTree(workspacePathParent(root, path))}
                style={styles.entry}
              >
                <Folder size={19} color={colors.textMuted} />
                <Text style={styles.entryName}>..</Text>
              </Pressable>
            ) : undefined
          }
          ListEmptyComponent={
            <EmptyState
              icon={
                mode === "recent" ? (
                  <Clock3 size={42} color={colors.textDim} />
                ) : (
                  <Folder size={42} color={colors.textDim} />
                )
              }
              title={
                mode === "search"
                  ? query.trim()
                    ? t("task.no_matching_files")
                    : t("task.enter_path_search")
                  : mode === "recent"
                    ? t("task.no_recent_files")
                    : t("task.empty_directory")
              }
              body={
                mode === "search"
                  ? searchError ??
                    (query.trim() ? t("task.no_workspace_paths_matching") : t("task.search_paths_only"))
                  : mode === "recent"
                    ? t("task.opened_files_appear_here")
                    : t("task.this_directory_has_no_files_to_display")
              }
            />
          }
          renderItem={({ item: entry }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${entry.is_directory ? t("task.directory") : t("task.file")} ${entry.name}, ${workspaceRelativePath(root, entry.path)}`}
              onPress={() => openEntry(entry)}
              style={styles.entry}
            >
              {entry.is_directory ? (
                <Folder size={19} color={colors.blue} />
              ) : (
                <File size={19} color={colors.textMuted} />
              )}
              <View style={styles.entryCopy}>
                <Text style={styles.entryName} numberOfLines={1}>
                  {entry.name}
                </Text>
                {mode !== "browse" ? (
                  <Text style={styles.entryPath} numberOfLines={1}>
                    {workspaceRelativePath(root, entry.path)}
                  </Text>
                ) : null}
              </View>
              {!entry.is_directory && entry.size !== undefined ? (
                <Text style={styles.entrySize}>
                  {Math.max(1, Math.round(entry.size / 1024))} KB
                </Text>
              ) : null}
            </Pressable>
          )}
        />
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {recentFilesError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {recentFilesError}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1 },
    toolbar: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      paddingLeft: spacing.md,
      paddingRight: spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    title: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm },
    titleText: { color: colors.text, fontSize: 13, fontWeight: "600" },
    count: { color: colors.textDim, fontSize: 11 },
    iconButton: {
      width: 40,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.sm,
    },
    searchRow: {
      minHeight: 46,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    searchInput: { flex: 1, color: colors.text, fontSize: 14, paddingVertical: spacing.sm },
    searchClear: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
    searchHint: { color: colors.textDim, fontSize: 11, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
    breadcrumbBar: {
      flexGrow: 0,
      height: 44,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    breadcrumbContent: { alignItems: "center", paddingHorizontal: spacing.sm },
    breadcrumbItem: { flexDirection: "row", alignItems: "center" },
    breadcrumbSeparator: { color: colors.textDim, fontSize: 12 },
    breadcrumbButton: { minHeight: 44, maxWidth: 150, justifyContent: "center", paddingHorizontal: spacing.sm },
    breadcrumbText: { color: colors.textDim, fontSize: 11 },
    breadcrumbActive: { color: colors.text, fontWeight: "600" },
    list: { flex: 1 },
    loader: { marginTop: spacing.xl },
    entry: {
      minHeight: 50,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    entryCopy: { flex: 1 },
    entryName: { color: colors.text, fontSize: 14 },
    entryPath: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    entrySize: { color: colors.textDim, fontSize: 10 },
    error: { color: colors.red, fontSize: 12, padding: spacing.sm },
  });
