pub use kcoder_cli_commands::build_identity::{
    BuildIdentity, initialize as initialize_build_identity, initialize_release_metadata,
    version as executable_version,
};

use anyhow::{Context, Result, bail, ensure};
use clap::Parser;
#[cfg(test)]
use kcoder_api::missing_api_key_message;
use kcoder_api::{MissingApiKeyError, Provider, ProviderFactory};
use kcoder_cli_commands::{
    ProviderKind, SignedOutProvider, cli_args, daemon, mcp_connection, model_configuration,
    organization_budget,
};
use kcoder_cli_support::{HeadlessPermissionPrompt, tui_dev_mock};
use kcoder_config::{
    LoadedSettings, PermissionMode, Settings, SettingsLoader, ensure_project_gitignore,
    user_dotenv_path,
};
use kcoder_engine::{EngineEvent, QueryEngine, WorkspaceRuntimeServices};
use kcoder_memory::MemoryManager;
use kcoder_permissions::PermissionEngine;
#[cfg(test)]
use kcoder_session_configuration::builtin_tools_for_settings;
use kcoder_skills::SkillRegistry;
use kcoder_state::AppState;
use kcoder_tools::{
    ConfigTool, DenyAllUserQuestioner, OcrReviewTool, core_registry, default_registry,
};
#[cfg(test)]
use kcoder_types::Message;

mod acp_entry;
mod app_server;
#[cfg(windows)]
mod desktop_recovery;
mod diagnostics;
mod migration_cli;
mod peer_sessions;
mod retention_parent_environment;

#[cfg(test)]
mod test_fixtures;

pub(crate) use kcoder_cli_support::engine_event_json;

#[cfg(test)]
use cli_args::ToolProfile;
use cli_args::{AuthAction, Cli, Commands};
use diagnostics::{hook_startup_notice, init_tracing};

use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{info, warn};
use tui_dev_mock::{MockScenarioProvider, TuiDevScenario};

/// The executable supplies the interactive frontend after native startup.
pub type ReplRunner = fn(
    QueryEngine,
    Option<String>,
    Option<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>>>>;

/// The executable supplies the noninteractive driver independently of app-server.
pub type HeadlessRunner =
    for<'a> fn(
        &'a QueryEngine,
        String,
        &'a HeadlessPermissionPrompt,
        bool,
        Vec<EngineEvent>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + 'a>>;

pub struct CliRunners {
    pub repl: ReplRunner,
    pub headless: HeadlessRunner,
}

#[cfg(all(feature = "e2e-http-transport", debug_assertions))]
pub fn enable_e2e_http_transport_for_test_driver() {
    kcoder_api::enable_e2e_http_transport_for_test_driver();
}

pub fn run_cli(runners: CliRunners) -> Result<()> {
    let inherited_storage = std::env::var_os(kcoder_types::STORAGE_STARTUP_ENV);
    let tui_command_env = kcoder_app_protocol::TERMINAL_KCODER_TUI_COMMAND_ENV;
    let tui_command = std::env::var_os(tui_command_env);
    let inherited_parent = std::env::var_os(kcoder_app_protocol::PRIVATE_RETENTION_PARENT_ENV_V1);
    let inherited_verifier =
        std::env::var_os(kcoder_app_protocol::PRIVATE_RETENTION_VERIFIER_ENV_V1);
    let inherited_office = std::env::var_os(app_server::NATIVE_OFFICE_STARTUP_ENV);
    let inherited_connectivity = std::env::var_os(app_server::NATIVE_CONNECTIVITY_STARTUP_ENV);
    // SAFETY: the true synchronous process entry has not started any threads or
    // called bootstrap/dotenv. Ordinary descendants must not inherit this fact.
    unsafe {
        std::env::remove_var(kcoder_types::STORAGE_STARTUP_ENV);
        std::env::remove_var(tui_command_env);
        std::env::remove_var(kcoder_app_protocol::PRIVATE_RETENTION_PARENT_ENV_V1);
        std::env::remove_var(kcoder_app_protocol::PRIVATE_RETENTION_VERIFIER_ENV_V1);
        std::env::remove_var(app_server::NATIVE_OFFICE_STARTUP_ENV);
        std::env::remove_var(app_server::NATIVE_CONNECTIVITY_STARTUP_ENV);
    }
    // Version queries are read-only probes and must be handled before configuration
    // bootstrap or first-start writes. Do not parse regular arguments early because
    // Clap environment variables from the user's .env must load before full parsing.
    if matches!(
        std::env::args_os().skip(1).collect::<Vec<_>>().as_slice(),
        [arg] if arg == "--version" || arg == "-V"
    ) {
        println!("kcoder {}", kcoder_cli_commands::build_identity::version());
        return Ok(());
    }
    let raw_args = std::env::args_os().collect::<Vec<_>>();
    kcoder_config::storage::capture_storage_startup_context(inherited_storage.as_deref())?;
    if let Some(result) = try_run_storage_operation(&raw_args) {
        return result;
    }
    if let Some(result) = app_server::try_run_native_code_service(&raw_args) {
        return result;
    }

    if raw_args
        .get(1)
        .is_some_and(|arg| arg == "--internal-shared-publication-read-v1")
    {
        ensure!(
            raw_args.len() == 2,
            "invalid internal shared publication reader invocation"
        );
        return app_server::run_shared_publication_read_helper();
    }
    if raw_args
        .get(1)
        .is_some_and(|arg| arg == organization_budget::ENTRY)
    {
        ensure!(
            raw_args.len() == 2,
            "invalid internal organization budget invocation"
        );
        return organization_budget::run();
    }
    if raw_args
        .get(1)
        .is_some_and(|arg| arg == "--internal-office-read-worker")
    {
        ensure!(
            raw_args.len() == 2,
            "invalid internal Office read worker invocation"
        );
        return app_server::run_office_read_worker();
    }
    #[cfg(target_os = "linux")]
    if raw_args.get(1).is_some_and(|arg| {
        arg == kcoder_process_supervisor::linux_stdio::INTERNAL_STDIO_OWNER_V1
            || arg == kcoder_process_supervisor::linux_stdio::INTERNAL_COMMAND_OWNER_V1
            || arg == kcoder_process_supervisor::linux_stdio::INTERNAL_COMMAND_OWNER_RECEIPT_V1
    }) {
        let code = kcoder_process_supervisor::linux_stdio::entry(&raw_args)?;
        std::process::exit(code);
    }
    if acp_entry::try_run(&raw_args)? {
        return Ok(());
    }
    if raw_args
        .get(1)
        .is_some_and(|arg| arg == "--internal-wiki-worker" || arg == "--internal-wiki-pause")
    {
        ensure!(
            raw_args.len() == 3,
            "invalid internal Wiki worker invocation"
        );
        return app_server::knowledge_worker::entry(
            Path::new(&raw_args[2]),
            raw_args[1] == "--internal-wiki-pause",
        );
    }
    #[cfg(windows)]
    if raw_args
        .get(1)
        .is_some_and(|arg| arg == "--internal-desktop-recovery")
    {
        ensure!(raw_args.len() == 4, "invalid internal recovery invocation");
        return desktop_recovery::run(
            Path::new(&raw_args[2]),
            raw_args[3]
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("invalid recovery pipe name"))?,
        );
    }
    // Every recognized internal worker returned above; any other `--internal-*`
    // entry must fail before Clap parsing and first-start profile bootstrap.
    reject_unknown_internal_entry(&raw_args)?;
    // Invalid/help invocations must not perform first-start writes either.
    let early_cli = Cli::try_parse_from(&raw_args).unwrap_or_else(|error| error.exit());
    let tui_command = tui_command
        .map(|command| {
            let command = command
                .into_string()
                .map_err(|_| anyhow::anyhow!("initial KCoder command must be UTF-8"))?;
            ensure!(
                early_cli.prompt.is_none()
                    && early_cli.command.is_none()
                    && kcoder_app_protocol::TerminalKcoderTui::valid_command(&command),
                "initial KCoder command requires the interactive TUI and a valid slash command"
            );
            Ok::<_, anyhow::Error>(command)
        })
        .transpose()?;
    // Migration owns explicit target writes and must bypass ordinary profile bootstrap and Hooks.
    if let Some(Commands::Migrate { action }) = &early_cli.command {
        return migration_cli::run(action, early_cli.cwd.as_deref(), &early_cli.settings_files);
    }
    // Read-only configuration queries must precede all first-start writes.
    if let Some(Commands::Config { action }) = &early_cli.command
        && let Some(value) = read_only_config_output(action)?
    {
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    let inherited_parent = retention_parent_environment::decode(inherited_parent)?;
    let inherited_verifier = retention_parent_environment::decode_verifier(inherited_verifier)?;
    let read_only_doctor = is_read_only_doctor_invocation(&raw_args);
    // Plugin diagnostics may initialize or recover their store. They skip
    // business bootstrap but must not write through an offline migration.
    if read_only_doctor {
        kcoder_config::storage::initialize_storage_diagnostic_runtime()?;
    } else {
        migrate_legacy_storage_before_startup(inherited_storage.is_some())?;
        kcoder_config::storage::initialize_storage_runtime()?;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cwd = canonicalize_cli_cwd(cwd);
    let config_dir = kcoder_config::user_config_dir()?;
    if read_only_doctor {
        let dotenv = user_dotenv_path(&config_dir);
        if dotenv.is_file() {
            dotenvy::from_path(&dotenv).with_context(|| {
                format!(
                    "failed to load unified user environment from {}",
                    dotenv.display()
                )
            })?;
        }
    } else {
        load_unified_user_dotenv(&config_dir)?;
        kcoder_config::ensure_user_settings_schema(&config_dir)?;
        kcoder_skills::ensure_builtin_skills(&config_dir)?;
        ensure_default_user_settings(&cwd, &config_dir)?;
    }
    // SAFETY: still before creating the Tokio runtime. A user's dotenv may have
    // reintroduced the reserved name, but it cannot replace the owned typed fact.
    unsafe {
        std::env::remove_var(tui_command_env);
        std::env::remove_var(kcoder_app_protocol::PRIVATE_RETENTION_PARENT_ENV_V1);
        std::env::remove_var(kcoder_app_protocol::PRIVATE_RETENTION_VERIFIER_ENV_V1);
        std::env::remove_var(app_server::NATIVE_OFFICE_STARTUP_ENV);
        std::env::remove_var(app_server::NATIVE_CONNECTIVITY_STARTUP_ENV);
    }
    run(
        inherited_parent,
        inherited_verifier,
        inherited_office,
        inherited_connectivity,
        tui_command,
        runners,
    )
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;

mod startup;
#[cfg(test)]
use kcoder_session_configuration::builtin_tools_for_profile;
#[cfg(test)]
use kcoder_types::MessagesRequest;
#[cfg(test)]
use serde_json::Value;
use startup::*;
#[cfg(test)]
use {cli_args::McpAction, cli_args::TrustAction};
#[cfg(test)]
use {kcoder_api::ApiErrorKind, kcoder_api::ProviderKind as ApiProviderKind};
#[cfg(test)]
use {
    kcoder_config::ConfigPaths, kcoder_config::ConfigScope, kcoder_config::CredentialStore,
    kcoder_config::migrate_deployment_settings, kcoder_config::normalize_legacy_settings_document,
};
