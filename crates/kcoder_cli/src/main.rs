use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use clap::{Parser, ValueEnum};
#[cfg(test)]
use kcoder_api::missing_api_key_message;
use kcoder_api::{
    ApiErrorKind, MissingApiKeyError, Provider, ProviderBuildOverrides, ProviderFactory,
    ProviderKind as ApiProviderKind, ProviderStream,
};
use kcoder_config::{
    ConfigPaths, ConfigScope, CredentialBackend, CredentialStore, CredentialStoreMode,
    LoadedSettings, MigrationDirection, OsCredentialBackend, PermissionMode, ProviderCredential,
    Settings, SettingsLoader, builtin_provider_credentials, default_model_name, dotted_value,
    ensure_default_user_dotenv, ensure_project_gitignore, marker_for_provider,
    merge_settings_documents, migrate_deployment_settings, normalize_legacy_settings_document,
    remove_dotted_value, set_dotted_value, update_scope, user_dotenv_path, write_scope,
    write_scope_if_missing,
};
use kcoder_engine::{EngineEvent, QueryEngine, WorkspaceRuntimeServices};
use kcoder_mcp::{McpServerConfig, McpTool};
use kcoder_memory::MemoryManager;
use kcoder_permissions::{
    PermissionDecision, PermissionEngine, PermissionPrompt, PermissionResponse,
};
use kcoder_skills::SkillRegistry;
use kcoder_state::AppState;
use kcoder_tools::{
    ConfigTool, DenyAllUserQuestioner, OcrReviewTool, ToolRegistry, UserQuestionRequest,
    UserQuestionResponse, UserQuestioner, core_registry, default_registry, nano_registry,
};
#[cfg(test)]
use kcoder_types::Message;
use kcoder_types::MessagesRequest;
use serde_json::Value;

mod app_server;
mod build_identity;
mod cli_args;
mod daemon;
#[cfg(windows)]
mod desktop_recovery;
mod diagnostics;
mod headless;
mod headless_interrupt;
mod headless_outcome;
mod internal_bootstrap;
mod mcp_connection;
mod model_configuration;
mod plugin_credentials;
mod retention_parent_environment;
mod tui_dev_mock;

pub(crate) use headless::engine_event_json;

#[cfg(test)]
use cli_args::ToolProfile;
use cli_args::{
    AuthAction, Cli, Commands, ConfigAction, MarketplaceAction, McpAction, PluginAction,
    TrustAction,
};
use diagnostics::{hook_startup_notice, init_tracing};

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{info, warn};
use tui_dev_mock::{MockScenarioProvider, TuiDevScenario};

struct SignedOutProvider {
    name: &'static str,
    error_message: String,
}

/// Auto-deciding permission prompt for headless mode.
struct HeadlessPermissionPrompt {
    mode: PermissionMode,
}

/// Interactive question prompt for headless mode.
struct HeadlessUserQuestioner;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum ProviderKind {
    Anthropic,
    Openai,
    #[value(alias = "vllm", alias = "sglang", alias = "openai-compatible")]
    Local,
    Gemini,
    Grok,
    #[value(alias = "kunlun-meta", alias = "kunlun_meta")]
    Kunlunmeta,
}

fn main() -> Result<()> {
    let inherited_parent = std::env::var_os(kcoder_app_protocol::PRIVATE_RETENTION_PARENT_ENV_V1);
    // SAFETY: the true synchronous process entry has not started any threads or
    // called bootstrap/dotenv. Ordinary descendants must not inherit this fact.
    unsafe {
        std::env::remove_var(kcoder_app_protocol::PRIVATE_RETENTION_PARENT_ENV_V1);
    }
    // Version queries are read-only probes and must be handled before configuration
    // bootstrap or first-start writes. Do not parse regular arguments early because
    // Clap environment variables from the user's .env must load before full parsing.
    if matches!(
        std::env::args_os().skip(1).collect::<Vec<_>>().as_slice(),
        [arg] if arg == "--version" || arg == "-V"
    ) {
        println!("kcoder {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let raw_args = std::env::args_os().collect::<Vec<_>>();
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
    // Template previews are pure data and must precede all first-start writes.
    if let Ok(parsed) = Cli::try_parse_from(&raw_args)
        && let Some(Commands::Config { action }) = parsed.command
        && let Some(value) = provider_template_output(&action)?
    {
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    let inherited_parent = retention_parent_environment::decode(inherited_parent)?;
    let read_only_doctor = is_read_only_doctor_invocation(&raw_args);
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cwd = canonicalize_cli_cwd(cwd);
    let bootstrap_outcome = if read_only_doctor {
        None
    } else {
        internal_bootstrap::bootstrap_from_current_exe(&cwd)?
    };
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
    // SAFETY: still before the #[tokio::main] entry. A user's dotenv may have
    // reintroduced the reserved name, but it cannot replace the owned typed fact.
    unsafe {
        std::env::remove_var(kcoder_app_protocol::PRIVATE_RETENTION_PARENT_ENV_V1);
    }
    run(bootstrap_outcome, inherited_parent)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RequiredSkillPreflightFailure {
    skill: String,
    reason: &'static str,
    message: String,
    remediation: String,
}

/// Move stored API keys between the operating-system credential store and the file.
/// Outcome of removing one stored credential.
struct LogoutOutcome {
    credential_id: String,
    removed_from_store: bool,
    store_note: Option<String>,
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;

mod startup;
use startup::*;
