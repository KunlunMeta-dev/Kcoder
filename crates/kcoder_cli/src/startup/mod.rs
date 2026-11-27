//! CLI startup domains. State ownership and entry ordering remain in runtime wiring.

use super::*;

mod runtime_wiring;
mod storage_connectivity;
mod storage_gateway_domains;
mod storage_handoff_parent;
mod storage_legacy;
mod storage_native_domains;
mod storage_operation;
mod storage_owner_child;
mod storage_profile;
mod storage_profile_operation;
mod storage_relaunch;
pub(super) use runtime_wiring::*;
pub(super) use storage_legacy::migrate_legacy_storage_before_startup;
pub(super) use storage_operation::try_run_storage_operation;

pub(super) use kcoder_cli_commands::{credentials::*, entry_modes::*, settings_overrides::*};

pub(super) use kcoder_cli_support::{
    extension_preflight::*, headless_questioner::HeadlessUserQuestioner, session_history::*,
};
