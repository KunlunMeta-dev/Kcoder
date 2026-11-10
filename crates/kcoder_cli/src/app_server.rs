//! Machine-readable app-server transport for GUI and remote clients.
//!
//! The first transport is deliberately small: one JSON object per line on
//! stdin/stdout. Logs must stay on stderr so an SSH process can use stdout as a
//! clean bidirectional protocol stream.

use crate::{HeadlessPermissionPrompt, engine_event_json};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use fs2::FileExt;
use futures::StreamExt;
use kcoder_app_protocol::{
    AgentArtifactReadParams, AgentListParams, AgentListResult, AgentSteerParams, AgentSteerResult,
    AgentSteerStatus, AgentSummary, ApprovalAction, ApprovalDecision, ApprovalRequestParams,
    ApprovalResolvedParams, ApprovalResponse, AttachmentDeleteParams, AttachmentReadChunkParams,
    AttachmentReadParams, AttachmentSaveParams, AttachmentUploadCancelParams,
    AttachmentUploadChunkParams, AttachmentUploadFinishParams, AttachmentUploadStartParams,
    BrowserActionParams, BrowserEvaluateParams, BrowserSessionParams, BrowserStartParams,
    DeviceExecuteParams, DeviceExecuteResult, ImplementationInfo, InitializeParams,
    InitializeResult, JSONRPC_VERSION, MetadataUpdate, PROTOCOL_VERSION, Question, QuestionOption,
    QuestionRequestParams, QuestionResolvedParams, QuestionResponse, ServerCapabilities,
    SettingsTemplateBinding, SettingsTemplateDefaultParams, SettingsTemplateDeleteParams,
    SettingsTemplateReadParams, SettingsTemplateSaveParams, StorageCleanParams,
    THREAD_METADATA_SCHEMA, TerminalAttachParams, TerminalCloseParams, TerminalListParams,
    TerminalResizeParams, TerminalStartParams, TerminalWriteParams, Thread, ThreadCompactParams,
    ThreadCompactResult, ThreadDeleteParams, ThreadDeleteResult, ThreadForkParams,
    ThreadForkResult, ThreadGoal, ThreadGoalClearResult, ThreadGoalEvent, ThreadGoalGetResult,
    ThreadGoalHistoryResult, ThreadGoalParams, ThreadGoalSetParams, ThreadGoalSetResult,
    ThreadListParams, ThreadMessage, ThreadMetadataUpdateParams, ThreadMetadataUpdateResult,
    ThreadParent, ThreadReadParams, ThreadReadResult, ThreadRollbackParams, ThreadRollbackResult,
    ThreadStartParams, TurnFileChangesPolicy, TurnStartParams, method,
};
use kcoder_engine::{EngineEvent, QueryEngine};
use kcoder_mcp_app_storage::{ledger as mcp_apps_ledger, resources as mcp_apps_resources};
use kcoder_permissions::{PermissionPrompt, PermissionRequestContext, PermissionResponse};
use kcoder_state::{
    AgentMessageStatus, Goal, GoalMode, GoalStatus, GoalVerificationKind, GoalVerifierSelection,
    Task, TaskDelivery, TaskKind, TaskStatus,
};
use kcoder_tools::{UserQuestionRequest, UserQuestionResponse, UserQuestioner};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
#[cfg(test)]
use tokio::io::BufReader;
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

mod agent_artifacts;
use kcoder_attachment_retention::{
    self as attachment_retention, acceptance::TurnClientMessageArtifact,
};
mod attachment_retention_dispatch;
mod attachments;
mod computer_use_status;
mod config_templates;
mod connection_input;
mod cron_dispatch;
use cron_dispatch as cron_processor;
#[cfg(test)]
mod ct85_test_support;
#[cfg(any(windows, test))]
mod desktop_attachment;
#[cfg(any(windows, test))]
mod desktop_notifications;
mod desktop_recovery;
#[cfg(windows)]
mod desktop_turn;
#[cfg(test)]
mod engine_factory;
#[cfg(not(test))]
#[path = "app_server/engine_factory/host.rs"]
mod engine_factory;
mod execution_defaults;
mod git;
mod goal_lifecycle;
#[path = "app_server/history_catalog_adapter.rs"]
mod history_catalog;
#[path = "app_server/history_refresh_adapter.rs"]
mod history_refresh_processor;
mod hook_configuration;
mod indexed_read_gate;
mod indexed_transcript;
mod input_lifetime;
mod integration_requests;
mod integrations;
#[cfg(test)]
#[path = "../../kcoder_config/src/test_isolated_profile.rs"]
mod isolated_test_profile;
mod session_lifetime;
mod web_search;
pub(crate) use integrations::core::remote_delegations::original_read::entry as run_native_remote_read;
pub(crate) use integrations::knowledge::run_shared_publication_read_helper;
pub(crate) use integrations::office::run_read_worker as run_office_read_worker;
mod continuous_work_admission;
use kcoder_foreground_work::{continuous_work_mutation, continuous_work_read};
use kcoder_knowledge_rpc::{knowledge_archive, knowledge_requests};
mod knowledge_catalog_dispatch;
mod knowledge_directory;
mod knowledge_documents;
use kcoder_knowledge_rpc::knowledge_image_imports;
use kcoder_knowledge_rpc::knowledge_job_runner;
use kcoder_knowledge_rpc::knowledge_job_scheduler;
use kcoder_knowledge_rpc::knowledge_model;
mod knowledge_transfer;
pub(crate) use kcoder_knowledge_rpc::knowledge_worker;
use kcoder_knowledge_rpc::knowledge_worker_authority;
use kcoder_knowledge_rpc::knowledge_worker_model;
use kcoder_mcp_app_runtime::mcp_apps_registry;
mod mcp_apps_rpc;
use kcoder_mcp_app_runtime::mcp_apps_runtime;
use kcoder_mcp_app_runtime::mcp_apps_tool;
mod mcp_authorization_processor;
use kcoder_plugin_rpc::mcp_configuration;
mod mcp_processor;
mod migration_host;
use kcoder_migration_rpc::{self as migration_processor, migration_source_authority};
mod observed_transcript;
mod plugin_processor;
use kcoder_host_transport::protocol_io::{self, MAX_DEVICE_RESULT_BYTES};
use kcoder_project_automation::project_automations;
use kcoder_turn_evidence::private_files;
mod provider_probe;
mod provider_settings;
use kcoder_turn_lifecycle::recent_error;
#[cfg(test)]
mod recent_error_consumer_tests;
use kcoder_app_events::request_origin;
use kcoder_app_events::resident_turn::{ActiveTurn, ResidentTurnState};
use kcoder_host_transport::metadata::resources_processor;
mod resume_history;
use kcoder_session_configuration as session_configuration;
#[cfg(test)]
mod session_mcp;
#[cfg(not(test))]
use kcoder_engine_factory::app_server::session_mcp;
mod skill_processor;
use kcoder_cli_storage::storage_diagnostics;
use kcoder_cli_storage::storage_scans;
use kcoder_workspace_resources::snapshots::snapshot_leases;
mod studio_presentation;
use kcoder_cli_storage::thread_list_snapshots;
use kcoder_host_transport::task_spawn;
use kcoder_turn_lifecycle::thread_creations;
use kcoder_workspace_resources::{terminal, workspace_io, workspace_revision};
mod thread_runtime;
mod thread_stream_context;
use kcoder_transcript::tool_images;
mod tools_catalog;
mod tracked_history_list;
use kcoder_cli_storage::transcript_artifact_journal;
use kcoder_transcript::transcript_window;
use kcoder_transcript_observation as transcript_observation_artifacts;
use kcoder_turn_lifecycle::turn_admissions;
#[cfg(test)]
mod turn_admissions_consumer_tests;
use kcoder_turn_lifecycle::turn_attempts;
#[cfg(test)]
mod turn_attempts_consumer_tests;
use kcoder_app_events::turn_execution;
mod turn_file_changes_settings;
mod turn_receipts;
mod usage_processor;
mod widgets_dispatch;
mod workflow_canvas;
mod workspace_upload;

use attachments::{
    AttachmentDirectories, attachment_read, attachment_read_chunk, attachment_save,
    attachment_upload_cancel, attachment_upload_chunk, attachment_upload_finish,
    attachment_upload_start, clone_fork_attachments,
};
use config_templates::{resolve_session_template, user_template_store};
pub(super) use engine_factory::AppServerEngineFactory;
use git::run_git_command;
#[cfg(test)]
use git::{run_git_command_with_private_repository, run_git_command_with_stdin};
use kcoder_browser::{self as browser, BrowserRegistry};
use kcoder_plugin_rpc::PluginProcessor;
mod turn_permissions;
use private_files::{ensure_private_artifact_directory, hex_sha256, write_private_artifact_file};
use protocol_io::{
    JsonRpcLine, browser_success_response, error_response, notification, send, success_response,
};
#[cfg(test)]
use protocol_io::{MAX_ERROR_MESSAGE_BYTES, MAX_JSONRPC_LINE_BYTES};

#[cfg(test)]
async fn read_bounded_jsonrpc_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> anyhow::Result<Option<JsonRpcLine>> {
    protocol_io::JsonRpcLineState::default().read(reader).await
}
use terminal::{TerminalRegistry, TerminalRegistryGuard};
use thread_runtime::{ThreadManager, ThreadRuntime};

const OUTBOUND_CAPACITY: usize = 512;
const OUTBOUND_FRAME_LIMIT_BYTES: usize = 1_900_000;
const OUTBOUND_FRAME_LIMIT_CODE: i64 = -32045;
const NOT_INITIALIZED: i64 = -32002;
const TURN_ALREADY_RUNNING: i64 = -32003;
#[cfg(test)]
use kcoder_transcript::MAX_TRANSCRIPT_MESSAGE_BYTES;
const MAX_TRANSCRIPT_RESPONSE_BYTES: usize =
    kcoder_transcript::tool_images::TRANSCRIPT_RESPONSE_BYTES;
const BACKGROUND_PUMP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const ACTIVE_TURN_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

use kcoder_cli_storage::session_lease::SessionLease;

enum PreparedThreadResume {
    Resident {
        thread_id: String,
    },
    Persisted {
        prepared: Box<kcoder_state::PreparedSessionResume>,
        lease: SessionLease,
        client_turn_count: usize,
        /// Overlay path of the thread's recorded settings template, if it still exists.
        settings_template: Option<PathBuf>,
        /// Creation-time permission baseline, absent on legacy sessions and template-bound sessions.
        permission_mode_at_creation: Option<kcoder_config::PermissionMode>,
    },
}

#[derive(Debug, Default)]
struct ConnectionState {
    /// Set only by the connection owner for the actual selected input branch.
    request_origin: request_origin::RequestOrigin,
    continuous_work_read_v1: bool,
    continuous_work_partial_list_v1: bool,
    /// Draft durable input acceptance (`work/input/*`); never implies consumption.
    continuous_work_input_v1: bool,
    /// Draft control submission (`work/control`); never implies a settled resource.
    continuous_work_control_v1: bool,
    web_search_status_v1: bool,
    web_search_probe_v1: bool,
    web_search_diagnostics: web_search::SearchDiagnostics,
    #[cfg(target_os = "linux")]
    native_acp_receiver_closed:
        integrations::core::remote_delegations::receiver_acp_binding::ReceiverConnectionGuard,
    #[cfg(target_os = "linux")]
    native_acp_receiver_binding: Option<
        Arc<integrations::core::remote_delegations::receiver_acp_binding::NativeAcpReceiverBinding>,
    >,
    #[cfg(target_os = "linux")]
    native_acp_receiver_owner: Arc<
        StdMutex<
            Option<
                Arc<
                    integrations::core::remote_delegations::receiver_acp_binding::ReceiverTaskOwner,
                >,
            >,
        >,
    >,
    native_remote_host_client: Option<
        Arc<integrations::core::remote_delegations::transport::host_client::NativeRemoteHostClient>,
    >,
    agent_exact_control_v1: bool,
    agent_exact_continuation_v1: bool,
    source_management_owner: Arc<()>,
    // An authenticated transport client cannot terminate the shared host.
    client_transport_only: bool,
    // Normal stdio is the actual app-server, never a carrier frontend.
    direct_task_stdio: bool,
    session_lifetime_v1: bool,
    native_runtime_thread_initializer:
        Option<Arc<integrations::core::runtime_driver::NativeRuntimeThreadInitializer>>,
    integration_model_policies_v1: bool,
    integration_model_health_v1: bool,
    integration_model_usage_v1: bool,
    integration_model_policy_settings_v1: bool,
    integration_remote_operation_control_v1: bool,
    integration_task_workspace_v1: bool,
    integration_task_workspace_capability_scope_v1: bool,
    integration_task_capability_scope_directory_v1: bool,
    integration_task_capability_source_choices_v1: bool,
    integration_task_capability_scope_v1: bool,
    integration_task_resource_bindings_v1: bool,
    integration_connectivity_v1: bool,
    native_scope_host:
        Option<Arc<integrations::core::service_leases::scope_host::NativeScopeHostBootstrap>>,
    integration_connectivity:
        Arc<integrations::connectivity::main_rpc::NativeConnectivityMainService>,
    integration_connectivity_resources: Option<
        Arc<integrations::connectivity::installed_resources::NativeConnectivityStartupBinding>,
    >,
    native_source_dispatch: bool,
    native_source_accepted:
        Option<Arc<integrations::core::runtime_driver::NativeRuntimeAcceptedObserver>>,
    integration_task_capability_scope: Arc<
        integrations::connectivity::task_capability_scope_runtime::NativeTaskCapabilityScopeRuntime,
    >,
    integration_task_workspace:
        Arc<StdMutex<integrations::core::task_workspace::NativeTaskWorkspaceReader>>,
    integration_office_v1: bool,
    integration_office_export_ack_v1: bool,
    integration_office_export_receipt_v1: bool,
    integration_office_settings_v1: bool,
    integration_office_transfers: Arc<integrations::office::native_assets::NativeOfficeTransfers>,
    integration_office_resources:
        Option<Arc<integrations::office::startup_binding::NativeOfficeStartupBinding>>,
    integration_runtime: Option<integrations::core::runtime_pump::NativeRuntimeClient>,
    integration_context: Option<integrations::core::NativeIntegrationContext>,
    integration_memory_v1: bool,
    integration_knowledge_settings_v1: bool,
    integration_connectivity_settings_v1: bool,
    browser_profiles_v1: bool,
    browser_profile_sessions_v1: bool,
    integration_memory: Option<integrations::core::NativeMemoryService>,
    integration_knowledge_v1: bool,
    integration_automation_v1: bool,
    integration_automation_task_models_v1: bool,
    integration_automation_period_budgets_v1: bool,
    integration_knowledge: Arc<Mutex<integrations::knowledge::NativeKnowledgeRpc>>,
    integration_operations_v1: bool,
    integration_task_state_v1: bool,
    native_code_services_v1: bool,
    integration_operations: Option<integrations::core::NativeOperations>,
    temporary_mcp_cleanup: tokio::task::JoinSet<Result<()>>,
    client_questions: bool,
    input_ended: CancellationToken,
    agent_streams: agent_conversation::AgentConversationSubscriptions,
    desktop_recovery_tasks: tokio::task::JoinSet<Option<desktop_recovery::ReadyRecovery>>,
    desktop_recovery_ready: std::collections::VecDeque<desktop_recovery::ReadyRecovery>,
    private_desktop_recovery: Option<desktop_recovery::ReadyRecovery>,
    computer_use_recovery_v1: bool,
    computer_use_session_authorization_v1: bool,
    knowledge_tasks: tokio::task::JoinSet<()>,
    knowledge_rpc_tasks: tokio::task::JoinSet<()>,
    continuous_work_read_tasks: tokio::task::JoinSet<()>,
    continuous_work_mutation_tasks: tokio::task::JoinSet<()>,
    wiki_rpc_tasks: tokio::task::JoinSet<()>,
    #[cfg(target_os = "linux")]
    native_interrupts: turn_interrupt::NativeInterruptJobs,
    initialized: bool,
    agent_definitions_v1: bool,
    agent_turn_configuration_v1: bool,
    studio_work_modes_v1: bool,
    inline_widgets_v1: bool,
    isolated_widgets_v1: bool,
    mcp_apps_v1: bool,
    mcp_apps: Arc<Mutex<mcp_apps_runtime::McpAppsRuntime>>,
    mcp_app_registry: Arc<mcp_apps_registry::AppRegistry>,
    mcp_app_tasks: tokio::task::JoinSet<()>,
    mcp_app_operations: Arc<StdMutex<HashMap<String, usize>>>,
    mcp_app_pending_approvals: PendingApprovalResponses,
    mcp_app_pending_questions: PendingQuestionResponses,
    tool_profiles_v1: bool,
    tool_path_preview_v1: bool,
    /// Set when the client negotiated `threadRunSummaryV1`; only then may thread
    /// snapshots carry the richer run status and `runSummary` payload.
    run_summary_v1: bool,
    thread_runtime_handoff_v1: bool,
    /// Snapshot identities are opt-in; legacy strict page parsers see unchanged responses.
    transcript_snapshot_v1: bool,
    transcript_observation_v1: bool,
    stream_context_v1: bool,
    /// Set when the client negotiated `interactionBindingV1`; replies must then
    /// name the interaction they answer.
    interaction_binding_v1: bool,
    /// Async questions are exposed only to clients which explicitly negotiated them.
    async_user_questions_v1: bool,
    interaction_status_read_v1: bool,
    approval_tool_call_identity_v1: bool,
    temporary_mcp_servers_v1: bool,
    /// Presence is enabled only when offered by the client and supported on Linux.
    thread_presence_read_v1: bool,
    thread_goal_status_batch_v1: bool,
}

struct BackgroundEventPump {
    cancel: CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

struct BackgroundFollowupScheduler {
    cancel: CancellationToken,
    handle: tokio::task::JoinHandle<()>,
    engine: Option<Arc<StdMutex<background_scheduler::SchedulerEngine>>>,
}

#[derive(Default)]
struct BackgroundFollowupState {
    session_activity: session_lifetime::SessionActivity,
    client_lifetime: StdMutex<Option<input_lifetime::ClientInputLifetime>>,
    client_turn_count: thread_runtime::ClientTurnCounter,
    delivery: Arc<BackgroundFollowups>,
    goals: StdMutex<goal_lifecycle::GoalLifecycle>,
}

impl std::ops::Deref for BackgroundFollowupState {
    type Target = BackgroundFollowups;

    fn deref(&self) -> &Self::Target {
        &self.delivery
    }
}

/// Capabilities-gated authoritative run projection for one thread snapshot.
///
/// The legacy `running`/`idle` status stays untouched for clients that did not
/// negotiate `threadRunSummaryV1`, and for threads whose runtime facts are not
/// observable from this connection (see `ThreadManager::thread_run_facts`).
#[derive(Clone, Copy)]
struct ThreadRunProjection {
    negotiated: bool,
    facts: Option<kcoder_app_protocol::ThreadRunFacts>,
}

use kcoder_cli_storage::tracked_history_list::PersistedThreadSnapshotReport;

struct MergedHistoryScan {
    candidates: Vec<(String, PathBuf, std::time::SystemTime)>,
    issue_count: u64,
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod outbound_frame_limit_tests;

mod goal_requests_support;
use goal_requests_support::*;

use interaction_requests::*;
use kcoder_app_interactions::interaction_requests;
use kcoder_app_interactions::*;

mod workspace_registry;

mod connection_state;
use connection_state::*;

use kcoder_app_events::notification_projection;
use notification_projection::*;

use background_delivery::*;
use kcoder_app_events::background_delivery;
#[cfg(test)]
use kcoder_app_events::{BackgroundFollowupQueue, BackgroundTurnProjection};
use kcoder_app_events::{BackgroundFollowups, BackgroundProjectionState, StreamProjection};
mod background_event_pump;
use background_event_pump::project_managed_background_event;

mod background_scheduler;
use background_scheduler::*;

mod response_adapters;
use response_adapters::*;

use kcoder_turn_evidence::live_file_progress;
use kcoder_turn_evidence::worktree_artifacts;
#[cfg(test)]
mod worktree_artifact_test_support;
use kcoder_turn_evidence::turn_file_capture;
use kcoder_workspace_resources::snapshots::worktree_capture;
#[cfg(test)]
use kcoder_workspace_resources::snapshots::{
    GitSnapshotBackend, RemovePrivateDirectoryOnDrop, TurnFileChangeItem,
};
use kcoder_workspace_resources::snapshots::{
    GitTreeSnapshot, MAX_TURN_FILE_CHANGES_BYTES, TurnFileChangesArtifact,
};
use turn_file_capture::*;
#[cfg(test)]
use worktree_artifact_test_support::*;
use worktree_artifacts::*;
mod task_comparison;
use kcoder_task_delivery as task_delivery;
mod task_delivery_requests;
use kcoder_turn_evidence::turn_observation_storage;
use kcoder_turn_evidence::turn_review_evidence;
use turn_review_evidence::*;

use device_requests::*;
use kcoder_workspace_resources::device_requests;

mod workspace_dispatch;
mod workspace_operation_receipts;
mod workspace_operation_receipts_v2;
use workspace_dispatch as workspace_requests;
use workspace_requests::*;

mod managed_worktrees;
use kcoder_workspace_resources::managed_worktrees::{
    ClientManagedWorktree, ClientWorkspaceRecord, ClientWorkspaceState, ClientWorkspaceStore,
    ClientWorktreeState, ClientWorktreeStore, app_server_now_ms, valid_artifact_id,
    validate_worktree_id,
};
#[cfg(test)]
use kcoder_workspace_resources::managed_worktrees::{
    is_windows_reserved_basename, managed_worktree_target_path,
};
use managed_worktrees::*;
use workspace_registry::{client_workspace_store, client_worktree_store};

mod runtime_configuration;
use runtime_configuration::*;

mod thread_requests_support;
use thread_requests_support::*;

mod thread_metadata;
use thread_metadata::*;

mod transcript_projection;
mod transcript_tool_recovery;
use kcoder_transcript::{
    ApprovalDecisionArtifact, TranscriptToolContexts, TurnOutcomeArtifact,
    extend_transcript_tool_contexts, history_entry_thread_message, truncate_utf8_bytes,
    validated_history_attempt,
};
#[cfg(test)]
use kcoder_transcript::{
    apply_turn_client_message_ids, apply_turn_outcome_to_message, apply_turn_outcomes,
    attach_approval_decision_blocks, attach_turn_file_captures, coalesce_assistant_tool_fragments,
    transcript_tool_block, transcript_tool_contexts,
};
use transcript_projection::*;

use kcoder_turn_lifecycle::turn_artifacts;
use turn_artifacts::*;

mod server_requests;

mod agent_conversation;
mod agent_requests;
mod agent_run_constraint;

mod settings_requests;

mod runtime_requests;

mod attachment_requests;

mod resource_requests;

mod session_requests;

mod thread_creation_requests;

mod thread_read_requests;

mod thread_goal_status_batch_requests;
mod thread_presence_requests;

mod thread_restore_requests;

mod thread_rewind_requests;

mod goal_requests;

mod device_retention_cleanup;
mod thread_delete_requests;
mod thread_retention_cleanup;
mod thread_runtime_handoff_requests;

mod async_question_requests;
#[path = "app_server/retained_turn_dispatch.rs"]
mod retained_turn;
mod task_expert_requests;
mod turn_interrupt;
mod turn_requests;
mod turn_steer_requests;

mod native_component_parent;
#[path = "app_server/retention_context_host.rs"]
mod retention_context;
pub(crate) use integrations::connectivity::installed_resources::NATIVE_CONNECTIVITY_STARTUP_ENV;
pub(crate) use integrations::office::startup_binding::NATIVE_OFFICE_STARTUP_ENV;
pub(crate) use retention_context::RetentionLaunchConfiguration;
mod connection_lifecycle;
mod connection_requests;
mod rpc_connection;
pub(crate) use connection_lifecycle::run_with_native_launches;
use kcoder_host_transport::rpc_hub;

pub(crate) use kcoder_workspace_resources::managed_worktrees::acquire_app_server_workspace_runtime_lease;

mod rpc_dispatch;

/// A handler may request the connection loop to enter its existing shutdown path.
enum DispatchControl {
    Continue,
    Shutdown,
}

pub(crate) use integrations::core::service_leases::native_code::entry::try_run as try_run_native_code_service;

pub(crate) use integrations::core::service_leases::scope_host::NativeScopeHostBootstrap;
