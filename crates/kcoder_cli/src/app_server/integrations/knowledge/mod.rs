//! Authorized native knowledge ports. The host owns caller identity and policy.
pub use kcoder_knowledge_management::{
    KnowledgeHostContext, KnowledgePolicyEvaluator, KnowledgeResource,
};
use kcoder_knowledge_management::{api, automation_api, memory_api, publication_api};
pub use memory_api::{handle_memory, handle_memory_management};

mod dependencies;
pub use automation_api::handle_automation_management;
pub use dependencies::KnowledgeDependencyPort;

mod automation_executor;
pub use automation_executor::{
    ApprovedFileEventSource, ApprovedSubscriptionTrigger, trigger_approved_subscription,
};

mod automation_delivery;
pub use automation_delivery::control_automation_delivery;
#[cfg(test)]
pub use automation_delivery::deliver_automation_run;
pub use automation_executor::{cancel_automation_run, process_due_subscriptions};

pub use automation_executor::resume_prepared_automations;

#[cfg(test)]
pub use business_templates::list_business_templates;
pub(crate) use business_templates::{FixedBusinessWorkflow, resolve_pinned_business_workflow};
use kcoder_runtime_driver::business_templates;

pub use automation_api::handle_automation_templates;

mod native_host;
pub(crate) use native_host::run_shared_publication_read_helper;
pub(crate) use native_host::{
    ExistingProfileWikiResolver, NativeFileEventBinding, NativeKnowledgeHost,
    authorize_observed_wiki_read, authorize_observed_wiki_write,
};

mod rpc;
pub(crate) use rpc::{
    NativeKnowledgeRpc, NativeKnowledgeRpcMethod, native_knowledge_capabilities,
    request_knowledge_automation,
};

mod turn_memory;
pub(crate) use turn_memory::{
    NativeMemorySnapshotReadError, NativeReviewedMemorySource, prepare_current_turn_memory,
    read_thread_memory_snapshot,
};

mod composition;
pub(crate) use composition::prepare_native_turn_memory;
mod read_snapshot_rpc;
pub(crate) use read_snapshot_rpc::request_native_memory_snapshot;

mod office_assets;
mod wiki_tool;
pub(crate) use office_assets::validate_management_office_knowledge_sources;
pub(crate) use wiki_tool::install as install_native_wiki_reads;

mod automation_runtime;
pub(crate) use automation_runtime::{AutomationOfficeFactory, NativeAutomationRuntimePort};

mod native_scheduler;
pub(crate) use native_scheduler::NativeAutomationScheduler;

mod native_file_selection;
pub(crate) use native_file_selection::NativeFileEventSelectionControl;

#[cfg(test)]
pub(crate) use automation_runtime::connection_test_support::execute_code as execute_connection_code_for_test;

pub use native_host::NativeAutomationDeliveryUse;

#[cfg(test)]
pub(crate) use native_host::native_delivery_test_fixture;

mod native_application_selection;
pub(crate) use native_application_selection::NativeApplicationSelectionControl;
pub(crate) use native_host::NativeApplicationResourceReadUse;
pub(crate) mod application_selection_rpc;
