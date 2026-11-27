//! Outgoing accepted-turn adapters; connection admission and receiver ownership stay at the host.
use super::{NativeDomain, NativeDomainGuard, NativeIntegrationContext, NativeOperations};
use anyhow::{Context, Result, ensure};
use kcoder_acp::outbound::{InstalledOutboundRunner, OutboundHost};
use kcoder_native_journal::{NativeRemoteAuthority, NativeRemoteJournal};
use kcoder_native_journal::{launch, ordinary_source, receiver_history};
pub use kcoder_native_journal::{original_read, validate_office_source_refs};
use kcoder_state::integrations::core::remote_delegations::{
    NativeRemoteDelegationStore, NativeRemoteStage,
};
use kcoder_types::integrations::core::{IntegrationOperationPhase, IntegrationRequest};
use serde_json::Value;
use std::{
    ffi::OsStr,
    sync::{Arc, Mutex},
};
#[path = "../../../../../../app_server/integrations/core/remote_delegations/artifacts.rs"]
pub mod artifacts;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/authority.rs"]
pub mod authority;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/authority_ssh.rs"]
pub mod authority_ssh;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/control.rs"]
pub mod control;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/factory.rs"]
pub mod factory;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/management.rs"]
pub mod management;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/materials_authority.rs"]
pub mod materials;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/materials_ssh.rs"]
pub mod materials_ssh;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/original_reconcile.rs"]
pub mod original_reconcile;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/output_reader.rs"]
pub mod output_reader;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/receiver_materials.rs"]
pub mod receiver_materials;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/receiver_results.rs"]
pub mod receiver_results;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/receiver_results_ssh.rs"]
pub mod receiver_results_ssh;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/registry_authority.rs"]
pub mod registry;
#[path = "../../../../../../app_server/integrations/core/remote_delegations/source_budget.rs"]
pub mod source_budget;
#[path = "transport/mod.rs"]
pub mod transport;
pub use control::NativeRemoteOperationControl;
pub use factory::install_outgoing_for_accepted_turn;
