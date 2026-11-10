//! Wire types for the KCoder app-server protocol.
//!
//! The protocol is JSON-RPC 2.0 transported as one compact JSON value per
//! line. This crate contains no I/O or runtime state so desktop, web gateway,
//! and server implementations can share the exact same contract.

pub mod continuous_work;
pub mod integrations;
mod thread_lifetime;
pub use thread_lifetime::*;
mod thread_expert;
pub use thread_expert::*;
mod async_user_questions;
pub use async_user_questions::*;
mod mcp_apps;
pub use kcoder_types::agent_definition::{
    AgentDefinitionRef, AgentTaskBinding, AgentTaskSource, ChannelTaskSource,
};
pub mod web_sources;
pub use mcp_apps::*;
mod widgets;
pub use kcoder_types::{ClientPresentationV1, StudioWorkMode};
pub use widgets::*;
mod computer_use;
pub use computer_use::*;
mod tool_images;
pub use tool_images::ToolOutputImage;
mod model_catalog;
pub use model_catalog::RuntimeModelCatalogEntry;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

mod hooks;
pub use hooks::*;
mod skills;
pub use skills::*;
mod mcp;
pub use mcp::*;
mod migration_codex_layers;
pub use migration_codex_layers::*;
mod migration_configuration_layers;
pub use migration_configuration_layers::*;
mod migration;
mod migration_source_product;
pub use migration_source_product::*;
mod migration_source_upload;
pub use migration_source_upload::*;
mod migration_definitions;
pub use migration_definitions::*;
mod migration_projects;
pub use migration_projects::*;
mod migration_agents;
pub use migration_agents::*;
mod migration_instructions;
pub use migration_instructions::*;
mod migration_memory;
pub use migration_memory::*;
mod migration_plugin;
pub use migration::*;
pub use migration_plugin::*;
mod migration_batch;
pub use migration_batch::*;
mod migration_batch_control;
pub use migration_batch_control::*;
mod migration_project_mcp;
pub use migration_project_mcp::*;
mod migration_resources;
pub use migration_resources::*;
mod migration_credentials;
pub use migration_credentials::*;
mod migration_history;
pub use migration_history::*;
mod migration_resource_attachment;
pub use migration_resource_attachment::*;
mod migration_history_budget;
pub use migration_history_budget::*;
mod migration_history_lifecycle;
pub use migration_history_lifecycle::*;
mod migration_continuation;
pub use migration_continuation::*;
mod migration_transcript;
pub use migration_transcript::*;
mod migration_search;
pub use migration_search::*;
mod migration_undo;
pub use migration_undo::*;
mod migration_reinterpretation;
pub use migration_reinterpretation::*;
mod migration_local_attachment;
pub use migration_local_attachment::*;
mod migration_upload_collection;
pub use migration_upload_collection::*;
mod migration_branch;
pub use migration_branch::*;
mod migration_branch_tools;
pub use migration_branch_tools::*;
mod migration_history_attachment;
pub use migration_history_attachment::*;
mod thread_mcp;
pub use thread_mcp::*;

/// Credentials are missing before a model turn can be admitted or snapshotted.
pub const PROVIDER_AUTHENTICATION_REQUIRED: i64 = -32063;
mod settings_templates;
pub use settings_templates::*;
mod execution_defaults;
pub use execution_defaults::*;
mod storage_diagnostics;
pub use storage_diagnostics::*;
mod workspace_operations;
pub use workspace_operations::*;
mod thread_creations;
pub use thread_creations::*;
mod turn_receipts;
pub use turn_receipts::*;
mod turn_steer;
pub use turn_steer::*;
mod attachment_retention;
pub use attachment_retention::*;
mod retention_parent;
pub use retention_parent::*;
mod migration_source_observation;
pub use migration_source_observation::*;
mod migration_source_adoption;
pub use migration_source_adoption::*;
mod migration_source_bindings;
pub use migration_source_bindings::*;
mod migration_source_directory;
pub use migration_source_directory::*;
mod migration_source_credentials;
pub use migration_source_credentials::*;
mod migration_credential_sources;
pub use migration_credential_sources::*;
mod migration_source_operations;
pub use migration_source_operations::*;
mod migration_source_session;
pub use migration_source_session::*;
mod migration_source_transfer;
pub use migration_source_transfer::*;
mod retention_revocation;
pub use retention_revocation::*;
mod thread_resume_history;
pub use thread_resume_history::*;
mod thread_presence;
pub use thread_presence::*;
mod thread_runtime_handoff;
pub use thread_runtime_handoff::*;
mod thread_goal_status_batch;
pub use thread_goal_status_batch::*;
mod interaction_status;
pub use interaction_status::*;
mod task_interactions;
pub use task_interactions::*;
mod thread_transcript_snapshot;
pub use thread_transcript_snapshot::*;
mod thread_transcript_observation;
pub use thread_transcript_observation::*;
mod thread_model_selection;
pub use thread_model_selection::*;
mod workflow_canvas;
pub use workflow_canvas::*;
mod workflow_collaboration;
pub use workflow_collaboration::*;
mod web_search;
pub use web_search::*;
mod tool_profiles;
mod tool_selections;
pub use tool_profiles::*;
pub use tool_selections::*;
mod turn_file_changes;
pub use turn_file_changes::*;
mod turn_file_capture;
pub use turn_file_capture::*;
mod agent;
mod agent_run;
pub use agent_run::*;
mod cron;
mod history_refresh;
mod plugin;
mod providers;
mod resources;
mod tools_catalog;
mod usage;
pub use agent::*;
pub use cron::*;
pub use history_refresh::*;
pub use plugin::*;
pub use providers::*;
pub use resources::*;
pub use tools_catalog::*;
pub use usage::*;

pub const CAPABILITY_STUDIO_WORK_MODES_V1: &str = "studioWorkModesV1";
pub const CAPABILITY_INLINE_WIDGETS_V1: &str = "inlineWidgetsV1";
pub const CAPABILITY_ISOLATED_WIDGETS_V1: &str = "isolatedWidgetsV1";

pub const JSONRPC_VERSION: &str = "2.0";
pub const PROTOCOL_VERSION: &str = "2026-07-27";
pub const CAPABILITY_AGENT_CONVERSATION_STREAM_V1: &str = "agentConversationStreamV1";
pub const CAPABILITY_WORKFLOW_CONVERSATION_V1: &str = "workflowConversationV1";
pub const CAPABILITY_EXECUTION_DEFAULTS_V1: &str = "executionDefaultsV1";
pub const CAPABILITY_MIGRATION_PROVIDERS_V1: &str = "migrationProvidersV1";
pub const CAPABILITY_MIGRATION_MCP_V1: &str = "migrationMcpV1";
pub const CAPABILITY_MIGRATION_ASSETS_V1: &str = "migrationAssetsV1";
pub const CAPABILITY_MIGRATION_LOCAL_PLUGINS_V1: &str = "migrationLocalPluginsV1";
pub const CAPABILITY_MIGRATION_RESOURCE_BUDGET_V1: &str = "migrationResourceBudgetV1";
pub const CAPABILITY_MIGRATION_BATCH_V1: &str = "migrationBatchV1";
pub const CAPABILITY_MIGRATION_PROJECT_MCP_INHERITANCE_V1: &str =
    "migrationProjectMcpInheritanceV1";
pub const CAPABILITY_MIGRATION_BATCH_WORKERS_V1: &str = "migrationBatchWorkersV1";
pub const CAPABILITY_MIGRATION_BATCH_PLUGINS_V1: &str = "migrationBatchPluginsV1";
pub const CAPABILITY_MIGRATION_REUSE_V1: &str = "migrationReuseV1";
pub const CAPABILITY_MIGRATION_CREDENTIALS_V1: &str = "migrationCredentialsV1";
pub const CAPABILITY_MIGRATION_MCP_CREDENTIALS_V1: &str = "migrationMcpCredentialsV1";
pub const CAPABILITY_MIGRATION_BATCH_MCP_CREDENTIALS_V1: &str = "migrationBatchMcpCredentialsV1";
pub const CAPABILITY_MIGRATION_BATCH_CREDENTIALS_V1: &str = "migrationBatchCredentialsV1";
pub const CAPABILITY_MIGRATION_TEMPLATES_V1: &str = "migrationTemplatesV1";
pub const CAPABILITY_MIGRATION_TEMPLATE_REUSE_V1: &str = "migrationTemplateReuseV1";
pub const CAPABILITY_MIGRATION_HISTORY_FAMILY_INDEX_V1: &str = "migrationHistoryFamilyIndexV1";
/// Native history workers admit at least 32 independent jobs.
pub const CAPABILITY_MIGRATION_HISTORY_CONCURRENCY_32_V1: &str = "migrationHistoryConcurrency32V1";
/// Native history workers admit at least 64 independent jobs.
pub const CAPABILITY_MIGRATION_HISTORY_CONCURRENCY_64_V1: &str = "migrationHistoryConcurrency64V1";
pub const CAPABILITY_MIGRATION_HISTORY_JOBS_V1: &str = "migrationHistoryJobsV1";
pub const CAPABILITY_MIGRATION_CONTINUATION_V1: &str = "migrationContinuationV1";
pub const CAPABILITY_MIGRATION_CONTINUATION_SOURCE_V1: &str = "migrationContinuationSourceV1";
pub const CAPABILITY_MIGRATION_HISTORY_READ_V1: &str = "migrationHistoryReadV1";
pub const CAPABILITY_MIGRATION_CONTINUATION_UNDO_V1: &str = "migrationContinuationUndoV1";
pub const CAPABILITY_MIGRATION_HISTORY_SEARCH_V1: &str = "migrationHistorySearchV1";
pub const CAPABILITY_MIGRATION_HISTORY_REINTERPRETATION_V1: &str =
    "migrationHistoryReinterpretationV1";
pub const CAPABILITY_MIGRATION_LOCAL_ATTACHMENTS_V1: &str = "migrationLocalAttachmentsV1";
pub const CAPABILITY_MIGRATION_HISTORY_BRANCHES_V1: &str = "migrationHistoryBranchesV1";
pub const CAPABILITY_MIGRATION_HISTORY_RECONSTRUCTION_V1: &str = "migrationHistoryReconstructionV1";
pub const CAPABILITY_MIGRATION_BRANCH_TOOLS_V1: &str = "migrationBranchToolsV1";
pub const CAPABILITY_MIGRATION_HISTORY_ATTACHMENTS_V1: &str = "migrationHistoryAttachmentsV1";
pub const CAPABILITY_MIGRATION_HISTORY_TOOL_ATTACHMENTS_V1: &str =
    "migrationHistoryToolAttachmentsV1";
pub const THREAD_METADATA_SCHEMA: &str = "kcoder.thread-metadata";

mod recent_error;
pub use recent_error::{
    ThreadRecentError, ThreadRecentErrorCategory, ThreadRecentErrorKind, ThreadRecentErrorSource,
};
pub mod method {
    pub const MIGRATION_PROJECTS_DISCOVER: &str = "migration/projects/discover";
    pub const MIGRATION_PROJECTS_SOURCES: &str = "migration/projects/sources";
    pub const MIGRATION_PROJECTS_SOURCE_ROOTS: &str = "migration/projects/source-roots";
    pub const MIGRATION_PROJECTS_TARGETS: &str = "migration/projects/targets";
    pub const MIGRATION_PROJECTS_TARGET_ROOTS: &str = "migration/projects/target-roots";
    pub const MIGRATION_PROJECTS_REPORT: &str = "migration/projects/report";
    pub const MIGRATION_SOURCE_PRODUCT_RUN: &str = "migration/source/upload/product/run";
    pub const MIGRATION_SOURCE_PRODUCT_READ: &str = "migration/source/upload/product/read";
    pub const MIGRATION_SOURCE_PRODUCT_CANCEL: &str = "migration/source/upload/product/cancel";
    pub const MIGRATION_SOURCE_PRODUCT_RESUME: &str = "migration/source/upload/product/resume";
    pub const MIGRATION_SOURCE_UPLOADED_SELECT: &str = "migration/source/upload/select";
    pub const MIGRATION_SOURCE_UPLOAD_PREPARE: &str = "migration/source/upload/prepare";
    pub const MIGRATION_SOURCE_UPLOAD_PART: &str = "migration/source/upload/part";
    pub const MIGRATION_SOURCE_UPLOAD_FINISH: &str = "migration/source/upload/finish";
    pub const MIGRATION_SOURCE_UPLOAD_READ: &str = "migration/source/upload/read";
    pub const MIGRATION_SOURCE_UPLOAD_FILES: &str = "migration/source/upload/files";
    pub const MIGRATION_SOURCE_UPLOAD_CANCEL: &str = "migration/source/upload/cancel";
    pub const MIGRATION_SOURCE_UPLOAD_RESUME: &str = "migration/source/upload/resume";
    pub const MIGRATION_DEFINITIONS_DISCOVER: &str = "migration/definitions/discover";
    pub const MIGRATION_INSTRUCTION_CAPTURE: &str = "migration/instructions/capture";
    pub const MIGRATION_INSTRUCTION_PAGE: &str = "migration/instructions/page";
    pub const MIGRATION_INSTRUCTION_BODY: &str = "migration/instructions/body";
    pub const MIGRATION_DEFINITION_REPORT: &str = "migration/definitions/report";
    pub const MIGRATION_DEFINITION_BODY: &str = "migration/definitions/body";
    pub const MIGRATION_AGENT_PREVIEW: &str = "migration/agent/preview";
    pub const MIGRATION_MEMORY_DISCOVER: &str = "migration/memory/discover";
    pub const MIGRATION_MEMORY_SOURCES: &str = "migration/memory/sources";
    pub const MIGRATION_MEMORY_LIST: &str = "migration/memory/list";
    pub const MIGRATION_MEMORY_READ: &str = "migration/memory/read";
    pub const MIGRATION_MEMORY_CONTROL: &str = "migration/memory/control";
    pub const MIGRATION_MEMORY_CONTROL_READ: &str = "migration/memory/control/read";
    pub const MIGRATION_SOURCE_BINDINGS: &str = "migration/source/bindings";
    pub const MIGRATION_SOURCE_DIRECTORY_SELECT: &str = "migration/source/directory/select";
    pub const MIGRATION_CODEX_LAYERS_SELECT: &str = "migration/codex/layers/select";
    pub const MIGRATION_CODEX_LAYERS_READ: &str = "migration/codex/layers/read";
    pub const MIGRATION_UPLOAD_COLLECTION_PREPARE: &str =
        "migration/history/upload-collection/prepare";
    pub const MIGRATION_UPLOAD_COLLECTION_READ: &str = "migration/history/upload-collection/read";
    pub const MIGRATION_UPLOAD_COLLECTION_LIST: &str = "migration/history/upload-collection/list";
    pub const MIGRATION_UPLOAD_COLLECTION_RUN: &str = "migration/history/upload-collection/run";
    pub const MIGRATION_UPLOAD_COLLECTION_CANCEL: &str =
        "migration/history/upload-collection/cancel";
    pub const MIGRATION_UPLOAD_COLLECTION_RESUME: &str =
        "migration/history/upload-collection/resume";
    pub const MIGRATION_UPLOAD_COLLECTION_ATTACHMENT: &str =
        "migration/history/upload-collection/attachment";

    pub const MIGRATION_CONFIGURATION_LAYERS: &str = "migration/configuration/layers";
    pub const MIGRATION_LOCAL_ATTACHMENT_PREPARE: &str =
        "migration/history/local-attachment/prepare";
    pub const MIGRATION_LOCAL_ATTACHMENT_BEGIN: &str = "migration/history/local-attachment/begin";
    pub const MIGRATION_LOCAL_ATTACHMENT_PART: &str = "migration/history/local-attachment/part";
    pub const MIGRATION_LOCAL_ATTACHMENT_FINISH: &str = "migration/history/local-attachment/finish";
    pub const MIGRATION_LOCAL_ATTACHMENT_READ: &str = "migration/history/local-attachment/read";
    pub const MIGRATION_LOCAL_ATTACHMENT_RESUME: &str = "migration/history/local-attachment/resume";
    pub const MIGRATION_LOCAL_ATTACHMENT_RUN: &str = "migration/history/local-attachment/run";
    pub const MIGRATION_LOCAL_ATTACHMENT_CANCEL: &str = "migration/history/local-attachment/cancel";
    pub const MIGRATION_LOCAL_ATTACHMENT_LIST: &str = "migration/history/local-attachment/list";
    pub const MIGRATION_LOCAL_ATTACHMENT_CHUNK: &str = "migration/history/local-attachment/chunk";
    pub const MIGRATION_HISTORY_REINTERPRET_PREVIEW: &str = "migration/history/reinterpret/preview";
    pub const MIGRATION_HISTORY_REINTERPRET_CREATE: &str = "migration/history/reinterpret/create";
    pub const MIGRATION_HISTORY_UNDO_LOOKUP: &str = "migration/history/undo/lookup";
    pub const MIGRATION_HISTORY_UNDO_PREVIEW: &str = "migration/history/undo/preview";
    pub const MIGRATION_HISTORY_UNDO_CREATE: &str = "migration/history/undo/create";
    pub const MIGRATION_HISTORY_UNDO_READ: &str = "migration/history/undo/read";
    pub const MIGRATION_HISTORY_UNDO_RUN: &str = "migration/history/undo/run";
    pub const MIGRATION_HISTORY_UNDO_CANCEL: &str = "migration/history/undo/cancel";
    pub const MIGRATION_HISTORY_SEARCH: &str = "migration/history/search";
    pub const MIGRATION_HISTORY_VIEW_OPEN: &str = "migration/history/view/open";
    pub const MIGRATION_HISTORY_VIEW_READ: &str = "migration/history/view/read";
    pub const MIGRATION_HISTORY_VIEW_RENEW: &str = "migration/history/view/renew";
    pub const MIGRATION_HISTORY_VIEW_RELEASE: &str = "migration/history/view/release";
    pub const MIGRATION_ARCHIVE_RETIREMENT_PREVIEW: &str = "migration/history/retirement/preview";
    pub const MIGRATION_ARCHIVE_RETIREMENT_PREPARE: &str = "migration/history/retirement/prepare";
    pub const MIGRATION_ARCHIVE_RETIREMENT_READ: &str = "migration/history/retirement/read";
    pub const MIGRATION_ARCHIVE_RETIREMENT_LIST: &str = "migration/history/retirement/list";
    pub const MIGRATION_ARCHIVE_RETIREMENT_RUN: &str = "migration/history/retirement/run";
    pub const MIGRATION_ARCHIVE_RETIREMENT_CANCEL: &str = "migration/history/retirement/cancel";
    pub const MIGRATION_ARCHIVE_RETIREMENT_RESUME: &str = "migration/history/retirement/resume";
    pub const MIGRATION_CONTINUATION_CREATE: &str = "migration/history/continuation/create";
    pub const MIGRATION_CONTINUATION_SOURCE: &str = "migration/history/continuation/source";
    pub const MIGRATION_CONTINUATION_READ: &str = "migration/history/continuation/read";
    pub const MIGRATION_CONTINUATION_RUN: &str = "migration/history/continuation/run";
    pub const MIGRATION_CONTINUATION_RESUME: &str = "migration/history/continuation/resume";
    pub const MIGRATION_CONTINUATION_CANCEL: &str = "migration/history/continuation/cancel";
    pub const MIGRATION_TOOL_ATTACHMENTS_READ: &str = "migration/history/tool-attachments/read";
    pub const MIGRATION_TOOL_ATTACHMENTS_RUN: &str = "migration/history/tool-attachments/run";
    pub const MIGRATION_TOOL_ATTACHMENTS_RESUME: &str = "migration/history/tool-attachments/resume";
    pub const MIGRATION_TOOL_ATTACHMENTS_CANCEL: &str = "migration/history/tool-attachments/cancel";
    pub const MIGRATION_TOOL_ATTACHMENTS_CHUNK: &str = "migration/history/tool-attachments/chunk";
    pub const MIGRATION_TOOL_ATTACHMENTS_ITEMS: &str = "migration/history/tool-attachments/items";
    pub const MIGRATION_HISTORY_ATTACHMENT_READ: &str = "migration/history/attachment/read";
    pub const MIGRATION_HISTORY_ATTACHMENT_RUN: &str = "migration/history/attachment/run";
    pub const MIGRATION_HISTORY_ATTACHMENT_RESUME: &str = "migration/history/attachment/resume";
    pub const MIGRATION_HISTORY_ATTACHMENT_CANCEL: &str = "migration/history/attachment/cancel";
    pub const MIGRATION_HISTORY_ATTACHMENT_CHUNK: &str = "migration/history/attachment/chunk";
    pub const MIGRATION_BRANCH_TOOLS_READ: &str = "migration/history/branch/tools/read";
    pub const MIGRATION_BRANCH_TOOLS_RUN: &str = "migration/history/branch/tools/run";
    pub const MIGRATION_BRANCH_TOOLS_RESUME: &str = "migration/history/branch/tools/resume";
    pub const MIGRATION_BRANCH_TOOLS_CANCEL: &str = "migration/history/branch/tools/cancel";
    pub const MIGRATION_BRANCH_TOOLS_PAGE: &str = "migration/history/branch/tools/page";
    pub const MIGRATION_BRANCH_PREPARE: &str = "migration/history/branch/prepare";
    pub const MIGRATION_BRANCH_READ: &str = "migration/history/branch/read";
    pub const MIGRATION_BRANCH_RUN: &str = "migration/history/branch/run";
    pub const MIGRATION_BRANCH_CANCEL: &str = "migration/history/branch/cancel";
    pub const MIGRATION_BRANCH_RESUME: &str = "migration/history/branch/resume";
    pub const MIGRATION_BRANCH_PAGE: &str = "migration/history/branch/page";
    pub const MIGRATION_BRANCH_BLOCKS: &str = "migration/history/branch/blocks";
    pub const MIGRATION_BRANCH_TEXT: &str = "migration/history/branch/text";
    pub const MIGRATION_HISTORY_TRANSCRIPT: &str = "migration/history/transcript";
    pub const MIGRATION_HISTORY_BLOCKS: &str = "migration/history/blocks";
    pub const MIGRATION_HISTORY_TEXT: &str = "migration/history/text";
    pub const MIGRATION_HISTORY_FAMILIES_DISCOVER: &str = "migration/history/families/discover";
    pub const MIGRATION_HISTORY_DISCOVER: &str = "migration/history/discover";
    pub const MIGRATION_HISTORY_SOURCES: &str = "migration/history/sources";
    pub const MIGRATION_HISTORY_CREATE: &str = "migration/history/create";
    pub const MIGRATION_HISTORY_RESOURCES_ATTACHMENT_READ: &str =
        "migration/history/resources/attachment/read";
    pub const MIGRATION_HISTORY_RESOURCES_READ: &str = "migration/history/resources/read";
    pub const MIGRATION_HISTORY_RESOURCES_INCREASE: &str = "migration/history/resources/increase";
    pub const MIGRATION_HISTORY_RESOURCES_ATTACH: &str = "migration/history/resources/attach";
    pub const MIGRATION_HISTORY_READ: &str = "migration/history/read";
    pub const MIGRATION_HISTORY_RUN: &str = "migration/history/run";
    pub const MIGRATION_HISTORY_CANCEL: &str = "migration/history/cancel";
    pub const MIGRATION_HISTORY_RESUME: &str = "migration/history/resume";
    pub const MIGRATION_HISTORY_JOBS: &str = "migration/history/jobs";
    pub const MIGRATION_PLUGIN_DISCOVER: &str = "migration/plugin/discover";
    pub const MIGRATION_PLUGIN_PLAN: &str = "migration/plugin/plan";
    pub const MIGRATION_PLUGIN_CAPTURE: &str = "migration/plugin/capture";
    pub const MIGRATION_PLUGIN_READ: &str = "migration/plugin/read";
    pub const MIGRATION_PLUGIN_APPLY: &str = "migration/plugin/apply";
    pub const MIGRATION_PLUGIN_UNDO: &str = "migration/plugin/undo";
    pub const MIGRATION_PLUGIN_CANCEL: &str = "migration/plugin/cancel";
    pub const MIGRATION_PLUGIN_RESUME: &str = "migration/plugin/resume";
    pub const MIGRATION_PLUGIN_LIST: &str = "migration/plugin/list";
    pub const MIGRATION_DISCOVER: &str = "migration/discover";
    pub const MIGRATION_SCAN: &str = "migration/scan";
    pub const MIGRATION_READ: &str = "migration/read";
    pub const MIGRATION_ITEMS: &str = "migration/items";
    pub const MIGRATION_PROVIDER_PLAN: &str = "migration/provider/plan";
    pub const MIGRATION_PROVIDER_APPLY: &str = "migration/provider/apply";
    pub const MIGRATION_PROVIDER_ROLLBACK: &str = "migration/provider/rollback";
    pub const MIGRATION_MCP_PLAN: &str = "migration/mcp/plan";
    pub const MIGRATION_MCP_APPLY: &str = "migration/mcp/apply";
    pub const MIGRATION_MCP_ROLLBACK: &str = "migration/mcp/rollback";
    pub const MIGRATION_ASSET_PLAN: &str = "migration/asset/plan";
    pub const MIGRATION_ASSET_APPLY: &str = "migration/asset/apply";
    pub const MIGRATION_ASSET_ROLLBACK: &str = "migration/asset/rollback";
    pub const MIGRATION_ASSET_PREVIEW: &str = "migration/asset/preview";
    pub const MIGRATION_CANCEL: &str = "migration/cancel";
    pub const MIGRATION_BATCH_SCAN: &str = "migration/batch/scan";
    pub const MIGRATION_BATCH_PLAN: &str = "migration/batch/plan";
    pub const MIGRATION_BATCH_APPLY: &str = "migration/batch/apply";
    pub const MIGRATION_BATCH_RUN: &str = "migration/batch/run";
    pub const MIGRATION_BATCH_READ: &str = "migration/batch/read";
    pub const MIGRATION_BATCH_CONTROL_READ: &str = "migration/batch/control/read";
    pub const MIGRATION_BATCH_CONTROL_CANCEL: &str = "migration/batch/control/cancel";
    pub const MIGRATION_BATCH_CREDENTIAL_SOURCES: &str = "migration/batch/credential-sources";
    pub const MIGRATION_BATCH_RESOURCES_ATTACHMENT_READ: &str =
        "migration/batch/resources/attachment/read";
    pub const MIGRATION_BATCH_RESOURCES_READ: &str = "migration/batch/resources/read";
    pub const MIGRATION_BATCH_RESOURCES_ATTACH: &str = "migration/batch/resources/attach";
    pub const MIGRATION_BATCH_RESOURCES_INCREASE: &str = "migration/batch/resources/increase";
    pub const MIGRATION_BATCH_ROLLBACK: &str = "migration/batch/rollback";
    pub const MIGRATION_BATCH_ITEM_PLAN: &str = "migration/batch/item/plan";
    pub const MIGRATION_PROJECT_MCP_CATALOG: &str = "migration/project/mcp/catalog";
    pub const MIGRATION_JOBS_LIST: &str = "migration/jobs/list";
    pub const MIGRATION_CREDENTIAL_PLAN: &str = "migration/credential/plan";
    pub const MIGRATION_CREDENTIAL_APPLY: &str = "migration/credential/apply";
    pub const MIGRATION_CREDENTIAL_UNDO: &str = "migration/credential/undo";
    pub const MIGRATION_MCP_CREDENTIAL_READ: &str = "migration/mcp/credential/read";
    pub const MIGRATION_MCP_CREDENTIAL_PLAN: &str = "migration/mcp/credential/plan";
    pub const MIGRATION_MCP_CREDENTIAL_APPLY: &str = "migration/mcp/credential/apply";
    pub const MIGRATION_MCP_CREDENTIAL_UNDO: &str = "migration/mcp/credential/undo";
    pub const MIGRATION_BATCH_MCP_CREDENTIAL_READ: &str = "migration/batch/mcp/credential/read";
    pub const HOOK_CONFIGURATION_READ: &str = "hooks/config/read";
    pub const HOOK_CONFIGURATION_UPDATE: &str = "hooks/config/update";
    pub const SKILL_LIST: &str = "skills/list";
    pub const SKILL_SET_ENABLED: &str = "skills/setEnabled";
    pub const SKILL_IMPORT: &str = "skills/import";
    pub const SKILL_REMOVE: &str = "skills/remove";
    pub const MCP_LIST: &str = "mcp/list";
    pub const MCP_INSTALL: &str = "mcp/install";
    pub const MCP_SET_ENABLED: &str = "mcp/setEnabled";
    pub const MCP_REMOVE: &str = "mcp/remove";
    pub const MCP_LOGOUT: &str = "mcp/logout";
    pub const MCP_PROVIDER_REVOCATION: &str = "mcp/providerRevocation";
    pub const MCP_LOGIN: &str = "mcp/login";
    pub const MCP_CALLBACK: &str = "mcp/callback";
    pub const MCP_CANCEL: &str = "mcp/cancel";
    pub const TOOLS_CATALOG: &str = "tools/catalog";
    pub const ASYNC_QUESTION_LIST: &str = "asyncQuestion/list";
    pub const ASYNC_QUESTION_ANSWER: &str = "asyncQuestion/answer";
    pub const ASYNC_QUESTION_CANCEL: &str = "asyncQuestion/cancel";
    pub const ASYNC_QUESTION_CHANGED: &str = "asyncQuestion/changed";
    pub const AUTOMATION_RUN_STARTED: &str = "automation/runStarted";
    pub const AUTOMATION_RUN_FAILED: &str = "automation/runFailed";
    pub const AUTOMATION_STATE_CHANGED: &str = "automation/stateChanged";
    pub const USAGE_STATS: &str = "usage/stats";
    pub const CRON_PREVIEW: &str = "cron/preview";
    pub const PROVIDERS_LIST: &str = "runtime.providers.list";
    pub const PROVIDERS_TEMPLATES: &str = "runtime.providers.templates";
    pub const PROVIDERS_UPSERT: &str = "runtime.providers.upsert";
    pub const PROVIDERS_DELETE: &str = "runtime.providers.delete";
    pub const PROVIDERS_VALIDATE: &str = "runtime.providers.validate";
    pub const PROVIDERS_PROBE: &str = "runtime.providers.probe";
    pub const PROVIDERS_DISCOVER_MODELS: &str = "runtime.providers.discoverModels";
    pub const PROVIDERS_CLEAR_USER_OVERRIDE: &str = "runtime.providers.clearUserOverride";
    pub const INITIALIZE: &str = "initialize";
    pub const SERVER_RESOURCES_READ: &str = "server/resources/read";
    pub const SERVER_IDLE_SHUTDOWN: &str = "server/shutdown/idle";
    pub const THREAD_START: &str = "thread/start";
    pub const THREAD_LIST: &str = "thread/list";
    pub const THREAD_HISTORY_REFRESH: &str = "thread/history/refresh";
    pub const THREAD_PRESENCE_READ: &str = "thread/presence/read";
    pub const THREAD_GOAL_STATUS_READ_MANY: &str = "thread/goal/status/readMany";
    pub const INTERACTION_STATUS_READ: &str = "interaction/status/read";
    pub const THREAD_READ: &str = "thread/read";
    pub const THREAD_READ_INDEXED: &str = "thread/read/indexed";
    pub const THREAD_RESUME: &str = "thread/resume";
    pub const THREAD_MODEL_SELECT: &str = crate::METHOD_THREAD_MODEL_SELECT;
    pub const THREAD_FORK: &str = "thread/fork";
    pub const THREAD_COMPACT: &str = "thread/compact";
    pub const THREAD_ROLLBACK: &str = "thread/rollback";
    pub const THREAD_GOAL_GET: &str = "thread/goal/get";
    pub const THREAD_GOAL_HISTORY: &str = "thread/goal/history";
    pub const THREAD_GOAL_SET: &str = "thread/goal/set";
    pub const THREAD_GOAL_CLEAR: &str = "thread/goal/clear";
    /// Notification payload: ThreadGoalGetResult. The goal is server-authoritative.
    pub const THREAD_GOAL_UPDATED: &str = "thread/goal/updated";
    pub const THREAD_GOAL_CONTINUATION: &str = "thread/goal/continuation";
    pub const THREAD_AUTOMATION_SUSPEND: &str = "thread/automation/suspend";
    pub const SESSION_MODES: &str = "session/modes";
    pub const THREAD_SESSION_MODE_SET: &str = "thread/sessionMode/set";
    pub const THREAD_METADATA_UPDATE: &str = "thread/metadata/update";
    pub const THREAD_DELETE: &str = "thread/delete";
    pub const THREAD_DISPOSE: &str = "thread/dispose";
    pub const TURN_START: &str = "turn/start";
    pub const THREAD_CREATION_READ: &str = "thread/creation/read";
    pub const TURN_RECEIPT_READ: &str = "turn/receipt/read";
    pub const TURN_INTERRUPT: &str = "turn/interrupt";
    pub const TURN_STEER: &str = "turn/steer";
    pub const TURN_STEER_APPLIED: &str = "turn/steer/applied";
    pub const TURN_STEER_DROPPED: &str = "turn/steer/dropped";
    pub const TURN_SHORTEN_WAIT: &str = "turn/shorten_wait";
    pub const AGENT_LIST: &str = "agent/list";
    pub const AGENT_STEER: &str = "agent/steer";
    pub const AGENT_CONTINUE: &str = "agent/continue";
    pub const AGENT_STEER_APPLIED: &str = "agent/steer/applied";
    pub const AGENT_MESSAGE_READ: &str = "agent/message/read";
    pub const AGENT_MESSAGES_LIST: &str = "agent/messages/list";
    pub const AGENT_MESSAGES_ARCHIVE: &str = "agent/messages/archive";
    pub const AGENT_STOP: &str = "agent/stop";
    pub const AGENT_LIVE_READ: &str = "agent/live/read";
    pub const AGENT_STREAM_SUBSCRIBE: &str = "agent/stream/subscribe";
    pub const AGENT_STREAM_UNSUBSCRIBE: &str = "agent/stream/unsubscribe";
    pub const AGENT_STREAM_EVENT: &str = "agent/stream/event";
    pub const AGENT_STREAM_RESET: &str = "agent/stream/reset";
    /// Reads one whitelisted sub-agent artifact (output.md / transcript.json) of
    /// the calling thread. See AgentArtifactReadParams.
    pub const AGENT_ARTIFACT_READ: &str = "agent/artifact/read";
    pub const DEVICE_EXECUTE: &str = "device/execute";
    pub const WORKSPACE_IMPORT_ATTACHMENT: &str = "workspace/file/importAttachment";
    pub const ATTACHMENT_SAVE: &str = "attachment/save";
    pub const ATTACHMENT_UPLOAD_START: &str = "attachment/upload/start";
    pub const ATTACHMENT_UPLOAD_CHUNK: &str = "attachment/upload/chunk";
    pub const ATTACHMENT_UPLOAD_FINISH: &str = "attachment/upload/finish";
    pub const ATTACHMENT_UPLOAD_CANCEL: &str = "attachment/upload/cancel";
    pub const ATTACHMENT_RETENTION_RESERVE: &str = crate::METHOD_ATTACHMENT_RETENTION_RESERVE;
    pub const ATTACHMENT_RETENTION_READ: &str = crate::METHOD_ATTACHMENT_RETENTION_READ;
    pub const ATTACHMENT_RETENTION_RELEASE: &str = crate::METHOD_ATTACHMENT_RETENTION_RELEASE;
    pub const ATTACHMENT_RETENTION_CONSUME: &str = crate::METHOD_ATTACHMENT_RETENTION_CONSUME;
    pub const RETENTION_UPLOAD_SAVE: &str = crate::METHOD_RETENTION_UPLOAD_SAVE;
    pub const RETENTION_UPLOAD_START: &str = crate::METHOD_RETENTION_UPLOAD_START;
    pub const RETENTION_UPLOAD_READ: &str = crate::METHOD_RETENTION_UPLOAD_READ;
    pub const RETENTION_UPLOAD_CHUNK: &str = crate::METHOD_RETENTION_UPLOAD_CHUNK;
    pub const RETENTION_UPLOAD_FINISH: &str = crate::METHOD_RETENTION_UPLOAD_FINISH;
    pub const RETENTION_UPLOAD_CANCEL: &str = crate::METHOD_RETENTION_UPLOAD_CANCEL;

    pub const ATTACHMENT_DELETE: &str = "attachment/delete";
    pub const ATTACHMENT_READ: &str = "attachment/read";
    pub const ATTACHMENT_READ_CHUNK: &str = "attachment/read/chunk";
    pub const TERMINAL_START: &str = "terminal/start";
    pub const TERMINAL_LIST: &str = "terminal/list";
    pub const TERMINAL_ATTACH: &str = "terminal/attach";
    pub const TERMINAL_WRITE: &str = "terminal/write";
    pub const TERMINAL_RESIZE: &str = "terminal/resize";
    pub const TERMINAL_CLOSE: &str = "terminal/close";
    pub const BROWSER_START: &str = "browser/start";
    pub const BROWSER_PREFLIGHT: &str = "browser/preflight";
    pub const BROWSER_SCREENSHOT: &str = "browser/screenshot";
    pub const BROWSER_ACTION: &str = "browser/action";
    pub const BROWSER_EVALUATE: &str = "browser/evaluate";
    pub const BROWSER_CLOSE: &str = "browser/close";
    pub const PLUGIN_LIST: &str = "plugin/list";
    pub const PLUGIN_READ: &str = "plugin/read";
    pub const PLUGIN_REVALIDATE: &str = "plugin/revalidate";
    pub const PLUGIN_ACTIVATION_READ: &str = "plugin/activation/read";
    pub const PLUGIN_CREDENTIALS_CONFIGURE: &str = "plugin/credentials/configure";
    pub const PLUGIN_ICON: &str = "plugin/icon";
    pub const PLUGIN_PROXY_STATUS: &str = "plugin/proxy/status";
    pub const PLUGIN_PROXY_CONFIGURE: &str = "plugin/proxy/configure";
    pub const PLUGIN_TRUST_LIST: &str = "plugin/trust/list";
    pub const PLUGIN_TRUST_SET: &str = "plugin/trust/set";
    pub const PLUGIN_INSTALL: &str = "plugin/install";
    pub const PLUGIN_CANCEL_INSTALL: &str = "plugin/install/cancel";
    pub const PLUGIN_UNINSTALL: &str = "plugin/uninstall";
    pub const PLUGIN_ENABLE: &str = "plugin/enable";
    pub const PLUGIN_DISABLE: &str = "plugin/disable";
    pub const MARKETPLACE_LIST: &str = "marketplace/list";
    pub const MARKETPLACE_ADD: &str = "marketplace/add";
    pub const MARKETPLACE_REMOVE: &str = "marketplace/remove";
    pub const MARKETPLACE_REFRESH: &str = "marketplace/refresh";
    /// Session-level settings templates: list/read/save/delete/default.
    pub const WORKFLOW_CAPABILITIES_READ: &str = "workflow/capabilities/read";
    pub const WORKFLOW_VERIFICATION_READ: &str = "workflow/verification/read";
    pub const WORKFLOW_STORAGE_READ: &str = "workflow/storage/read";
    pub const WORKFLOW_STORAGE_MIGRATE: &str = "workflow/storage/migrate";
    pub const WORKFLOW_STORAGE_ROLLBACK: &str = "workflow/storage/rollback";
    pub const WORKFLOW_VERSION_REFERENCES: &str = "workflow/versions/references";
    pub const WORKFLOW_VERSION_ARCHIVE: &str = "workflow/versions/archive";
    pub const WORKFLOW_HISTORY_READ: &str = "workflow/versions/history/read";
    pub const WORKFLOW_UPDATE: &str = "workflow/update";
    pub const WORKFLOW_VERSIONS: &str = "workflow/versions";
    pub const WORKFLOW_CLONE: &str = "workflow/clone";
    pub const WORKFLOW_EXPORT: &str = "workflow/export";
    pub const WORKFLOW_IMPORT: &str = "workflow/import";
    pub const WORKFLOW_RUNS_LIST: &str = "workflow/runs/list";
    pub const WORKFLOW_RUNS_READ: &str = "workflow/runs/read";
    pub const WORKFLOW_RUNS_ARCHIVE_PREVIEW: &str = "workflow/runs/archive/preview";
    pub const WORKFLOW_RUNS_ARCHIVE: &str = "workflow/runs/archive";
    pub const WORKFLOW_RUNS_ARCHIVE_LIST: &str = "workflow/runs/archive/list";
    pub const WORKFLOW_RUNS_ARCHIVE_READ: &str = "workflow/runs/archive/read";
    pub const WORKFLOW_RUNS_OUTPUT: &str = "workflow/runs/output";
    pub const WORKFLOW_LIST: &str = "workflow/list";
    pub const WORKFLOW_READ: &str = "workflow/read";
    pub const WORKFLOW_CREATE: &str = "workflow/create";
    pub const WORKFLOW_SAVE: &str = "workflow/save";
    pub const WORKFLOW_MOVE_NODE: &str = "workflow/moveNode";
    pub const WORKFLOW_REQUESTS: &str = "workflow/runs/requests";
    pub const WORKFLOW_RESPOND: &str = "workflow/runs/respond";
    pub const WORKFLOW_UPSERT_NODE: &str = "workflow/upsertNode";
    pub const WORKFLOW_DELETE: &str = "workflow/delete";
    pub const WORKFLOW_REMOVE_NODE: &str = "workflow/removeNode";
    pub const SETTINGS_TOOL_SELECTIONS_READ: &str = "settings/tools/selection/read";
    pub const SETTINGS_TOOL_SELECTIONS_SAVE: &str = "settings/tools/selection/save";
    pub const SETTINGS_TOOLS_READ: &str = "settings/tools/read";
    pub const SETTINGS_TOOLS_SAVE: &str = "settings/tools/save";
    pub const SETTINGS_TEMPLATES_LIST: &str = "settings/templates/list";
    pub const SETTINGS_TEMPLATES_READ: &str = "settings/templates/read";
    pub const SETTINGS_TEMPLATES_SAVE: &str = "settings/templates/save";
    pub const SETTINGS_TEMPLATES_DELETE: &str = "settings/templates/delete";
    pub const SETTINGS_TEMPLATES_DEFAULT: &str = "settings/templates/default";
    pub const SETTINGS_EXECUTION_DEFAULTS_READ: &str = "settings/execution-defaults/read";
    pub const SETTINGS_EXECUTION_DEFAULTS_SAVE: &str = "settings/execution-defaults/save";
    /// Storage and diagnostics surfaces used by KCoder Studio.
    pub const DIAGNOSTICS_STORAGE_READ: &str = "diagnostics/storage/read";
    pub const DIAGNOSTICS_STORAGE_CANCEL: &str = "diagnostics/storage/cancel";
    pub const DIAGNOSTICS_STORAGE_CLEAN: &str = "diagnostics/storage/clean";
    pub const COMPUTER_USE_STATUS: &str = "computerUse/status";
    pub const COMPUTER_USE_RECOVER: &str = "computerUse/recover";
    pub const COMPUTER_USE_REVOKE: &str = "computerUse/revoke";
    pub const COMPUTER_USE_STATE_CHANGED: &str = "computerUse/stateChanged";
    pub const DIAGNOSTICS_DEBUG_LOG_DISABLE: &str = "diagnostics/debug-log/disable";
    /// Turn-file-change snapshot policy edited from KCoder Studio.
    pub const SETTINGS_TURN_FILE_CHANGES_READ: &str = "settings/turn-file-changes/read";
    pub const SETTINGS_TURN_FILE_CHANGES_SAVE: &str = "settings/turn-file-changes/save";

    pub const THREAD_STARTED: &str = "thread/started";
    pub const TURN_STARTED: &str = "turn/started";
    pub const TURN_COMPLETED: &str = "turn/completed";
    pub const ITEM_STARTED: &str = "item/started";
    pub const ITEM_DELTA: &str = "item/delta";
    pub const ITEM_COMPLETED: &str = "item/completed";
    pub const TERMINAL_OUTPUT: &str = "terminal/output";
    pub const TERMINAL_EXIT: &str = "terminal/exit";

    pub const APPROVAL_REQUEST: &str = "approval/request";
    pub const APPROVAL_RESOLVED: &str = "approval/resolved";
    pub const QUESTION_REQUEST: &str = "question/request";
    pub const QUESTION_RESOLVED: &str = "question/resolved";
}

/// JSON-RPC request ids may be numbers or strings. `null` is intentionally
/// excluded: a message without an id is a notification.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    String(String),
}

impl From<u64> for RequestId {
    fn from(value: u64) -> Self {
        Self::Number(value)
    }
}

impl From<String> for RequestId {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<&str> for RequestId {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

fn jsonrpc_version() -> String {
    JSONRPC_VERSION.to_owned()
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// A client-to-server or server-to-client request envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request<P = Value> {
    #[serde(default = "jsonrpc_version")]
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    pub params: P,
}

impl<P> Request<P> {
    pub fn new(id: impl Into<RequestId>, method: impl Into<String>, params: P) -> Self {
        Self {
            jsonrpc: jsonrpc_version(),
            id: id.into(),
            method: method.into(),
            params,
        }
    }
}

/// A notification envelope. Notifications never carry an id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notification<P = Value> {
    #[serde(default = "jsonrpc_version")]
    pub jsonrpc: String,
    pub method: String,
    pub params: P,
}

impl<P> Notification<P> {
    pub fn new(method: impl Into<String>, params: P) -> Self {
        Self {
            jsonrpc: jsonrpc_version(),
            method: method.into(),
            params,
        }
    }
}

/// A JSON-RPC response envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response<R = Value> {
    #[serde(default = "jsonrpc_version")]
    pub jsonrpc: String,
    pub id: RequestId,
    #[serde(flatten)]
    pub payload: ResponsePayload<R>,
}

impl<R> Response<R> {
    pub fn success(id: impl Into<RequestId>, result: R) -> Self {
        Self {
            jsonrpc: jsonrpc_version(),
            id: id.into(),
            payload: ResponsePayload::Success { result },
        }
    }

    pub fn error(id: impl Into<RequestId>, error: RpcError) -> Self {
        Self {
            jsonrpc: jsonrpc_version(),
            id: id.into(),
            payload: ResponsePayload::Error { error },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponsePayload<R = Value> {
    Success { result: R },
    Error { error: RpcError },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Shape-based representation useful at transport boundaries before method
/// dispatch converts params/results into their method-specific types.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Message {
    Request(Request<Value>),
    Response(Response<Value>),
    Notification(Notification<Value>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ImplementationInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    #[serde(default)]
    pub experimental: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub approvals: bool,
    pub questions: bool,
    pub thread_resume: bool,
    #[serde(default)]
    pub experimental: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: String,
    pub client_info: ImplementationInfo,
    #[serde(default)]
    pub capabilities: ClientCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub server_info: ImplementationInfo,
    pub capabilities: ServerCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Experimental workspace command forwarded by the Studio gateway.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceExecuteParams {
    /// File-version pin for workspace_read_file_chunk; requires workspaceBinaryRevisionV1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    pub command_key: String,
    #[serde(
        default,
        rename = "threadId",
        alias = "thread_id",
        skip_serializing_if = "Option::is_none"
    )]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceExecuteResult {
    pub success: bool,
    pub exit_code: i32,
    pub stdout: Value,
    pub stderr: String,
}

/// Additive v1 workspace binary read receipt. Old clients retain metadata-only reads.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceFileChunkResult {
    pub path: String,
    pub name: String,
    pub content_base64: String,
    pub offset: u64,
    pub eof: bool,
    pub size: u64,
    pub modified_at: Option<String>,
    pub revision: String,
}

pub const WORKSPACE_FILE_CHANGED: &str = "workspace_file_changed";

/// Copy a connection-owned staged upload into the selected workspace.
/// Replacing an existing file requires explicit confirmation of its current
/// revision; filenames must be single path components.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceImportAttachmentParams {
    pub attachment_path: String,
    pub parent_path: String,
    pub filename: String,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportAttachmentResult {
    pub status: String,
    pub revision: Option<String>,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

/// Experimental browser attachment staging request. Base64 keeps the request safely bounded;
/// JSON arrays of individual bytes have more than four times the wire overhead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentSaveParams {
    pub filename: String,
    pub content_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<AttachmentRetentionUploadOptions>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentSaveResult {
    pub path: String,
    #[serde(default, rename = "stageRef", skip_serializing_if = "Option::is_none")]
    pub stage_ref: Option<RetentionStageRefV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentUploadStartParams {
    pub filename: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<AttachmentRetentionUploadOptions>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentUploadStartResult {
    pub upload_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<RetentionUploadRecoveryV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentUploadChunkParams {
    pub upload_id: String,
    pub index: u32,
    pub content_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<AttachmentRetentionUploadContinuation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachmentUploadFinishParams {
    pub upload_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<AttachmentRetentionUploadContinuation>,
    /// Explicit Office acceptance metadata. Native upload completion, not this
    /// scope or any JSON path, establishes ownership of the source bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub office_input: Option<kcoder_types::integrations::core::IntegrationRequest>,
}

/// Legacy upload callers receive Saved unchanged; opted-in Office callers
/// receive only the closed public material receipt, never the staging path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AttachmentUploadFinishResult {
    Saved(AttachmentSaveResult),
    Office(kcoder_types::integrations::office::OfficeMaterialReceipt),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentUploadCancelParams {
    pub upload_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<AttachmentRetentionUploadContinuation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
/// Deletes only a staged upload owned by this app-server stdio connection.
/// A previous successful explicit delete on that same connection may be
/// acknowledged again; unknown or materialized paths grant no delete authority.
pub struct AttachmentDeleteParams {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReadParams {
    pub thread_id: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReadResult {
    pub content_base64: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReadChunkParams {
    pub thread_id: String,
    pub path: String,
    pub offset: u64,
    pub length: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReadChunkResult {
    pub content_base64: String,
    pub offset: u64,
    pub size: u64,
    pub total_size: u64,
    pub eof: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserPreflightResult {
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserStartParams {
    pub url: String,
    #[serde(default = "default_browser_width")]
    pub width: u32,
    #[serde(default = "default_browser_height")]
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<browser_profiles::BrowserProfileSelection>,
}

fn default_browser_width() -> u32 {
    1024
}

fn default_browser_height() -> u32 {
    720
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserStartResult {
    pub session_id: String,
    pub url: String,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub sandbox_disabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<kcoder_types::browser_profiles::BrowserAccountProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserSessionParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub struct BrowserActionParams {
    pub session_id: String,
    #[serde(flatten)]
    pub action: BrowserAction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum BrowserAction {
    Navigate {
        url: String,
    },
    Reload,
    Back,
    Forward,
    Resize {
        width: u32,
        height: u32,
    },
    Click {
        x: f64,
        y: f64,
    },
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
    },
    PointerMove {
        x: f64,
        y: f64,
    },
    PointerDown {
        x: f64,
        y: f64,
    },
    PointerUp {
        x: f64,
        y: f64,
    },
    Text {
        text: String,
    },
    Key {
        key: String,
    },
    Shortcut {
        key: String,
        modifiers: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserActionResult {
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<BrowserPageState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserEvaluateParams {
    pub session_id: String,
    pub expression: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserEvaluateResult {
    pub value: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageState {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favicon_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_go_back: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_go_forward: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserScreenshotResult {
    pub session_id: String,
    pub data_base64: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub page: BrowserPageState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserCloseResult {
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalStartParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default = "default_terminal_rows")]
    pub rows: u16,
    #[serde(default = "default_terminal_cols")]
    pub cols: u16,
}

fn default_terminal_rows() -> u16 {
    24
}

fn default_terminal_cols() -> u16 {
    80
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalStartResult {
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TerminalListParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub through_sequence: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalListResult {
    pub sessions: Vec<TerminalSessionInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalAttachParams {
    pub session_id: String,
    #[serde(default = "default_terminal_rows")]
    pub rows: u16,
    #[serde(default = "default_terminal_cols")]
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalAttachResult {
    pub session_id: String,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub transcript: String,
    pub through_sequence: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalWriteParams {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalResizeParams {
    pub session_id: String,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCloseParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCloseResult {
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalOutputParams {
    pub session_id: String,
    pub data: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalExitParams {
    pub session_id: String,
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartParams {
    /// Initial expert selection; later changes take effect on the next turn.
    /// Requires agentDefinitionsV1 and never expands tool authorization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_definition: Option<kcoder_types::agent_definition::AgentDefinitionRef>,
    /// Temporary stdio MCP launches; requires threadMcpServersV1 and is never persisted as settings.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "thread_mcp::deserialize_thread_mcp_servers"
    )]
    pub mcp_servers: Vec<ThreadMcpServerV1>,
    /// Studio intent; absent means the legacy KCoder mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub studio_work_mode: Option<StudioWorkMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_definition_id: Option<String>,
    /// Stable creation operation identity; requires threadCreationReceiptsV1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_mode: Option<ThreadSessionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Session-level settings template id; absent keeps the profile baseline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_template: Option<String>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartResult {
    pub thread: Thread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_partial: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListResult {
    pub threads: Vec<Thread>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completeness: Option<ThreadListCompleteness>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_count: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadListCompleteness {
    Complete,
    Partial,
}

/// Three-state field patch: absent retains the value, a string sets it, and JSON null clears it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum MetadataUpdate<T> {
    #[default]
    Unchanged,
    Set(T),
    Clear,
}

impl<T> MetadataUpdate<T> {
    pub fn is_unchanged(&self) -> bool {
        matches!(self, Self::Unchanged)
    }
}

impl<T: Serialize> Serialize for MetadataUpdate<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Set(value) => value.serialize(serializer),
            Self::Clear | Self::Unchanged => serializer.serialize_none(),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for MetadataUpdate<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Set(value),
            None => Self::Clear,
        })
    }
}

/// Persistable parent-chain location between a Studio task and an app-server thread.
///
/// Early Studio versions sent this object as a JSON-encoded string. Deserialization
/// still accepts that form, while the server and all new clients always emit a structured object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadParent {
    pub task_id: String,
    pub thread_id: String,
    pub last_turn_id: String,
}

impl<'de> Deserialize<'de> for ThreadParent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct WireThreadParent {
            task_id: String,
            thread_id: String,
            last_turn_id: String,
        }

        let value = Value::deserialize(deserializer)?;
        let value = match value {
            Value::String(encoded) => serde_json::from_str(&encoded).map_err(|error| {
                serde::de::Error::custom(format!("invalid parent JSON: {error}"))
            })?,
            value => value,
        };
        let wire: WireThreadParent = serde_json::from_value(value)
            .map_err(|error| serde::de::Error::custom(format!("invalid thread parent: {error}")))?;
        Ok(Self {
            task_id: wire.task_id,
            thread_id: wire.thread_id,
            last_turn_id: wire.last_turn_id,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadataUpdateParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "MetadataUpdate::is_unchanged")]
    pub title: MetadataUpdate<String>,
    #[serde(default, skip_serializing_if = "MetadataUpdate::is_unchanged")]
    pub model: MetadataUpdate<String>,
    #[serde(default, skip_serializing_if = "MetadataUpdate::is_unchanged")]
    pub archived_at: MetadataUpdate<String>,
    #[serde(default, skip_serializing_if = "MetadataUpdate::is_unchanged")]
    pub parent: MetadataUpdate<ThreadParent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadataUpdateResult {
    pub thread: Thread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_changes_capture: Option<TurnFileChangesCapture>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_evidence: Option<TurnReviewEvidence>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued_by_attempt_id: Option<String>,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_failure: Option<kcoder_types::ProviderFailureDetails>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<Value>,
    pub timestamp_ms: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub content_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_original_chars: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadResult {
    pub thread: Thread,
    pub messages: Vec<ThreadMessage>,
    pub range_start: usize,
    pub range_end: usize,
    pub has_more_before: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_cursor: Option<String>,
    /// Omitted unless this connection opted into threadTranscriptSnapshotV1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_snapshot_v1: Option<ThreadTranscriptSnapshotV1>,
    /// Omitted unless opted into threadTranscriptObservationV1 and this read has complete proof.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_observation_v1: Option<ThreadTranscriptObservationV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<ThreadResumeHistoryOptionsV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeResult {
    pub thread: Thread,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<ThreadResumeHistoryV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_context: Option<ThreadStreamContextV1>,
}

/// Negotiated live stream boundary; absence means unknown, not idle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadStreamContextV1 {
    pub server_id: String,
    /// Inclusive notification sequence watermark sampled with the live turn identity.
    pub through_sequence: u64,
    /// Explicit null confirms that no main turn is active at this boundary.
    pub active_turn: ThreadStreamActiveTurnV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum ThreadStreamActiveTurnV1 {
    Running(ThreadStreamTurnV1),
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadStreamTurnV1 {
    pub id: String,
    pub thread_id: String,
    pub attempt_id: String,
    pub status: TurnStatus,
}

impl From<Option<ThreadStreamTurnV1>> for ThreadStreamActiveTurnV1 {
    fn from(turn: Option<ThreadStreamTurnV1>) -> Self {
        turn.map(Self::Running).unwrap_or(Self::Idle)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadForkParams {
    pub thread_id: String,
    #[serde(default)]
    pub last_turn_id: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub ephemeral: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub exclude_turns: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadForkResult {
    pub thread: Thread,
    #[serde(default, skip_serializing_if = "is_false")]
    pub ephemeral: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCompactParams {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCompactResult {
    pub thread_id: String,
    pub compacted: bool,
    pub pre_tokens: usize,
    pub post_tokens: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRollbackParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRollbackResult {
    pub thread_id: String,
    pub turn: u64,
    pub removed_messages: usize,
    pub restored_files: usize,
    pub deleted_files: usize,
    pub failed_files: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_goal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalSetParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub edit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_goal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub require_no_goal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<u64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub clear_token_budget: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoal {
    pub thread_id: String,
    #[serde(default)]
    pub goal_id: String,
    pub objective: String,
    pub mode: String,
    #[serde(default = "default_goal_verification_kind")]
    pub verification_kind: String,
    pub status: String,
    pub token_budget: Option<u64>,
    pub tokens_used: u64,
    pub time_used_seconds: u64,
    #[serde(default)]
    pub turn_count: u64,
    #[serde(default)]
    pub blocked_candidate_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker_reason: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<ThreadGoalEvent>,
}

fn default_goal_verification_kind() -> String {
    "artifact".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalEvent {
    pub kind: String,
    pub timestamp: u64,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalGetResult {
    pub thread_id: String,
    pub goal: Option<ThreadGoal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalContinuationParams {
    pub thread_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalHistoryResult {
    pub thread_id: String,
    pub goals: Vec<ThreadGoal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalSetResult {
    pub thread_id: String,
    pub goal: ThreadGoal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalClearResult {
    pub thread_id: String,
    pub cleared: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDeleteParams {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDeleteResult {
    pub thread_id: String,
    pub deleted: bool,
    pub deleted_files: usize,
}

/// Server-authoritative snapshot of client thread metadata.
///
/// Optional domain fields deliberately retain None, allowing clients to distinguish
/// a value cleared by the server from an older server without authoritative metadata support.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_definition_id: Option<String>,
    pub schema: String,
    pub version: u32,
    pub revision: u64,
    pub title: Option<String>,
    pub model: Option<String>,
    pub archived_at: Option<String>,
    pub parent: Option<ThreadParent>,
}

impl Default for ThreadMetadata {
    fn default() -> Self {
        Self {
            workflow_definition_id: None,
            schema: THREAD_METADATA_SCHEMA.into(),
            version: 1,
            revision: 0,
            title: None,
            model: None,
            archived_at: None,
            parent: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    Idle,
    Running,
    WaitingForApproval,
    WaitingForAnswer,
    Failed,
    /// The main turn is finished but a background run is still working.
    Background,
    /// Only delivery/aggregation of finished background work is outstanding.
    Aggregating,
    /// Authoritative run facts could not be read; never report this as idle.
    Unknown,
}

/// Client capability that opts a connection into the richer run projection.
/// Explicit user cancellation with retained Goal history and fallible persistence.
pub const CAPABILITY_GOAL_CANCELLATION_V1: &str = "goalCancellationV1";

pub const CAPABILITY_RETRY_MODEL_CONFIGURATION_V1: &str = "retryModelConfigurationV1";
pub const CAPABILITY_THREAD_RUN_SUMMARY_V1: &str = "threadRunSummaryV1";
pub const CAPABILITY_THREAD_STREAM_CONTEXT_V1: &str = "threadStreamContextV1";
pub const CAPABILITY_INTERACTION_STATUS_READ_V1: &str = "interactionStatusReadV1";

/// Client capability that makes an interaction reply name the interaction it
/// answers. Without it the transport id is the only correlation, and an id
/// issued by an earlier connection generation can collide with a new one.
pub const CAPABILITY_INTERACTION_BINDING_V1: &str = "interactionBindingV1";
/// Bind permission requests to the exact tool call; request field is opt-in.
pub const CAPABILITY_APPROVAL_TOOL_CALL_IDENTITY_V1: &str = "approvalToolCallIdentityV1";
/// A client explicitly opts out of user-question and plan-confirmation tools.
pub const CAPABILITY_DISABLE_USER_ELICITATION_V1: &str = "disableUserElicitationV1";

/// Client capability that lets a client declare a deliberate re-submission of an
/// already committed message identity. Without it, submitting a committed
/// `clientMessageId` again is refused, so a retry after an unknown outcome can
/// never duplicate the turn.
pub const CAPABILITY_TURN_SUBMISSION_V1: &str = "turnSubmissionV1";

/// Client capability that lets a client name the recovery it is asking for, so a
/// repeated or cross-client retry of the same failed turn is recognised as the
/// same operation instead of being mistaken for a new one.
pub const CAPABILITY_TURN_RETRY_OPERATION_V1: &str = "turnRetryOperationV1";

/// Recovery names an exact failed attempt and preserves earlier terminal receipts.
pub const CAPABILITY_TURN_ATTEMPT_RETRY_V1: &str = "turnAttemptRetryV1";

/// Server capability that a failed turn can be continued at all, with the input
/// context verified against the boundary that was committed. A client that does
/// not see this must say so and offer an upgrade instead of quietly re-sending
/// the turn as new work.
pub const CAPABILITY_FAILED_TURN_CONTINUATION_V1: &str = "failedTurnContinuationV1";

/// Main-turn component of [`ThreadRunFacts`]; `Unknown` means "unreadable", not "idle".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadMainTurn {
    Idle,
    Running,
    Unknown,
}

/// Authoritative per-thread run facts.
///
/// Every field is `None` when the owning runtime could not read it without
/// blocking (for example while the projection lock is held). Consumers must
/// treat `None` as "unknown" and must not substitute a heuristic default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ThreadRunFacts {
    pub main_turn_running: Option<bool>,
    pub pending_approvals: Option<u32>,
    pub pending_questions: Option<u32>,
    /// Live background jobs registered by the owning engine.
    pub active_jobs: Option<u32>,
    /// Persisted task records that have not started yet.
    pub tasks_pending: Option<u32>,
    /// Persisted task records currently running.
    pub tasks_running: Option<u32>,
    /// Finished background runs whose result is still pending delivery/aggregation.
    pub pending_followups: Option<u32>,
    /// Scheduled goal continuations that are due.
    pub pending_goals: Option<u32>,
}

/// Wire projection of [`ThreadRunFacts`] for capabilities-negotiated consumers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRunSummary {
    pub main_turn: ThreadMainTurn,
    /// Latest committed attempt only; absent for new, legacy, or unconfirmed history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_turn_status: Option<TurnStatus>,
    /// Absent = unknown (old or unreadable evidence); null = confirmed no failure.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "recent_error::deserialize_present"
    )]
    pub recent_error: Option<Option<ThreadRecentError>>,
    /// Explicit `null` means unknown; `0` means known-idle.
    pub pending_approvals: Option<u32>,
    pub pending_questions: Option<u32>,
    pub active_jobs: Option<u32>,
    pub tasks_pending: Option<u32>,
    pub tasks_running: Option<u32>,
    pub pending_followups: Option<u32>,
    pub pending_goals: Option<u32>,
}

impl ThreadRunFacts {
    /// The single authoritative run-state rule shared by every consumer.
    ///
    /// Order follows the status projection table: a pending user interaction is
    /// more actionable than a running turn, background work outlives the main
    /// turn, and delivery is the last thing outstanding.
    pub fn state(&self) -> ThreadStatus {
        let any_unknown = self.main_turn_running.is_none()
            || self.pending_approvals.is_none()
            || self.pending_questions.is_none()
            || self.active_jobs.is_none()
            || self.tasks_pending.is_none()
            || self.tasks_running.is_none()
            || self.pending_followups.is_none()
            || self.pending_goals.is_none();

        if self.pending_approvals.is_some_and(|count| count > 0) {
            return ThreadStatus::WaitingForApproval;
        }
        if self.pending_questions.is_some_and(|count| count > 0) {
            return ThreadStatus::WaitingForAnswer;
        }
        if self.main_turn_running == Some(true) {
            return ThreadStatus::Running;
        }
        if self.active_jobs.is_some_and(|count| count > 0)
            || self.tasks_running.is_some_and(|count| count > 0)
            || self.tasks_pending.is_some_and(|count| count > 0)
            || self.pending_goals.is_some_and(|count| count > 0)
        {
            return ThreadStatus::Background;
        }
        if self.pending_followups.is_some_and(|count| count > 0) {
            return ThreadStatus::Aggregating;
        }
        if any_unknown {
            return ThreadStatus::Unknown;
        }
        ThreadStatus::Idle
    }

    pub fn summary(&self) -> ThreadRunSummary {
        ThreadRunSummary {
            main_turn: match self.main_turn_running {
                Some(true) => ThreadMainTurn::Running,
                Some(false) => ThreadMainTurn::Idle,
                None => ThreadMainTurn::Unknown,
            },
            recent_error: None,
            latest_turn_status: None,
            pending_approvals: self.pending_approvals,
            pending_questions: self.pending_questions,
            active_jobs: self.active_jobs,
            tasks_pending: self.tasks_pending,
            tasks_running: self.tasks_running,
            pending_followups: self.pending_followups,
            pending_goals: self.pending_goals,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_task_source: Option<kcoder_types::agent_definition::ChannelTaskSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_definition: Option<kcoder_types::agent_definition::AgentTaskBinding>,
    /// Studio intent; absent means the legacy KCoder mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub studio_work_mode: Option<StudioWorkMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_definition_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_mode: Option<ThreadSessionMode>,
    pub id: String,
    pub status: ThreadStatus,
    /// Authoritative run facts; present only for consumers that negotiated
    /// [`CAPABILITY_THREAD_RUN_SUMMARY_V1`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_summary: Option<ThreadRunSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Authoritative selection intent; absent on older servers or unavailable history projections.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection_mode: Option<kcoder_types::ModelSelectionMode>,
    /// Last committed provider-qualified model; distinct from client display metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<ThreadParent>,
    #[serde(default)]
    pub metadata: ThreadMetadata,
    /// Frozen session-level settings template binding (id + content revision).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_template: Option<SettingsTemplateBinding>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UserInput {
    Text { text: String },
    Image { url: String },
}

pub const CAPABILITY_CHANNEL_TOOL_RESTRICTIONS_V1: &str = "channelToolRestrictionsV1";

pub const CAPABILITY_UNATTENDED_TURNS_V1: &str = "unattendedTurnsV1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
    /// Restrict only this turn to existing tool permissions without human interaction.
    /// This never grants permissions or changes the persisted task policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unattended: Option<bool>,
    /// Immutable channel policy for this unattended turn; never changes tool schemas.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_tool_restrictions:
        Option<kcoder_types::channel_tool_restrictions::ChannelToolRestrictions>,
    /// Current foreground client declaration; never inherited from history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_presentation: Option<ClientPresentationV1>,
    /// Per-request async question declaration. Gateways must overwrite it from the
    /// capability negotiated for the requesting client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub async_user_questions: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<TurnRetentionRequestV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer_use: Option<ComputerUseTurnAuthorization>,
    /// Current requires retryModelConfigurationV1 and an exact failed attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_model_configuration: Option<kcoder_types::RetryModelConfiguration>,
    /// Continue the latest failed provider step without appending another user message.
    /// Requires failedTurnContinuationV1; input must be empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_from_turn_id: Option<String>,
    /// Exact failed attempt to continue; requires turnAttemptRetryV1 and retryOperationId.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_from_attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_mode: Option<TurnExecutionMode>,
    pub thread_id: String,
    pub input: Vec<UserInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    /// Declares a deliberate new attempt for a `client_message_id` that was
    /// already committed (regenerate or the legacy re-send path). Requires
    /// [`CAPABILITY_TURN_SUBMISSION_V1`]; omitting it makes a duplicate
    /// submission fail instead of appending a second user message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resubmit: Option<bool>,
    /// Names one recovery of one failed turn. Repeating it, from this connection
    /// or another, must be answered with the attempt that already accepted it;
    /// reusing it for a different failed turn is refused. Only meaningful
    /// together with `retryFromTurnId`. Requires
    /// [`CAPABILITY_TURN_RETRY_OPERATION_V1`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Omitted preserves legacy selection semantics. Requires explicit capability
    /// negotiation before a client may request target-default following.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection_mode: Option<kcoder_types::ModelSelectionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
}

impl TurnStartParams {
    pub fn validate_model_selection(&self) -> Result<(), &'static str> {
        if self.retry_model_configuration.is_some() && self.retry_from_turn_id.is_none() {
            return Err("retryModelConfiguration requires retryFromTurnId");
        }
        if self.retry_model_configuration == Some(kcoder_types::RetryModelConfiguration::Current)
            && [
                self.model.as_deref(),
                self.retry_from_attempt_id.as_deref(),
                self.retry_operation_id.as_deref(),
            ]
            .into_iter()
            .any(|value| value.is_none_or(|value| value.trim().is_empty()))
        {
            return Err(
                "current retryModelConfiguration requires an explicit model, retryFromAttemptId and retryOperationId",
            );
        }
        match self.model_selection_mode {
            Some(kcoder_types::ModelSelectionMode::FollowTargetDefault) => {
                if self.model.is_some() {
                    return Err("follow_target_default cannot include model");
                }
                if self.retry_from_turn_id.is_some() {
                    return Err(
                        "A failed-turn continuation cannot change to target-default following",
                    );
                }
            }
            Some(kcoder_types::ModelSelectionMode::Explicit)
                if self
                    .model
                    .as_deref()
                    .is_none_or(|model| model.trim().is_empty()) =>
            {
                return Err("explicit model selection requires a nonempty model");
            }
            Some(kcoder_types::ModelSelectionMode::Explicit) | None => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartResult {
    pub turn: Turn,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadSessionMode {
    #[default]
    Default,
    Orchestrate,
    WorkflowDraft,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnExecutionMode {
    #[default]
    Standard,
    Moa,
    MoaPlan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSessionModeSetParams {
    pub thread_id: String,
    pub mode: ThreadSessionMode,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModesParams {
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModesResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_definition_id: Option<String>,
    pub session_mode: ThreadSessionMode,
    pub moa_summary: String,
    pub moa_plan_planners: Vec<String>,
    pub moa_plan_error: Option<String>,
    /// Recorded settings-template binding of this session; `None` when it uses the store default.
    #[serde(default)]
    pub settings_template: Option<SettingsTemplateBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptParams {
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptResult {
    pub interrupted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum TurnStatus {
    Running,
    Completed,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub struct Turn {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    /// Locator only; reading the canonical reviewed-memory snapshot rechecks authorization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_snapshot_id: Option<String>,
    pub thread_id: String,
    pub status: TurnStatus,
}

/// Routing and ordering metadata repeated on every streaming notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventContext {
    pub server_id: String,
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub sequence: u64,
}

/// A background event retains its logical identity across transport reconnects.
/// Legacy producers omit `identity`; run-aware producers advertise
/// `backgroundRunIdentityV1` and include it on every background notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundEventContext {
    #[serde(flatten)]
    pub context: EventContext,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<kcoder_types::BackgroundEventIdentity>,
}

/// The existing `item/event` payload with optional run-scoped background metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundItemEventParams {
    #[serde(flatten)]
    pub context: BackgroundEventContext,
    pub event: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    UserMessage,
    AgentMessage,
    Reasoning,
    ToolCall,
    ToolResult,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ItemKind,
    #[serde(default)]
    pub content: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartedParams {
    #[serde(flatten)]
    pub context: EventContext,
    pub thread: Thread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartedParams {
    /// Distinguishes a continuation's display stream from earlier failed output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(flatten)]
    pub context: EventContext,
    pub turn: Turn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompletedParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_changes_capture: Option<TurnFileChangesCapture>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_evidence: Option<TurnReviewEvidence>,
    #[serde(flatten)]
    pub context: EventContext,
    pub turn: Turn,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemStartedParams {
    #[serde(flatten)]
    pub context: EventContext,
    pub item: Item,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDeltaParams {
    #[serde(flatten)]
    pub context: EventContext,
    pub item_id: String,
    pub delta: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemCompletedParams {
    #[serde(flatten)]
    pub context: EventContext,
    pub item: Item,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestParams {
    /// Present only when approvalToolCallIdentityV1 was negotiated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub server_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub approval_id: String,
    /// Opaque app-server lifetime that prevents a transport id from being reused after restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_server_epoch: Option<String>,
    pub action: ApprovalAction,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ApprovalAction {
    Command { command: String },
    FileChange { path: String },
    Tool { name: String, input: Value },
}

#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResponse {
    pub decision: ApprovalDecision,
    /// Interaction this reply answers. Required once the connection negotiated
    /// [`CAPABILITY_INTERACTION_BINDING_V1`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

impl ApprovalResponse {
    /// Every identity field the reply must echo to be attributable.
    pub fn binding(&self) -> (Option<&str>, Option<&str>, Option<&str>) {
        (
            self.approval_id.as_deref(),
            self.thread_id.as_deref(),
            self.turn_id.as_deref(),
        )
    }
}

/// Server notification after an approval request reaches a terminal state, allowing clients to close its pending card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResolvedParams {
    pub request_id: u64,
    pub approval_id: String,
    pub thread_id: String,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_server_epoch: Option<String>,
    pub decision: ApprovalDecision,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequestParams {
    pub server_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub question_id: String,
    /// Opaque app-server lifetime that prevents a transport id from being reused after restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_server_epoch: Option<String>,
    pub questions: Vec<Question>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
    /// Actual worker identity supplied by the host, never by tool input annotations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_agent: Option<kcoder_types::SourceAgent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub header: String,
    pub prompt: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub allows_freeform: bool,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub value: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionAnswer {
    #[serde(default)]
    pub answers: Vec<String>,
}

#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResponse {
    pub answers: BTreeMap<String, QuestionAnswer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
    /// Interaction this reply answers. Required once the connection negotiated
    /// [`CAPABILITY_INTERACTION_BINDING_V1`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

impl QuestionResponse {
    /// Every identity field the reply must echo to be attributable.
    pub fn binding(&self) -> (Option<&str>, Option<&str>, Option<&str>) {
        (
            self.question_id.as_deref(),
            self.thread_id.as_deref(),
            self.turn_id.as_deref(),
        )
    }
}

/// Server notification after a question request reaches a terminal state; clients cannot infer server receipt from socket send alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResolvedParams {
    pub request_id: u64,
    pub question_id: String,
    pub thread_id: String,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_server_epoch: Option<String>,
    pub reason: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("JSONL line is empty")]
    EmptyLine,
    #[error("JSONL record contains an embedded newline")]
    EmbeddedNewline,
    #[error("invalid JSONL record: {0}")]
    Json(#[from] serde_json::Error),
}

/// Serialize one message as a compact JSONL record, including its trailing LF.
pub fn encode_line<T: Serialize>(message: &T) -> Result<String, CodecError> {
    let mut encoded = serde_json::to_string(message)?;
    encoded.push('\n');
    Ok(encoded)
}

/// Deserialize one JSONL record. A single trailing LF or CRLF is accepted;
/// blank lines and multiple physical records are rejected.
pub fn decode_line<T: DeserializeOwned>(line: &str) -> Result<T, CodecError> {
    let record = line
        .strip_suffix("\r\n")
        .or_else(|| line.strip_suffix('\n'))
        .unwrap_or(line);

    if record.trim().is_empty() {
        return Err(CodecError::EmptyLine);
    }
    if record.contains(['\r', '\n']) {
        return Err(CodecError::EmbeddedNewline);
    }
    Ok(serde_json::from_str(record)?)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod model_selection_contract_tests {
    use super::*;
    #[test]
    fn current_retry_requires_complete_failed_attempt_identity_and_explicit_model() {
        let value = serde_json::json!({"threadId":"thread","input":[],"retryFromTurnId":"turn","retryFromAttemptId":"attempt","retryOperationId":"operation","model":"provider::model","retryModelConfiguration":"current"});
        let parse = |value| serde_json::from_value::<TurnStartParams>(value).unwrap();
        assert!(parse(value.clone()).validate_model_selection().is_ok());
        for field in [
            "retryFromTurnId",
            "retryFromAttemptId",
            "retryOperationId",
            "model",
        ] {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                parse(missing).validate_model_selection().is_err(),
                "{field}"
            );
        }
    }
    #[test]
    fn turn_selection_intent_is_explicit_and_validated() {
        let parse = |extra: serde_json::Value| {
            let mut value = serde_json::json!({"threadId":"fixture","input":[]});
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            serde_json::from_value::<TurnStartParams>(value).unwrap()
        };
        let legacy = parse(serde_json::json!({}));
        assert!(legacy.validate_model_selection().is_ok());
        assert!(
            serde_json::to_value(&legacy)
                .unwrap()
                .get("modelSelectionMode")
                .is_none()
        );
        assert!(
            parse(serde_json::json!({"modelSelectionMode":"follow_target_default"}))
                .validate_model_selection()
                .is_ok()
        );
        for invalid in [
            serde_json::json!({"modelSelectionMode":"explicit"}),
            serde_json::json!({"modelSelectionMode":"explicit","model":" "}),
            serde_json::json!({"modelSelectionMode":"follow_target_default","model":"vendor::model"}),
            serde_json::json!({"modelSelectionMode":"follow_target_default","retryFromTurnId":"turn-1"}),
        ] {
            assert!(parse(invalid).validate_model_selection().is_err());
        }
    }
}

mod knowledge;
pub use knowledge::*;

mod knowledge_archive;
pub use knowledge_archive::*;

mod turn_review_evidence;
pub use turn_review_evidence::*;
pub mod task_comparison;
pub use task_comparison::*;
pub mod task_delivery;
pub use task_delivery::*;
pub mod browser_profiles;
