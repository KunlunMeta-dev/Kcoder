use super::*;
use crate::prompt_runtime::strip_spec_workflow_project_instructions;
use crate::test_support::collections::tool_names;
use crate::test_support::engine_builder::{
    TestEngineBuilder, settings_using_main_summary_runtime, test_engine_with_memory_manager,
    test_engine_with_settings,
};
use crate::test_support::events::{
    simple_text_events, sleep_tool_call_events, thinking_only_events,
};
use crate::test_support::providers::{
    EmptyProvider, RequestRecordingProvider, SequentialEventsProvider, StaticTextProvider,
    SystemPromptRecordingProvider, TextDraftProvider,
};
use crate::tool_file_observation::FileSnapshotEntry;
use crate::tool_schema_runtime::{
    description_for_model_with_input_format, model_schema_for_tool_input,
};
use crate::verification_target::{verification_command_label, verification_command_target};
use futures::StreamExt;
use kcoder_config::{MoaModelConfig, MoaPresetConfig};
use kcoder_types::MessageRole;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};

include!("usage.rs");
include!("diagnostic_runtime.rs");
include!("moa.rs");
include!("moa_plan.rs");
include!("tool_logging.rs");
include!("todo.rs");
include!("tool_definitions.rs");
include!("shell_policy.rs");
include!("tool_profiles.rs");
include!("skill_curator.rs");
include!("goal_budget.rs");
include!("usage_response.rs");
include!("turn_duration.rs");
include!("arrangement.rs");
include!("client_persistence.rs");
include!("lifecycle_config.rs");
include!("stream_protocol.rs");
include!("memory_observation.rs");
include!("provider_runtime.rs");
include!("shell_execution.rs");
include!("tool_execution.rs");
include!("skill_activation.rs");
include!("tool_errors.rs");
include!("message_repair.rs");
include!("prompt_context.rs");
include!("checkpoint_permissions.rs");
