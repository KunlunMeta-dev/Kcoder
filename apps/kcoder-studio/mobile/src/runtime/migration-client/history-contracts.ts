import { UPLOAD_COLLECTION_CALLS, type UploadCollectionCalls } from './upload-collection-contracts';
import * as C from "../../../../shared/generated/contracts";

export interface HistoricalCalls extends UploadCollectionCalls {
  historyCreate: [C.MigrationHistoryCreateParams, C.MigrationHistoryJobResult];
  historySearch: [C.MigrationHistorySearchParams, C.MigrationHistorySearchResult];
  archiveText: [C.MigrationTranscriptTextParams, C.MigrationTranscriptTextResult];
  historyJobs: [C.MigrationJobsListParams, C.MigrationHistoryJobsResult];
  historyRead: [C.MigrationOperationParams, C.MigrationHistoryJobResult];
  historyRun: [C.MigrationHistoryRunParams, C.MigrationHistoryJobResult];
  historyResume: [C.MigrationHistoryRunParams, C.MigrationHistoryJobResult];
  historyCancel: [C.MigrationOperationParams, C.MigrationHistoryJobResult];
  reinterpretPreview: [C.MigrationHistoryReinterpretPreviewParams, C.MigrationHistoryReinterpretPreviewResult];
  reinterpretCreate: [C.MigrationHistoryReinterpretCreateParams, C.MigrationHistoryJobResult];
  branchPrepare: [C.MigrationBranchPrepareParams, C.MigrationBranchStateResult];
  branchRead: [C.MigrationBranchReadParams, C.MigrationBranchStateResult];
  branchRun: [C.MigrationBranchOperationParams, C.MigrationBranchStateResult];
  branchResume: [C.MigrationBranchResumeParams, C.MigrationBranchStateResult];
  branchCancel: [C.MigrationBranchOperationParams, C.MigrationBranchCancelResult];
  branchPage: [C.MigrationBranchPageParams, C.MigrationBranchPageResult];
  branchBlocks: [C.MigrationBranchBlocksParams, C.MigrationTranscriptBlocksResult];
  branchText: [C.MigrationBranchTextParams, C.MigrationTranscriptTextResult];
  toolsRead: [C.MigrationBranchOperationParams, C.MigrationBranchToolsStateResult];
  toolsRun: [C.MigrationBranchOperationParams, C.MigrationBranchToolsStateResult];
  toolsResume: [C.MigrationBranchResumeParams, C.MigrationBranchToolsStateResult];
  toolsCancel: [C.MigrationBranchOperationParams, C.MigrationBranchToolsStateResult];
  toolsPage: [C.MigrationBranchToolsPageParams, C.MigrationBranchToolsPageResult];
  attachmentRead: [C.MigrationHistoryAttachmentParams, C.MigrationHistoryAttachmentStateResult];
  attachmentRun: [C.MigrationHistoryAttachmentParams, C.MigrationHistoryAttachmentStateResult];
  attachmentResume: [C.MigrationHistoryAttachmentResumeParams, C.MigrationHistoryAttachmentStateResult];
  attachmentCancel: [C.MigrationHistoryAttachmentParams, C.MigrationHistoryAttachmentStateResult];
  attachmentChunk: [C.MigrationHistoryAttachmentChunkParams, C.MigrationHistoryAttachmentChunkResult];
  toolAttachmentRead: [C.MigrationHistoryAttachmentParams, C.MigrationHistoryAttachmentStateResult];
  toolAttachmentRun: [C.MigrationHistoryAttachmentParams, C.MigrationHistoryAttachmentStateResult];
  toolAttachmentResume: [C.MigrationHistoryAttachmentResumeParams, C.MigrationHistoryAttachmentStateResult];
  toolAttachmentCancel: [C.MigrationHistoryAttachmentParams, C.MigrationHistoryAttachmentStateResult];
  toolAttachmentChunk: [C.MigrationHistoryAttachmentChunkParams, C.MigrationHistoryAttachmentChunkResult];
  toolAttachmentItems: [C.MigrationHistoryToolAttachmentItemsParams, C.MigrationHistoryToolAttachmentItemsResult];
  localPrepare: [C.MigrationLocalAttachmentPrepareParams, C.MigrationLocalAttachmentStateResult];
  localRead: [C.MigrationLocalAttachmentReadParams, C.MigrationLocalAttachmentStateResult];
  localBegin: [C.MigrationLocalAttachmentBeginParams, C.MigrationLocalAttachmentStateResult];
  localPart: [C.MigrationLocalAttachmentPartParams, C.MigrationLocalAttachmentStateResult];
  localFinish: [C.MigrationLocalAttachmentRunParams, C.MigrationLocalAttachmentStateResult];
  localResume: [C.MigrationLocalAttachmentRunParams, C.MigrationLocalAttachmentStateResult];
  localRun: [C.MigrationLocalAttachmentRunParams, C.MigrationLocalAttachmentStateResult];
  localCancel: [C.MigrationLocalAttachmentReadParams, C.MigrationLocalAttachmentStateResult];
  localList: [C.MigrationLocalAttachmentListParams, C.MigrationLocalAttachmentListResult];
  localChunk: [C.MigrationLocalAttachmentChunkParams, C.MigrationHistoryAttachmentChunkResult];
  continuationCreate: [C.MigrationContinuationCreateParams, C.MigrationContinuationStateResult];
  continuationRead: [C.MigrationContinuationReadParams, C.MigrationContinuationStateResult];
  continuationRun: [C.MigrationContinuationRunParams, C.MigrationContinuationStateResult];
  continuationResume: [C.MigrationContinuationRunParams, C.MigrationContinuationStateResult];
  continuationCancel: [C.MigrationContinuationReadParams, C.MigrationContinuationStateResult];
  continuationSource: [C.MigrationContinuationSourceParams, C.MigrationContinuationSourceResult];
  undoLookup: [C.MigrationHistoryUndoLookupParams, C.MigrationHistoryUndoLookupResult];
  undoPreview: [C.MigrationHistoryUndoPreviewParams, C.MigrationHistoryUndoPreviewResult];
  undoCreate: [C.MigrationHistoryUndoCreateParams, C.MigrationHistoryUndoStateResult];
  undoRead: [C.MigrationHistoryUndoReadParams, C.MigrationHistoryUndoStateResult];
  undoRun: [C.MigrationHistoryUndoRunParams, C.MigrationHistoryUndoStateResult];
  undoCancel: [C.MigrationHistoryUndoReadParams, C.MigrationHistoryUndoStateResult];
}
interface Rule { method: string; caps: string[]; read: boolean; params(value: unknown): boolean; result(value: unknown): boolean; rows?: string[] }
const rule = (method: string, cap: string, read: boolean, params: Rule["params"], result: Rule["result"], rows?: string[]): Rule => ({ method: "migration/history/" + method, caps: [cap], read, params, result, rows });
const branch = "migrationHistoryBranchesV1", tools = "migrationBranchToolsV1", attachments = "migrationHistoryAttachmentsV1", nested = "migrationHistoryToolAttachmentsV1", local = "migrationLocalAttachmentsV1", continuation = "migrationContinuationV1", undo = "migrationContinuationUndoV1";
export const HISTORICAL_CALLS: Record<keyof HistoricalCalls, Rule> = {
  ...UPLOAD_COLLECTION_CALLS,
  historyCreate: rule("create", "migrationHistoryResourceBudgetV1", false, C.isMigrationHistoryCreateParams, C.isMigrationHistoryJobResult),
  historySearch: rule("search", "migrationHistorySearchV1", true, C.isMigrationHistorySearchParams, C.isMigrationHistorySearchResult, ["items"]),
  archiveText: rule("text", "migrationHistoryReadV1", true, C.isMigrationTranscriptTextParams, C.isMigrationTranscriptTextResult),
  historyJobs: rule("jobs/list", "migrationHistoryJobsV1", true, C.isMigrationJobsListParams, C.isMigrationHistoryJobsResult, ["jobs"]),
  historyRead: rule("read", "migrationHistoryJobsV1", true, C.isMigrationOperationParams, C.isMigrationHistoryJobResult),
  historyRun: rule("run", "migrationHistoryJobsV1", false, C.isMigrationHistoryRunParams, C.isMigrationHistoryJobResult),
  historyResume: rule("resume", "migrationHistoryJobsV1", false, C.isMigrationHistoryRunParams, C.isMigrationHistoryJobResult),
  historyCancel: rule("cancel", "migrationHistoryJobsV1", false, C.isMigrationOperationParams, C.isMigrationHistoryJobResult),
  reinterpretPreview: rule("reinterpret/preview", "migrationHistoryReinterpretationV1", true, C.isMigrationHistoryReinterpretPreviewParams, C.isMigrationHistoryReinterpretPreviewResult),
  reinterpretCreate: rule("reinterpret/create", "migrationHistoryReinterpretationV1", false, C.isMigrationHistoryReinterpretCreateParams, C.isMigrationHistoryJobResult),
  branchPrepare: rule("branch/prepare", branch, false, C.isMigrationBranchPrepareParams, C.isMigrationBranchStateResult),
  branchRead: rule("branch/read", branch, true, C.isMigrationBranchReadParams, C.isMigrationBranchStateResult),
  branchRun: rule("branch/run", branch, false, C.isMigrationBranchOperationParams, C.isMigrationBranchStateResult),
  branchResume: rule("branch/resume", branch, false, C.isMigrationBranchResumeParams, C.isMigrationBranchStateResult),
  branchCancel: rule("branch/cancel", branch, false, C.isMigrationBranchOperationParams, C.isMigrationBranchCancelResult),
  branchPage: rule("branch/page", branch, true, C.isMigrationBranchPageParams, C.isMigrationBranchPageResult, ["items"]),
  branchBlocks: rule("branch/blocks", branch, true, C.isMigrationBranchBlocksParams, C.isMigrationTranscriptBlocksResult, ["blocks"]),
  branchText: rule("branch/text", branch, true, C.isMigrationBranchTextParams, C.isMigrationTranscriptTextResult),
  toolsRead: rule("branch/tools/read", tools, true, C.isMigrationBranchOperationParams, C.isMigrationBranchToolsStateResult),
  toolsRun: rule("branch/tools/run", tools, false, C.isMigrationBranchOperationParams, C.isMigrationBranchToolsStateResult),
  toolsResume: rule("branch/tools/resume", tools, false, C.isMigrationBranchResumeParams, C.isMigrationBranchToolsStateResult),
  toolsCancel: rule("branch/tools/cancel", tools, false, C.isMigrationBranchOperationParams, C.isMigrationBranchToolsStateResult),
  toolsPage: rule("branch/tools/page", tools, true, C.isMigrationBranchToolsPageParams, C.isMigrationBranchToolsPageResult, ["links"]),
  attachmentRead: rule("attachment/read", attachments, true, C.isMigrationHistoryAttachmentParams, C.isMigrationHistoryAttachmentStateResult),
  attachmentRun: rule("attachment/run", attachments, false, C.isMigrationHistoryAttachmentParams, C.isMigrationHistoryAttachmentStateResult),
  attachmentResume: rule("attachment/resume", attachments, false, C.isMigrationHistoryAttachmentResumeParams, C.isMigrationHistoryAttachmentStateResult),
  attachmentCancel: rule("attachment/cancel", attachments, false, C.isMigrationHistoryAttachmentParams, C.isMigrationHistoryAttachmentStateResult),
  attachmentChunk: rule("attachment/chunk", attachments, true, C.isMigrationHistoryAttachmentChunkParams, C.isMigrationHistoryAttachmentChunkResult),
  toolAttachmentRead: rule("tool-attachments/read", nested, true, C.isMigrationHistoryAttachmentParams, C.isMigrationHistoryAttachmentStateResult),
  toolAttachmentRun: rule("tool-attachments/run", nested, false, C.isMigrationHistoryAttachmentParams, C.isMigrationHistoryAttachmentStateResult),
  toolAttachmentResume: rule("tool-attachments/resume", nested, false, C.isMigrationHistoryAttachmentResumeParams, C.isMigrationHistoryAttachmentStateResult),
  toolAttachmentCancel: rule("tool-attachments/cancel", nested, false, C.isMigrationHistoryAttachmentParams, C.isMigrationHistoryAttachmentStateResult),
  toolAttachmentChunk: rule("tool-attachments/chunk", nested, true, C.isMigrationHistoryAttachmentChunkParams, C.isMigrationHistoryAttachmentChunkResult),
  toolAttachmentItems: rule("tool-attachments/items", nested, true, C.isMigrationHistoryToolAttachmentItemsParams, C.isMigrationHistoryToolAttachmentItemsResult, ["items"]),
  localPrepare: rule("local-attachment/prepare", local, false, C.isMigrationLocalAttachmentPrepareParams, C.isMigrationLocalAttachmentStateResult),
  localRead: rule("local-attachment/read", local, true, C.isMigrationLocalAttachmentReadParams, C.isMigrationLocalAttachmentStateResult),
  localBegin: rule("local-attachment/begin", local, false, C.isMigrationLocalAttachmentBeginParams, C.isMigrationLocalAttachmentStateResult),
  localPart: rule("local-attachment/part", local, false, C.isMigrationLocalAttachmentPartParams, C.isMigrationLocalAttachmentStateResult),
  localFinish: rule("local-attachment/finish", local, false, C.isMigrationLocalAttachmentRunParams, C.isMigrationLocalAttachmentStateResult),
  localResume: rule("local-attachment/resume", local, false, C.isMigrationLocalAttachmentRunParams, C.isMigrationLocalAttachmentStateResult),
  localRun: rule("local-attachment/run", local, false, C.isMigrationLocalAttachmentRunParams, C.isMigrationLocalAttachmentStateResult),
  localCancel: rule("local-attachment/cancel", local, false, C.isMigrationLocalAttachmentReadParams, C.isMigrationLocalAttachmentStateResult),
  localList: rule("local-attachment/list", local, true, C.isMigrationLocalAttachmentListParams, C.isMigrationLocalAttachmentListResult, ["items"]),
  localChunk: rule("local-attachment/chunk", local, true, C.isMigrationLocalAttachmentChunkParams, C.isMigrationHistoryAttachmentChunkResult),
  continuationCreate: rule("continuation/create", continuation, false, C.isMigrationContinuationCreateParams, C.isMigrationContinuationStateResult),
  continuationRead: rule("continuation/read", continuation, true, C.isMigrationContinuationReadParams, C.isMigrationContinuationStateResult),
  continuationRun: rule("continuation/run", continuation, false, C.isMigrationContinuationRunParams, C.isMigrationContinuationStateResult),
  continuationResume: rule("continuation/resume", continuation, false, C.isMigrationContinuationRunParams, C.isMigrationContinuationStateResult),
  continuationCancel: rule("continuation/cancel", continuation, false, C.isMigrationContinuationReadParams, C.isMigrationContinuationStateResult),
  continuationSource: rule("continuation/source", "migrationContinuationSourceV1", true, C.isMigrationContinuationSourceParams, C.isMigrationContinuationSourceResult),
  undoLookup: rule("undo/lookup", undo, true, C.isMigrationHistoryUndoLookupParams, C.isMigrationHistoryUndoLookupResult),
  undoPreview: rule("undo/preview", undo, true, C.isMigrationHistoryUndoPreviewParams, C.isMigrationHistoryUndoPreviewResult),
  undoCreate: rule("undo/create", undo, false, C.isMigrationHistoryUndoCreateParams, C.isMigrationHistoryUndoStateResult),
  undoRead: rule("undo/read", undo, true, C.isMigrationHistoryUndoReadParams, C.isMigrationHistoryUndoStateResult),
  undoRun: rule("undo/run", undo, false, C.isMigrationHistoryUndoRunParams, C.isMigrationHistoryUndoStateResult),
  undoCancel: rule("undo/cancel", undo, false, C.isMigrationHistoryUndoReadParams, C.isMigrationHistoryUndoStateResult),
};
