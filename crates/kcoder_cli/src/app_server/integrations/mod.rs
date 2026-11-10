//! Host-owned integration handlers; registration does not grant capabilities.
pub mod connectivity;
pub mod connectivity_settings;
pub mod core;
pub mod knowledge;
pub mod knowledge_settings;
pub mod office;

pub(in crate::app_server) mod agent_definition_selection;
pub(in crate::app_server) mod agent_tasks;
