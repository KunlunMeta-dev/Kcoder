#[path = "provider_transaction.rs"]
mod provider_transaction;

use super::{
    CURRENT_CONFIG_VERSION, Settings, default_settings_document,
    normalize_legacy_profile_references, normalize_legacy_settings_document,
};
use anyhow::{Context, Result, bail};
use fs2::FileExt;
use jsonc_parser::cst::{CstInputValue, CstObject, CstObjectProp, CstRootNode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const CONFIG_DIR_ENV: &str = "KCODER_CONFIG_DIR";
pub const KCODER_HOME_ENV: &str = "KCODER_HOME";

const DEVELOPMENT_EXECUTABLE_STEM: &str = "kcoder-dev";

const PROJECT_GITIGNORE_HEADER: &str = "# KCoder local configuration and runtime data";
const PROJECT_GITIGNORE_RULES: &[&str] = &[
    "/.provider-transaction.json",
    "/.provider-transaction.json.lock",
    "/..provider-transaction.json.*.tmp",
    "/.settings.json.*.tmp",
    "/.settings.local.json.*.tmp",
    "/settings.json.lock",
    "/settings.json.*.tmp",
    "/settings.local.json",
    "/settings.local.json.lock",
    "/settings.local.json.*.tmp",
    "/sessions/",
    "/projects/",
    "/worktrees/",
    "/tool-results/",
    "/attachments/",
    "/tool-repair-examples/",
    "/skills/.usage.json",
    "/skills/.usage.json.lock",
    "/skills/.backups/",
    "/skills/.curator.log",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigScope {
    User,
    Executable,
    Project,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigPaths {
    pub config_dir: PathBuf,
    pub user_settings: PathBuf,
    pub executable_settings: PathBuf,
    pub credentials: PathBuf,
    pub project_root: PathBuf,
    pub project_settings: PathBuf,
    pub local_settings: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSource {
    pub scope: ConfigScope,
    pub path: PathBuf,
}

/// Explicit root-level model overrides, before expanded Provider values are
/// added to source metadata. Values are private configuration, never diagnostics.
#[derive(Clone, Default)]
pub struct ModelRuntimeOverrides(std::collections::BTreeMap<String, Value>);

#[derive(Debug, Clone)]
pub struct LoadedSettings {
    pub settings: Settings,
    pub model_runtime_overrides: ModelRuntimeOverrides,
    pub model_configuration_sources: crate::ModelConfigurationSources,
    pub paths: ConfigPaths,
    pub loaded_sources: Vec<ConfigSource>,
    /// Explicit read-only settings overlays, in precedence order.
    pub overlay_sources: Vec<PathBuf>,
    /// Dotted leaf paths provided by one or more explicit overlays.
    pub overlay_fields: BTreeSet<String>,
    /// Highest-precedence file source for each dotted setting path.
    pub field_sources: BTreeMap<String, ConfigScope>,
    /// Legacy plaintext secret fields found in settings files. Credentials
    /// loaded from credentials.json are intentionally excluded.
    pub plaintext_secret_setting_names: Vec<String>,
}

#[derive(Clone)]
struct FrozenOverlay(Value);

#[derive(Debug, Clone)]
pub struct SettingsLoader {
    cwd: PathBuf,
    config_dir: Option<PathBuf>,
    executable_dir: Option<PathBuf>,
    overlay_files: Vec<PathBuf>,
    frozen_overlays: std::collections::BTreeMap<PathBuf, FrozenOverlay>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CredentialStore {
    pub credentials: BTreeMap<String, String>,
    pub revoked: std::collections::BTreeSet<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredApiCredential {
    #[serde(rename = "type")]
    credential_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredCredentialDocument {
    Current(BTreeMap<String, StoredApiCredential>),
    Legacy(LegacyCredentialDocument),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyCredentialDocument {
    api_keys: BTreeMap<String, String>,
}

struct RawJsoncObject {
    source: String,
    value: Value,
}

#[cfg(test)]
mod credential_store_tests;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod frozen_overlay_tests;

mod discovery;
#[cfg(test)]
use discovery::resolve_user_config_dir;
pub use discovery::user_config_dir;

mod layers;
pub use layers::merge_settings_documents;
pub use layers::validate_and_resolve_settings_document;
use layers::*;

mod provider_resolution;
use provider_resolution::*;

mod credentials_io;
use credentials_io::*;

mod persistence;
pub use persistence::ensure_project_gitignore;
pub use persistence::read_scope;
pub use persistence::read_settings_file;
pub use persistence::update_scope;
pub use persistence::update_settings_and_credentials;
pub use persistence::update_settings_file;
pub(crate) use persistence::write_bytes_atomic;
pub use persistence::write_scope;
pub use persistence::write_scope_if_missing;
use persistence::*;

mod document_paths;
pub use document_paths::dotted_value;
pub use document_paths::remove_dotted_value;
pub use document_paths::set_dotted_value;

mod validation;
use validation::*;
