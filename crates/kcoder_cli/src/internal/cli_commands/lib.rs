//! CLI arguments, administrative commands, and session model configuration.

pub mod build_identity;

use anyhow::{Context, Result, bail, ensure};
use clap::{Parser, ValueEnum};
use kcoder_api::{
    ApiErrorKind, Provider, ProviderBuildOverrides, ProviderFactory,
    ProviderKind as ApiProviderKind, ProviderStream,
};
use kcoder_config::{
    ConfigPaths, ConfigScope, CredentialBackend, CredentialStore, CredentialStoreMode,
    LoadedSettings, MigrationDirection, OsCredentialBackend, ProviderCredential, Settings,
    SettingsLoader, builtin_provider_credentials, dotted_value, ensure_default_user_dotenv,
    marker_for_provider, merge_settings_documents, migrate_deployment_settings,
    normalize_legacy_settings_document, remove_dotted_value, set_dotted_value, update_scope,
    write_scope, write_scope_if_missing,
};
use kcoder_mcp::McpServerConfig;
use kcoder_types::MessagesRequest;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
};
use tracing::warn;

#[path = "training_isolation.rs"]
pub mod training_isolation;
#[path = "tui_scenario.rs"]
mod tui_scenario;
use cli_args::{
    AuthAction, Cli, Commands, ConfigAction, MarketplaceAction, McpAction, PluginAction,
};
use credentials::*;
use entry_modes::*;
use settings_overrides::*;
pub use tui_scenario::TuiDevScenario;

#[path = "../../cli_args.rs"]
pub mod cli_args;
#[path = "../../startup/credentials.rs"]
pub mod credentials;
#[path = "../../daemon.rs"]
pub mod daemon;
#[path = "../../startup/entry_modes.rs"]
pub mod entry_modes;
#[path = "../../mcp_connection.rs"]
pub mod mcp_connection;
#[path = "../../model_configuration.rs"]
pub mod model_configuration;
#[path = "../../organization_budget.rs"]
pub mod organization_budget;
#[path = "../../startup/settings_overrides.rs"]
pub mod settings_overrides;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ProviderKind {
    Anthropic,
    Openai,
    #[value(alias = "vllm", alias = "sglang", alias = "openai-compatible")]
    Local,
    Gemini,
    Grok,
    #[value(alias = "kunlun-meta", alias = "kunlun_meta")]
    Kunlunmeta,
}

impl ProviderKind {
    pub fn from_env() -> Option<ApiProviderKind> {
        ApiProviderKind::from_env()
    }

    pub fn from_settings(settings: &Settings) -> Result<Option<ApiProviderKind>> {
        ApiProviderKind::from_settings(settings)
    }
}

pub struct SignedOutProvider {
    pub name: &'static str,
    pub error_type: &'static str,
    pub error_message: String,
}

impl Provider for SignedOutProvider {
    fn name(&self) -> &'static str {
        self.name
    }

    fn api_key_configured(&self) -> Option<bool> {
        Some(false)
    }

    fn stream_messages(&self, _request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        Err(ApiErrorKind::Api {
            error_type: self.error_type.to_owned(),
            message: self.error_message.clone(),
        })
    }
}

/// Move stored API keys between the operating-system credential store and the file.
/// Outcome of removing one stored credential.
pub struct LogoutOutcome {
    pub credential_id: String,
    pub removed_from_store: bool,
    pub store_note: Option<String>,
}
