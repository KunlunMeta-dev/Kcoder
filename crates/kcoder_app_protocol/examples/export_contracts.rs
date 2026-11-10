//! Export only reviewed public data contracts, using their actual serde schema.
use kcoder_app_protocol::{KnowledgeFileCapabilitiesResult, KnowledgeFileCapability};
use kcoder_types::{ModelConfigurationBoundary, ModelConfigurationSummary, ModelReasoningPolicy};
use schemars::{JsonSchema, schema_for};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::BTreeMap;

use kcoder_types::wiki_job_progress::WikiJobProgress;
#[path = "export_contracts/agents.rs"]
mod agents;
#[path = "export_contracts/async_questions.rs"]
mod async_questions;
#[path = "export_contracts/continuous_work.rs"]
mod continuous_work;
#[path = "export_contracts/integrations.rs"]
mod integrations;
#[path = "export_contracts/task_interactions.rs"]
mod task_interactions;

fn register<T: JsonSchema + DeserializeOwned + Serialize>(
    name: &str,
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    schemas.insert(name.into(), serde_json::to_value(schema_for!(T))?);
    for case in fixtures[name]["valid"]
        .as_array_mut()
        .ok_or("missing legal examples")?
    {
        let decoded: T = serde_json::from_value(case["value"].clone())?;
        case["decoded"] = serde_json::to_value(decoded)?;
        if matches!(
            name,
            "TaskStatus" | "TurnAttemptStatus" | "WikiJobStatus" | "WikiJobPhase"
        ) && case["decoded"] != case["value"]
        {
            return Err("status raw value was not preserved".into());
        }
    }
    for case in fixtures[name]["invalid"]
        .as_array()
        .ok_or("missing negative examples")?
    {
        if serde_json::from_value::<T>(case["value"].clone()).is_ok() {
            return Err(format!("invalid fixture accepted: {name}/{}", case["name"]).into());
        }
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut fixtures: Value =
        serde_json::from_str(include_str!("../../../scripts/contracts/fixtures.json"))?;
    for source in [
        include_str!("../../../scripts/contracts/fixtures.web-sources.json"),
        include_str!("../../../scripts/contracts/fixtures.knowledge.json"),
        include_str!("../../../scripts/contracts/fixtures.mcp.json"),
        include_str!("../../../scripts/contracts/fixtures.web-search.json"),
        include_str!("../../../scripts/contracts/fixtures.mcp-authorization.json"),
        include_str!("../../../scripts/contracts/fixtures.task-comparison.json"),
        include_str!("../../../scripts/contracts/fixtures.task-delivery.json"),
        include_str!("../../../scripts/contracts/fixtures.turn-file-capture.json"),
        include_str!("../../../scripts/contracts/fixtures.review-evidence.json"),
        include_str!("../../../scripts/contracts/fixtures.agents.json"),
        include_str!("../../../scripts/contracts/fixtures.continuous-work.json"),
        include_str!("../../../scripts/contracts/fixtures.browser-profiles.json"),
        include_str!("../../../scripts/contracts/fixtures.task-interactions.json"),
        include_str!("../../../scripts/contracts/fixtures.widgets.json"),
        include_str!("../../../scripts/contracts/fixtures.mcp-apps.json"),
        include_str!("../../../scripts/contracts/fixtures.workflow-collaboration.json"),
        include_str!("../../../scripts/contracts/fixtures.migration.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-source.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-source-sessions.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-source-credentials.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-batch.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-batch-control.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-credentials.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-history.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-history-budget.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-transcript.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-branches.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-attachments.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-lifecycle.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-memory.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-definitions.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-agents.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-projects.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-items.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-instructions.json"),
        include_str!("../../../scripts/contracts/fixtures.migration-source-upload.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-core.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-services.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-remotes.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-models.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-tasks.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-task-capability-scope.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-office.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-office-exports.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-office-assistants.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-office-generation.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-connectivity.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-knowledge.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-knowledge-memory.json"),
        include_str!("../../../scripts/contracts/fixtures.integrations-knowledge-automation.json"),
        include_str!(
            "../../../scripts/contracts/fixtures.integrations-knowledge-subscriptions.json"
        ),
    ] {
        let domain: BTreeMap<String, Value> = serde_json::from_str(source)?;
        let merged = fixtures
            .as_object_mut()
            .ok_or("fixture root must be an object")?;
        for (name, cases) in domain {
            if merged.insert(name.clone(), cases).is_some() {
                return Err(format!("duplicate fixture contract: {name}").into());
            }
        }
    }
    let mut schemas = BTreeMap::new();
    register::<kcoder_app_protocol::web_sources::WebSourcesToolResultV1>(
        "WebSourcesToolResultV1",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WebSearchStatusReadParams>(
        "WebSearchStatusReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WebSearchStatusReadResult>(
        "WebSearchStatusReadResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WebSearchProbeStartParams>(
        "WebSearchProbeStartParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WebSearchProbeReadParams>(
        "WebSearchProbeReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WebSearchProbeResult>(
        "WebSearchProbeResult",
        &mut fixtures,
        &mut schemas,
    )?;

    register::<kcoder_app_protocol::ProviderDiscoverModelsParams>(
        "ProviderDiscoverModelsParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ProviderDiscoveredModels>(
        "ProviderDiscoveredModels",
        &mut fixtures,
        &mut schemas,
    )?;
    agents::register(&mut fixtures, &mut schemas)?;
    continuous_work::register(&mut fixtures, &mut schemas)?;
    task_interactions::register(&mut fixtures, &mut schemas)?;
    async_questions::register(&mut fixtures, &mut schemas)?;
    integrations::register(&mut fixtures, &mut schemas)?;
    register::<kcoder_app_protocol::MigrationBatchControlReadParams>(
        "MigrationBatchControlReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBatchControlCancelParams>(
        "MigrationBatchControlCancelParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBatchControlResult>(
        "MigrationBatchControlResult",
        &mut fixtures,
        &mut schemas,
    )?;

    register::<kcoder_app_protocol::MigrationInstructionCaptureParams>(
        "MigrationInstructionCaptureParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationInstructionCaptureResult>(
        "MigrationInstructionCaptureResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationInstructionReadTarget>(
        "MigrationInstructionReadTarget",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationInstructionPageParams>(
        "MigrationInstructionPageParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceInstructionPageParams>(
        "MigrationSourceInstructionPageParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationInstructionPageResult>(
        "MigrationInstructionPageResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationInstructionBodyParams>(
        "MigrationInstructionBodyParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceInstructionBodyParams>(
        "MigrationSourceInstructionBodyParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationInstructionBodyResult>(
        "MigrationInstructionBodyResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationInstructionScopeChoice>(
        "MigrationInstructionScopeChoice",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceInstructionMapping>(
        "MigrationSourceInstructionMapping",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectsDiscoverParams>(
        "MigrationProjectsDiscoverParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectsSourcesParams>(
        "MigrationProjectsSourcesParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectSourceRootsParams>(
        "MigrationProjectSourceRootsParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectTargetsParams>(
        "MigrationProjectTargetsParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectTargetRootsParams>(
        "MigrationProjectTargetRootsParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectReportParams>(
        "MigrationProjectReportParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectSourcesResult>(
        "MigrationProjectSourcesResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectSourceRootsResult>(
        "MigrationProjectSourceRootsResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectTargetsResult>(
        "MigrationProjectTargetsResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectTargetRootsResult>(
        "MigrationProjectTargetRootsResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectReceivedMetadata>(
        "MigrationProjectReceivedMetadata",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectReportResult>(
        "MigrationProjectReportResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBatchProjectSource>(
        "MigrationBatchProjectSource",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationAgentAdaptation>(
        "MigrationAgentAdaptation",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationAgentCompatibility>(
        "MigrationAgentCompatibility",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationAgentPreviewParams>(
        "MigrationAgentPreviewParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationAgentPreviewResult>(
        "MigrationAgentPreviewResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationDefinitionsDiscoverParams>(
        "MigrationDefinitionsDiscoverParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationDefinitionsDiscoverResult>(
        "MigrationDefinitionsDiscoverResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationDefinitionReportParams>(
        "MigrationDefinitionReportParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationDefinitionReportResult>(
        "MigrationDefinitionReportResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationDefinitionBodyParams>(
        "MigrationDefinitionBodyParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationDefinitionBodyResult>(
        "MigrationDefinitionBodyResult",
        &mut fixtures,
        &mut schemas,
    )?;

    register::<kcoder_app_protocol::MigrationSourceProductParams>(
        "MigrationSourceProductParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceProductRunParams>(
        "MigrationSourceProductRunParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceProductCancelParams>(
        "MigrationSourceProductCancelParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceProductStateResult>(
        "MigrationSourceProductStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceProductSelectResult>(
        "MigrationSourceProductSelectResult",
        &mut fixtures,
        &mut schemas,
    )?;

    register::<kcoder_app_protocol::MigrationSourceUploadPrepareParams>(
        "MigrationSourceUploadPrepareParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceUploadReadParams>(
        "MigrationSourceUploadReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceUploadFilesParams>(
        "MigrationSourceUploadFilesParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceUploadPartParams>(
        "MigrationSourceUploadPartParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceUploadRunParams>(
        "MigrationSourceUploadRunParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceUploadCancelParams>(
        "MigrationSourceUploadCancelParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceUploadStateResult>(
        "MigrationSourceUploadStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceUploadFilesResult>(
        "MigrationSourceUploadFilesResult",
        &mut fixtures,
        &mut schemas,
    )?;

    register::<kcoder_types::imported_memory::ImportedMemoryProvenance>(
        "ImportedMemoryProvenance",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMemoryDiscoverParams>(
        "MigrationMemoryDiscoverParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMemorySourcesParams>(
        "MigrationMemorySourcesParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMemorySourcesResult>(
        "MigrationMemorySourcesResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMemoryListParams>(
        "MigrationMemoryListParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMemoryListResult>(
        "MigrationMemoryListResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMemoryReadParams>(
        "MigrationMemoryReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMemoryReadResult>(
        "MigrationMemoryReadResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMemoryControlParams>(
        "MigrationMemoryControlParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMemoryControlResult>(
        "MigrationMemoryControlResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMemoryControlReadParams>(
        "MigrationMemoryControlReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationCodexLayersSelectParams>(
        "MigrationCodexLayersSelectParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationCodexLayersSelectResult>(
        "MigrationCodexLayersSelectResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationCodexLayersReadResult>(
        "MigrationCodexLayersReadResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationConfigurationLayersParams>(
        "MigrationConfigurationLayersParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationConfigurationLayersResult>(
        "MigrationConfigurationLayersResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationPluginDiscoverParams>(
        "MigrationPluginDiscoverParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationPluginDiscoverResult>(
        "MigrationPluginDiscoverResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationPluginPlanParams>(
        "MigrationPluginPlanParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationPluginReadParams>(
        "MigrationPluginReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationPluginOperationParams>(
        "MigrationPluginOperationParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationPluginListParams>(
        "MigrationPluginListParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationPluginStateResult>(
        "MigrationPluginStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationPluginListResult>(
        "MigrationPluginListResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryToolAttachmentItemsParams>(
        "MigrationHistoryToolAttachmentItemsParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryToolAttachmentItemsResult>(
        "MigrationHistoryToolAttachmentItemsResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryAttachmentParams>(
        "MigrationHistoryAttachmentParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryAttachmentResumeParams>(
        "MigrationHistoryAttachmentResumeParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryAttachmentStateResult>(
        "MigrationHistoryAttachmentStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryAttachmentChunkParams>(
        "MigrationHistoryAttachmentChunkParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryAttachmentChunkResult>(
        "MigrationHistoryAttachmentChunkResult",
        &mut fixtures,
        &mut schemas,
    )?;

    register::<kcoder_app_protocol::MigrationContinuationCreateParams>(
        "MigrationContinuationCreateParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationContinuationSourceParams>(
        "MigrationContinuationSourceParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationContinuationSourceResult>(
        "MigrationContinuationSourceResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationContinuationReadParams>(
        "MigrationContinuationReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationContinuationRunParams>(
        "MigrationContinuationRunParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationContinuationStateResult>(
        "MigrationContinuationStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchToolsStateResult>(
        "MigrationBranchToolsStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchToolsPageParams>(
        "MigrationBranchToolsPageParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchToolsPageResult>(
        "MigrationBranchToolsPageResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchPrepareParams>(
        "MigrationBranchPrepareParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchOperationParams>(
        "MigrationBranchOperationParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchReadParams>(
        "MigrationBranchReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchResumeParams>(
        "MigrationBranchResumeParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchStateResult>(
        "MigrationBranchStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchCancelResult>(
        "MigrationBranchCancelResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchPageParams>(
        "MigrationBranchPageParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchBlocksParams>(
        "MigrationBranchBlocksParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchTextParams>(
        "MigrationBranchTextParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBranchPageResult>(
        "MigrationBranchPageResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationTranscriptPageParams>(
        "MigrationTranscriptPageParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryViewOpenParams>(
        "MigrationHistoryViewOpenParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryViewReadParams>(
        "MigrationHistoryViewReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryViewRenewParams>(
        "MigrationHistoryViewRenewParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryViewReleaseParams>(
        "MigrationHistoryViewReleaseParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryViewLease>(
        "MigrationHistoryViewLease",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryViewResult>(
        "MigrationHistoryViewResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationArchiveRetirementPreviewParams>(
        "MigrationArchiveRetirementPreviewParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationArchiveRetirementPrepareParams>(
        "MigrationArchiveRetirementPrepareParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationArchiveRetirementReadParams>(
        "MigrationArchiveRetirementReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationArchiveRetirementControlParams>(
        "MigrationArchiveRetirementControlParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationArchiveRetirementListParams>(
        "MigrationArchiveRetirementListParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationArchiveRetirement>(
        "MigrationArchiveRetirement",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationArchiveRetirementStateResult>(
        "MigrationArchiveRetirementStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationArchiveRetirementPreviewResult>(
        "MigrationArchiveRetirementPreviewResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationArchiveRetirementListResult>(
        "MigrationArchiveRetirementListResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationUploadCollectionAttachmentResult>(
        "MigrationUploadCollectionAttachmentResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationUploadCollectionPrepareParams>(
        "MigrationUploadCollectionPrepareParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationUploadCollectionReadParams>(
        "MigrationUploadCollectionReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationUploadCollectionListParams>(
        "MigrationUploadCollectionListParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationUploadCollectionRunParams>(
        "MigrationUploadCollectionRunParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationUploadCollectionCancelParams>(
        "MigrationUploadCollectionCancelParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationUploadCollectionResumeParams>(
        "MigrationUploadCollectionResumeParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationUploadCollectionStateResult>(
        "MigrationUploadCollectionStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationUploadCollectionListResult>(
        "MigrationUploadCollectionListResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationLocalAttachmentPrepareParams>(
        "MigrationLocalAttachmentPrepareParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationLocalAttachmentReadParams>(
        "MigrationLocalAttachmentReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationLocalAttachmentBeginParams>(
        "MigrationLocalAttachmentBeginParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationLocalAttachmentPartParams>(
        "MigrationLocalAttachmentPartParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationLocalAttachmentRunParams>(
        "MigrationLocalAttachmentRunParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationLocalAttachmentListParams>(
        "MigrationLocalAttachmentListParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationLocalAttachmentStateResult>(
        "MigrationLocalAttachmentStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationLocalAttachmentListResult>(
        "MigrationLocalAttachmentListResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationLocalAttachmentChunkParams>(
        "MigrationLocalAttachmentChunkParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryReinterpretPreviewParams>(
        "MigrationHistoryReinterpretPreviewParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryReinterpretPreviewResult>(
        "MigrationHistoryReinterpretPreviewResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryReinterpretCreateParams>(
        "MigrationHistoryReinterpretCreateParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryUndoLookupParams>(
        "MigrationHistoryUndoLookupParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryUndoLookupResult>(
        "MigrationHistoryUndoLookupResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryUndoPreviewParams>(
        "MigrationHistoryUndoPreviewParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryUndoPreviewResult>(
        "MigrationHistoryUndoPreviewResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryUndoCreateParams>(
        "MigrationHistoryUndoCreateParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryUndoReadParams>(
        "MigrationHistoryUndoReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryUndoRunParams>(
        "MigrationHistoryUndoRunParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryUndoStateResult>(
        "MigrationHistoryUndoStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistorySearchParams>(
        "MigrationHistorySearchParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistorySearchResult>(
        "MigrationHistorySearchResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationTranscriptBlocksParams>(
        "MigrationTranscriptBlocksParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationTranscriptTextParams>(
        "MigrationTranscriptTextParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationTranscriptPageResult>(
        "MigrationTranscriptPageResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationTranscriptBlocksResult>(
        "MigrationTranscriptBlocksResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationTranscriptTextResult>(
        "MigrationTranscriptTextResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryDiscoverParams>(
        "MigrationHistoryDiscoverParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistorySourcesParams>(
        "MigrationHistorySourcesParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistorySourcesResult>(
        "MigrationHistorySourcesResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryCreateParams>(
        "MigrationHistoryCreateParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryRunParams>(
        "MigrationHistoryRunParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryPhase>(
        "MigrationHistoryPhase",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryProgressUnit>(
        "MigrationHistoryProgressUnit",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryProgress>(
        "MigrationHistoryProgress",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryJobResult>(
        "MigrationHistoryJobResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryJobsResult>(
        "MigrationHistoryJobsResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMcpCredentialPlanParams>(
        "MigrationMcpCredentialPlanParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMcpCredentialPlanSummary>(
        "MigrationMcpCredentialPlanSummary",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMcpCredentialsResult>(
        "MigrationMcpCredentialsResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationCredentialPlanParams>(
        "MigrationCredentialPlanParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationCredentialOperationParams>(
        "MigrationCredentialOperationParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationCredentialPlanSummary>(
        "MigrationCredentialPlanSummary",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryResourceAttachmentReadParams>(
        "MigrationHistoryResourceAttachmentReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryResourceAttachmentResult>(
        "MigrationHistoryResourceAttachmentResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryResourceReadParams>(
        "MigrationHistoryResourceReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryResourceResult>(
        "MigrationHistoryResourceResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryResourceIncreaseParams>(
        "MigrationHistoryResourceIncreaseParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryResourceAttachParams>(
        "MigrationHistoryResourceAttachParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationHistoryParentResourceAttachParams>(
        "MigrationHistoryParentResourceAttachParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationResourceBudgetReadParams>(
        "MigrationResourceBudgetReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationResourceIncreaseParams>(
        "MigrationResourceIncreaseParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationResourceBudgetView>(
        "MigrationResourceBudgetView",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationResourceIncreaseReceipt>(
        "MigrationResourceIncreaseReceipt",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBatchScanParams>(
        "MigrationBatchScanParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBatchPlanParams>(
        "MigrationBatchPlanParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectMcpCatalogParams>(
        "MigrationProjectMcpCatalogParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProjectMcpCatalogResult>(
        "MigrationProjectMcpCatalogResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBatchMcpCredentialChoice>(
        "MigrationBatchMcpCredentialChoice",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBatchOperationParams>(
        "MigrationBatchOperationParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBatchRunParams>(
        "MigrationBatchRunParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBatchStateResult>(
        "MigrationBatchStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBatchItemPlanParams>(
        "MigrationBatchItemPlanParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationBatchItemPlanResult>(
        "MigrationBatchItemPlanResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationJobsListParams>(
        "MigrationJobsListParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationJobsListResult>(
        "MigrationJobsListResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationAssetPlanParams>(
        "MigrationAssetPlanParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationAssetPreviewParams>(
        "MigrationAssetPreviewParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationAssetPreviewResult>(
        "MigrationAssetPreviewResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationMcpPlanParams>(
        "MigrationMcpPlanParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationDiscoverResult>(
        "MigrationDiscoverResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProviderPlanParams>(
        "MigrationProviderPlanParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationProviderOperationParams>(
        "MigrationProviderOperationParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationCancelParams>(
        "MigrationCancelParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationJobReadResult>(
        "MigrationJobReadResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationOperationParams>(
        "MigrationOperationParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationItemsParams>(
        "MigrationItemsParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceTransferTargetReadParams>(
        "MigrationSourceTransferTargetReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceTransferTargetCancelParams>(
        "MigrationSourceTransferTargetCancelParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceTransferTargetFinishParams>(
        "MigrationSourceTransferTargetFinishParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceTransferTargetResumeParams>(
        "MigrationSourceTransferTargetResumeParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceTransferResult>(
        "MigrationSourceTransferResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceTransferReadParams>(
        "MigrationSourceTransferReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceTransferRunParams>(
        "MigrationSourceTransferRunParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceTransferCancelParams>(
        "MigrationSourceTransferCancelParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceSessionStateResult>(
        "MigrationSourceSessionStateResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceSessionCloseResult>(
        "MigrationSourceSessionCloseResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceSessionQueryParams>(
        "MigrationSourceSessionQueryParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceConfigurationLayersReadParams>(
        "MigrationSourceConfigurationLayersReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCodexLayersReadParams>(
        "MigrationSourceCodexLayersReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceDirectorySelectParams>(
        "MigrationSourceDirectorySelectParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceDirectoryResult>(
        "MigrationSourceDirectoryResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceSessionOpenParams>(
        "MigrationSourceSessionOpenParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceBindingsParams>(
        "MigrationSourceBindingsParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceBindingsResult>(
        "MigrationSourceBindingsResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceSessionParams>(
        "MigrationSourceSessionParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceReceivedParams>(
        "MigrationSourceReceivedParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceReceivedResult>(
        "MigrationSourceReceivedResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceAdoptionParams>(
        "MigrationSourceAdoptionParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceAdoptionPrepareParams>(
        "MigrationSourceAdoptionPrepareParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceAdoptionResumeParams>(
        "MigrationSourceAdoptionResumeParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceAdoptionCancelParams>(
        "MigrationSourceAdoptionCancelParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceAdoptionResult>(
        "MigrationSourceAdoptionResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialCandidatesParams>(
        "MigrationSourceCredentialCandidatesParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialSourcesParams>(
        "MigrationSourceCredentialSourcesParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialSourcesResult>(
        "MigrationSourceCredentialSourcesResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialCandidatesResult>(
        "MigrationSourceCredentialCandidatesResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialPreparationReadParams>(
        "MigrationSourceCredentialPreparationReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialPreparationResult>(
        "MigrationSourceCredentialPreparationResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialSourceReadParams>(
        "MigrationSourceCredentialSourceReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialLocator>(
        "MigrationSourceCredentialLocator",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialRunParams>(
        "MigrationSourceCredentialRunParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialCancelParams>(
        "MigrationSourceCredentialCancelParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialResumeParams>(
        "MigrationSourceCredentialResumeParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialPrepareParams>(
        "MigrationSourceCredentialPrepareParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialReleaseParams>(
        "MigrationSourceCredentialReleaseParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialResult>(
        "MigrationSourceCredentialResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialControlResult>(
        "MigrationSourceCredentialControlResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialPrepareResult>(
        "MigrationSourceCredentialPrepareResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationSourceCredentialError>(
        "MigrationSourceCredentialError",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationDiscoverParams>(
        "MigrationDiscoverParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationScanParams>(
        "MigrationScanParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationPlanParams>(
        "MigrationPlanParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationApplyParams>(
        "MigrationApplyParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationItemsResult>(
        "MigrationItemsResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::MigrationJobSummary>(
        "MigrationJobSummary",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ApprovalRequestParams>(
        "ApprovalRequestParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadMcpServerV1>(
        "ThreadMcpServerV1",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::InitializeParams>(
        "InitializeParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppRevokeParams>(
        "McpAppRevokeParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppRevokeResult>(
        "McpAppRevokeResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppReadParams>(
        "McpAppReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppReadResult>(
        "McpAppReadResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppToolCallParams>(
        "McpAppToolCallParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppOperationReadParams>(
        "McpAppOperationReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppOperationStatus>(
        "McpAppOperationStatus",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppToolCallResult>(
        "McpAppToolCallResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppResourceReadParams>(
        "McpAppResourceReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppResourceRef>(
        "McpAppResourceRef",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppResourceReadResult>(
        "McpAppResourceReadResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppResourceContentReadParams>(
        "McpAppResourceContentReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpAppResourceContentReadResult>(
        "McpAppResourceContentReadResult",
        &mut fixtures,
        &mut schemas,
    )?;

    register::<kcoder_types::widgets::WidgetInputPreview>(
        "WidgetInputPreview",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WidgetRef>("WidgetRef", &mut fixtures, &mut schemas)?;
    register::<kcoder_app_protocol::WidgetReadParams>(
        "WidgetReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WidgetReadResult>(
        "WidgetReadResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WidgetListParams>(
        "WidgetListParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WidgetListResult>(
        "WidgetListResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WidgetContentReadParams>(
        "WidgetContentReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WidgetContentReadResult>(
        "WidgetContentReadResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WidgetRenderReceiptParams>(
        "WidgetRenderReceiptParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::WidgetRenderReceiptResult>(
        "WidgetRenderReceiptResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_types::StudioWorkMode>("StudioWorkMode", &mut fixtures, &mut schemas)?;
    register::<kcoder_types::ClientPresentationV1>(
        "ClientPresentationV1",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadStreamContextV1>(
        "ThreadStreamContextV1",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<ModelConfigurationSummary>(
        "ModelConfigurationSummary",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<ModelConfigurationBoundary>(
        "ModelConfigurationBoundary",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<ModelReasoningPolicy>("ModelReasoningPolicy", &mut fixtures, &mut schemas)?;
    register::<WikiJobProgress>("WikiJobProgress", &mut fixtures, &mut schemas)?;
    register::<kcoder_types::wiki_pipeline::WikiPipelineProgress>(
        "WikiPipelineProgress",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_types::WorkflowAgentConfigurationSummary>(
        "WorkflowAgentConfigurationSummary",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_types::knowledge::WikiImageImport>(
        "WikiImageImport",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::KnowledgeImageImportListResult>(
        "KnowledgeImageImportListResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<KnowledgeFileCapability>("KnowledgeFileCapability", &mut fixtures, &mut schemas)?;
    register::<KnowledgeFileCapabilitiesResult>(
        "KnowledgeFileCapabilitiesResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ExecutionPermissionMode>(
        "ExecutionPermissionMode",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ExecutionDefaultsReadResult>(
        "ExecutionDefaultsReadResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ExecutionDefaultsSaveParams>(
        "ExecutionDefaultsSaveParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_types::mcp_failure::McpFailureReason>(
        "McpFailureReason",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpServerParams>(
        "McpServerParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpProviderRevocationParams>(
        "McpProviderRevocationParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpProviderRevocationReceipt>(
        "McpProviderRevocationReceipt",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpProviderRevocationPhase>(
        "McpProviderRevocationPhase",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpProviderRevocationReason>(
        "McpProviderRevocationReason",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpProviderRevocationSourceState>(
        "McpProviderRevocationSourceState",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpConnectionAttempt>(
        "McpConnectionAttempt",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpServerSummary>(
        "McpServerSummary",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpSetEnabledParams>(
        "McpSetEnabledParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::McpSetEnabledResult>(
        "McpSetEnabledResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_types::TaskStatus>("TaskStatus", &mut fixtures, &mut schemas)?;
    register::<kcoder_types::TurnAttemptStatus>("TurnAttemptStatus", &mut fixtures, &mut schemas)?;
    register::<kcoder_types::domain_status::WikiJobStatus>(
        "WikiJobStatus",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_types::domain_status::WikiJobPhase>(
        "WikiJobPhase",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadTranscriptSnapshotV1>(
        "ThreadTranscriptSnapshotV1",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadTranscriptObservationV1>(
        "ThreadTranscriptObservationV1",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TaskComparisonBindParams>(
        "TaskComparisonBindParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TaskComparisonReadParams>(
        "TaskComparisonReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TaskComparisonSelectParams>(
        "TaskComparisonSelectParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TaskComparisonReadResult>(
        "TaskComparisonReadResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TaskComparisonBinding>(
        "TaskComparisonBinding",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TaskDeliveryPrepareParams>(
        "TaskDeliveryPrepareParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TaskDeliveryReadParams>(
        "TaskDeliveryReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TaskDeliveryRequestParams>(
        "TaskDeliveryRequestParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TaskDeliveryFailureParams>(
        "TaskDeliveryFailureParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TaskDeliveryResult>(
        "TaskDeliveryResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TaskDeliveryFailureResult>(
        "TaskDeliveryFailureResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TurnReviewEvidence>(
        "TurnReviewEvidence",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::TurnFileChangesCapture>(
        "TurnFileChangesCapture",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadRuntimeHandoffReadParams>(
        "ThreadRuntimeHandoffReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadRuntimeHandoffReleaseParams>(
        "ThreadRuntimeHandoffReleaseParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadRuntimeHandoffSnapshot>(
        "ThreadRuntimeHandoffSnapshot",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadRuntimeHandoffStatus>(
        "ThreadRuntimeHandoffStatus",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadRuntimeHandoffReceipt>(
        "ThreadRuntimeHandoffReceipt",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadRuntimeHandoffReadResult>(
        "ThreadRuntimeHandoffReadResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadRuntimeHandoffReleaseResult>(
        "ThreadRuntimeHandoffReleaseResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadPresenceReadParams>(
        "ThreadPresenceReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadPresenceReadResultV1>(
        "ThreadPresenceReadResultV1",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadGoalStatusBatchParams>(
        "ThreadGoalStatusBatchParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadGoalStatusBatchResult>(
        "ThreadGoalStatusBatchResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadLifetimeReadParams>(
        "ThreadLifetimeReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadLifetimeSetParams>(
        "ThreadLifetimeSetParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadAttachParams>(
        "ThreadAttachParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadLifetimeResult>(
        "ThreadLifetimeResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadModelSelectionParams>(
        "ThreadModelSelectionParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ThreadModelSelectionResult>(
        "ThreadModelSelectionResult",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ApprovalResponse>(
        "ApprovalResponse",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::QuestionResponse>(
        "QuestionResponse",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::InteractionStatusReadParamsV1>(
        "InteractionStatusReadParamsV1",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::InteractionStatusReadResultV1>(
        "InteractionStatusReadResultV1",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ToolSelectionsReadParams>(
        "ToolSelectionsReadParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ToolSelectionsSaveParams>(
        "ToolSelectionsSaveParams",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::SelectableStudioTool>(
        "SelectableStudioTool",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::StudioModeToolSelection>(
        "StudioModeToolSelection",
        &mut fixtures,
        &mut schemas,
    )?;
    register::<kcoder_app_protocol::ToolSelectionsResult>(
        "ToolSelectionsResult",
        &mut fixtures,
        &mut schemas,
    )?;
    let failure_schema = schemas
        .get_mut("McpFailureReason")
        .ok_or("missing failure schema")?;
    let mut codes = BTreeMap::new();
    for label in failure_schema["enum"]
        .as_array()
        .ok_or("missing failure labels")?
    {
        let reason: kcoder_types::mcp_failure::McpFailureReason =
            serde_json::from_value(label.clone())?;
        codes.insert(
            label.as_str().ok_or("invalid failure label")?.to_owned(),
            reason.error_code(),
        );
    }
    failure_schema["x-error-codes"] = serde_json::to_value(codes)?;
    let fixture_names = fixtures
        .as_object()
        .ok_or("fixture root must be an object")?;
    if fixture_names.len() != schemas.len()
        || fixture_names.keys().any(|name| !schemas.contains_key(name))
    {
        let missing: Vec<_> = schemas
            .keys()
            .filter(|name| !fixture_names.contains_key(*name))
            .collect();
        let extra: Vec<_> = fixture_names
            .keys()
            .filter(|name| !schemas.contains_key(*name))
            .collect();
        return Err(format!("fixtures must cover exactly the registered Rust contracts; missing={missing:?}; extra={extra:?}").into());
    }
    println!(
        "{}",
        serde_json::to_string(&json!({"schemas": schemas, "fixtures": fixtures,
            "sourceReceipt": env!("KCODER_PROTOCOL_SOURCE_RECEIPT")}))?
    );
    Ok(())
}
