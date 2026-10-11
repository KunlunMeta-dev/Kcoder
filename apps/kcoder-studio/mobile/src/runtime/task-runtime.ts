/** Stable mobile task-runtime API; implementation is owned by domain modules. */
export { taskRuntimeTestHelpers } from "./task-runtime/connectionFactory";
export { TaskRuntime } from "./task-runtime/core";
export { mergeReconciledMessages } from "./task-runtime/history";
export {
  defaultModelOption,
  listModels,
  modelOptionSelector,
  selectedModelOption,
  threadModelSelector,
} from "./task-runtime/modelCatalog";
export type { ModelOption } from "./task-runtime/modelCatalog";
export { taskRuntimeRegistry } from "./task-runtime/registry";
export { TaskTerminalSession } from "./task-runtime/terminalLeases";
export type {
  TaskTerminalOutputEvent,
  TaskTerminalSnapshot,
} from "./task-runtime/terminalLeases";
export {
  ThreadListPager,
  deleteStoredThread,
  listThreads,
  mapThreadListScopes,
  subscribeThreadMutations,
  threadMutationServerIdentity,
  updateThreadMetadata,
} from "./task-runtime/threadDirectory";
export type { ThreadMutationEvent } from "./task-runtime/threadDirectory";
export type {
  ThreadListFilter,
  ThreadListPage,
} from "./task-runtime/threadDirectory";
export type {
  AgentSteerResult,
  AssistantTranscriptBlock,
  ApprovalInteraction,
  ChatMessage,
  FileChangesView,
  GoalMode,
  GoalStatus,
  InteractionSummaryView,
  PendingInteraction,
  QuestionInteraction,
  QuestionOption,
  QuestionView,
  StagedAttachment,
  TaskActivityView,
  TaskSnapshot,
  ThreadCompactResult,
  ThreadGoal,
  TodoView,
  ToolCallView,
} from "./task-runtime/types";
export {
  archiveManagedWorktree,
  forgetManagedWorktree,
  listManagedWorktrees,
  listWorkspaceOptions,
  openWorkspace,
  openWorkspaceWithReceipt,
  prepareManagedWorktree,
  prepareManagedWorktreeWithReceipt,
  previewManagedWorktreeArchive,
  restoreManagedWorktree,
  listWorkspaceThreadScopes,
  workspaceThreadScopeIdentity,
  workspaceThreadScopeServers,
} from "./task-runtime/workspaces";
export type {
  ManagedWorktree,
  ManagedWorktreeArchivePreview,
  WorkspaceOption,
  WorkspaceThreadScopes,
} from "./task-runtime/workspaces";
