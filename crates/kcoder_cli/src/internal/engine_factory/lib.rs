//! Concrete app-server Engine construction; admission remains with the host.
pub use kcoder_cli_commands::cli_args::Cli;
pub use kcoder_plugin_rpc::runtime_snapshot::{
    runtime_plugin_snapshot, runtime_plugin_snapshot_with_profile,
};
pub use kcoder_session_configuration::builtin_tools_for_profile;

pub use kcoder_cli_commands::training_isolation::apply_training_skill_isolation;

#[path = "app_server/mod.rs"]
pub mod app_server;
pub use app_server::engine_factory::AppServerEngineFactory;
