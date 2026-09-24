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

impl ConfigScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Executable => "executable",
            Self::Project => "project",
            Self::Local => "local",
        }
    }
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

impl ConfigPaths {
    pub fn discover(cwd: &Path) -> Result<Self> {
        let config_dir = user_config_dir()?;
        Ok(Self::with_config_dir(cwd, config_dir))
    }

    pub fn with_config_dir(cwd: &Path, config_dir: PathBuf) -> Self {
        let executable_dir = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf));
        Self::with_config_dir_and_executable_dir(cwd, config_dir, executable_dir)
    }

    pub fn with_config_dir_and_executable_dir(
        cwd: &Path,
        config_dir: PathBuf,
        executable_dir: Option<PathBuf>,
    ) -> Self {
        let cwd = canonical_or_original(cwd);
        let project_root = cwd;
        let project_config_dir = project_root.join(".kcoder");
        let executable_settings = executable_dir
            .map(|dir| canonical_or_original(&dir).join("settings.json"))
            .unwrap_or_default();
        Self {
            user_settings: config_dir.join("settings.json"),
            executable_settings,
            credentials: config_dir.join("credentials.json"),
            config_dir,
            project_settings: project_config_dir.join("settings.json"),
            local_settings: project_config_dir.join("settings.local.json"),
            project_root,
        }
    }

    pub fn for_scope(&self, scope: ConfigScope) -> &Path {
        match scope {
            ConfigScope::User => &self.user_settings,
            ConfigScope::Executable => &self.executable_settings,
            ConfigScope::Project => &self.project_settings,
            ConfigScope::Local => &self.local_settings,
        }
    }
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

impl std::fmt::Debug for ModelRuntimeOverrides {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("ModelRuntimeOverrides").field(&self.0.keys().collect::<Vec<_>>()).finish()
    }
}

impl ModelRuntimeOverrides {
    pub fn apply(&self, settings: &mut Settings) -> Result<()> {
        macro_rules! apply_fields { ($($field:ident),* $(,)?) => { $(
            if let Some(value) = self.0.get(stringify!($field)) {
                settings.$field = serde_json::from_value(value.clone())?;
            }
        )* }; }
        apply_fields!(api_format, base_url, model_reasoning_effort, model_reasoning_policy,
            context_window_tokens, context_output_headroom, auto_compact_threshold_tokens,
            max_tokens, request_timeout_secs, openai_user_agent, max_retries,
            retry_base_delay_ms, provider_no_proxy, provider_chat_protocol);
        // Root-level objects retain normal layered merge semantics. They are
        // patches over the selected model, not replacement model definitions.
        if let Some(value) = self.0.get("model_capabilities") {
            let mut merged = serde_json::to_value(&settings.model_capabilities)?;
            merge_settings_value(&mut merged, value.clone());
            settings.model_capabilities = serde_json::from_value(merged)?;
        }
        if let Some(value) = self.0.get("provider_extra_body") {
            let mut merged = serde_json::to_value(&settings.provider_extra_body)?;
            merge_settings_value(&mut merged, value.clone());
            settings.provider_extra_body = serde_json::from_value(merged)?;
        }
        settings.apply_env_overrides();
        Ok(())
    }
}

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

impl std::fmt::Debug for FrozenOverlay {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("FrozenOverlay(<redacted>)")
    }
}

#[derive(Debug, Clone)]
pub struct SettingsLoader {
    cwd: PathBuf,
    config_dir: Option<PathBuf>,
    executable_dir: Option<PathBuf>,
    overlay_files: Vec<PathBuf>,
    frozen_overlays: std::collections::BTreeMap<PathBuf, FrozenOverlay>,
}

impl SettingsLoader {
    pub fn new(cwd: impl AsRef<Path>) -> Self {
        Self {
            cwd: cwd.as_ref().to_path_buf(),
            config_dir: None,
            executable_dir: std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf)),
            overlay_files: Vec::new(),
            frozen_overlays: Default::default(),
        }
    }

    /// Override the user configuration directory. Primarily useful for tests,
    /// portable installations, and hosts with non-standard directory layouts.
    pub fn with_config_dir(mut self, config_dir: impl Into<PathBuf>) -> Self {
        self.config_dir = Some(config_dir.into());
        self
    }

    /// Override the directory containing the executable-level settings file.
    /// The production loader defaults to the running executable's directory.
    pub fn with_executable_dir(mut self, executable_dir: impl Into<PathBuf>) -> Self {
        self.executable_dir = Some(executable_dir.into());
        self
    }

    /// Add an explicit, read-only settings layer above user/executable/project/local files.
    pub fn with_overlay_files(mut self, files: impl IntoIterator<Item = PathBuf>) -> Self {
        self.overlay_files.extend(files);
        self
    }

    /// Add read-only layers *below* the already registered overlays.
    ///
    /// Session templates use this so a saved preset cannot silently override an
    /// explicit `--settings-file` supplied for this launch.
    pub fn with_prepended_overlay_files(
        mut self,
        files: impl IntoIterator<Item = PathBuf>,
    ) -> Self {
        let mut merged: Vec<PathBuf> = files.into_iter().collect();
        merged.append(&mut self.overlay_files);
        self.overlay_files = merged;
        self
    }

    /// Pin explicit overlays for an existing session while continuing to reload
    /// user settings and credentials. New sessions use the original live loader.
    pub fn freeze_overlays(mut self) -> Result<Self> {
        for path in &self.overlay_files {
            if !self.frozen_overlays.contains_key(path) {
                let value = read_optional_json_object(path)?.ok_or_else(|| {
                    anyhow::anyhow!("settings overlay does not exist: {}", path.display())
                })?;
                validate_settings_document(&value)?;
                self.frozen_overlays.insert(path.clone(), FrozenOverlay(value));
            }
        }
        Ok(self)
    }

    /// Compatibility option: explicit provider catalogs always remain authoritative.
    pub fn with_bundled_providers(self, _include: bool) -> Self {
        self
    }

    pub fn paths(&self) -> Result<ConfigPaths> {
        let executable_dir = self.executable_dir.clone();
        match &self.config_dir {
            Some(config_dir) => Ok(ConfigPaths::with_config_dir_and_executable_dir(
                &self.cwd,
                config_dir.clone(),
                executable_dir,
            )),
            None => Ok(ConfigPaths::with_config_dir_and_executable_dir(
                &self.cwd,
                user_config_dir()?,
                executable_dir,
            )),
        }
    }

    /// Refresh only stored secrets while preserving the caller's semantic snapshot.
    /// The transaction guard prevents observing a partially committed settings/key update.
    /// Callers must validate the bound credential source before constructing a transport.
    pub fn refresh_stored_provider_credentials(&self, snapshot: &mut Settings) -> Result<()> {
        let paths = self.paths()?;
        let _transaction_guard = provider_transaction::read_guard(&paths.user_settings)?;
        let store = CredentialStore::load_from(&paths.credentials)?;
        let (resolved, _) = crate::resolve_stored_credentials(
            &store.credentials,
            &crate::OsCredentialBackend::new(),
            snapshot.credential_store,
        );
        // Do not copy these values into legacy fields: that could preserve a
        // revoked stored key as a fallback when its entry is subsequently removed.
        snapshot.stored_provider_credentials = resolved;
        snapshot.revoked_provider_credentials = store.revoked;
        Ok(())
    }

    pub fn load(&self) -> Result<LoadedSettings> {
        let paths = self.paths()?;
        let _transaction_guard = provider_transaction::read_guard(&paths.user_settings)?;
        // Product defaults are the lowest-priority configuration layer. Every explicit
        // file remains user-owned and may override bundled providers.
        let mut merged = default_settings_document();
        let mut model_configuration_sources = crate::ModelConfigurationSources::from_defaults(&merged);
        let mut loaded_sources = Vec::new();
        let mut field_sources = BTreeMap::new();
        // Collect provider IDs declared by any explicit user, executable-directory,
        // project, local, or read-only overlay file. Once any file declares providers,
        // the final list is exactly their union. Do not restore a built-in default after
        // the user removes it from every file.
        let mut declared_provider_names = BTreeSet::new();
        let mut providers_declared = false;

        if let Some(value) = read_optional_json_object(&paths.user_settings)? {
            validate_settings_document(&value).with_context(|| {
                format!("invalid settings in {}", paths.user_settings.display())
            })?;
            record_leaf_sources(&value, "", ConfigScope::User, &mut field_sources);
            model_configuration_sources.merge(&value, ConfigScope::User.as_str());
            providers_declared |= value.get("providers").is_some();
            declared_provider_names.extend(provider_names_of(&value));
            merge_settings_value(&mut merged, value);
            loaded_sources.push(ConfigSource {
                scope: ConfigScope::User,
                path: paths.user_settings.clone(),
            });
        }

        if !paths.executable_settings.as_os_str().is_empty()
            && let Some(value) = read_optional_json_object(&paths.executable_settings)?
        {
            validate_settings_document(&value).with_context(|| {
                format!(
                    "invalid settings in {}",
                    paths.executable_settings.display()
                )
            })?;
            record_leaf_sources(&value, "", ConfigScope::Executable, &mut field_sources);
            model_configuration_sources.merge(&value, ConfigScope::Executable.as_str());
            providers_declared |= value.get("providers").is_some();
            declared_provider_names.extend(provider_names_of(&value));
            merge_settings_value(&mut merged, value);
            loaded_sources.push(ConfigSource {
                scope: ConfigScope::Executable,
                path: paths.executable_settings.clone(),
            });
        }

        for (scope, path) in [
            (ConfigScope::Project, &paths.project_settings),
            (ConfigScope::Local, &paths.local_settings),
        ] {
            let Some(value) = read_optional_json_object(path)? else {
                continue;
            };
            validate_settings_document(&value)
                .with_context(|| format!("invalid settings in {}", path.display()))?;
            record_leaf_sources(&value, "", scope, &mut field_sources);
            model_configuration_sources.merge(&value, scope.as_str());
            providers_declared |= value.get("providers").is_some();
            declared_provider_names.extend(provider_names_of(&value));
            merge_settings_value(&mut merged, value);
            loaded_sources.push(ConfigSource {
                scope,
                path: path.clone(),
            });
        }

        let mut overlay_sources = Vec::new();
        let mut overlay_fields = BTreeSet::new();
        for path in &self.overlay_files {
            let value = match self.frozen_overlays.get(path) {
                Some(snapshot) => snapshot.0.clone(),
                None => read_optional_json_object(path)?.ok_or_else(|| {
                    anyhow::anyhow!("settings overlay does not exist: {}", path.display())
                })?,
            };
            validate_settings_document(&value)
                .with_context(|| format!("invalid settings overlay in {}", path.display()))?;
            record_leaf_names(&value, "", &mut overlay_fields);
            model_configuration_sources.merge(&value, "overlay");
            providers_declared |= value.get("providers").is_some();
            declared_provider_names.extend(provider_names_of(&value));
            merge_settings_value(&mut merged, value);
            overlay_sources.push(path.clone());
        }

        if providers_declared
            && let Some(profiles) = merged.get_mut("providers").and_then(Value::as_object_mut)
        {
            profiles.retain(|name, _| declared_provider_names.contains(name));
        }

        // If existing configuration has a provider catalog but depends on a formerly
        // bundled default selection, keep it usable after product defaults change.
        // An explicitly configured active_provider remains authoritative and is validated below.
        let active_provider_is_explicit = field_sources.contains_key("active_provider")
            || overlay_fields.contains("active_provider");
        if !active_provider_is_explicit && providers_declared && declared_provider_names.is_empty()
        {
            merged["active_provider"] = Value::Null;
        } else if !active_provider_is_explicit && !declared_provider_names.is_empty() {
            let replacement =
                merged
                    .get("providers")
                    .and_then(Value::as_object)
                    .and_then(|profiles| {
                        let active = merged.get("active_provider").and_then(Value::as_str);
                        if active.is_some_and(|name| profiles.contains_key(name)) {
                            None
                        } else {
                            profiles.keys().next().cloned()
                        }
                    });
            if let Some(replacement) = replacement {
                merged["active_provider"] = Value::String(replacement);
            }
        }

        normalize_legacy_profile_references(&mut merged);
        validate_settings_document(&merged).context("invalid merged settings")?;
        validate_profile_references(&merged)?;

        let model_runtime_overrides = ModelRuntimeOverrides([
            "api_format", "base_url", "model_capabilities", "model_reasoning_effort", "model_reasoning_policy",
            "context_window_tokens", "context_output_headroom", "auto_compact_threshold_tokens",
            "max_tokens", "request_timeout_secs", "openai_user_agent", "max_retries",
            "retry_base_delay_ms", "provider_no_proxy", "provider_extra_body", "provider_chat_protocol",
        ].into_iter().filter(|field| {
            // Object-valued overrides have leaf provenance rather than a parent
            // entry. Capture the whole explicit value before profile expansion.
            field_sources.keys().chain(overlay_fields.iter()).any(|path| {
                path == *field || path.strip_prefix(*field).is_some_and(|tail| tail.starts_with('.'))
            })
        })
            .filter_map(|field| merged.get(field).cloned().map(|value|(field.to_owned(),value))).collect());
        record_expanded_profile_sources(&merged, &mut field_sources, &mut overlay_fields);
        expand_active_provider_below_explicit_settings(&mut merged)?;
        let mut settings: Settings = serde_json::from_value(merged)
            .context("failed to deserialize merged KCoder settings")?;
        settings
            .reapply_active_model_selection()
            .context("failed to apply active discovered model selection")?;
        settings.validate_model_reasoning_policy()?;
        let plaintext_secret_setting_names = settings
            .plaintext_secret_setting_names()
            .into_iter()
            .map(str::to_string)
            .collect();
        apply_credentials(
            &mut settings,
            &CredentialStore::load_from(&paths.credentials)?,
        );
        settings.session_allowed_tools.clear();
        settings.session_denied_tools.clear();
        settings.session_permission_rules.clear();
        settings.apply_env_overrides();
        settings.normalize_runtime_limits();
        settings.normalize_paths();

        Ok(LoadedSettings {
            settings,
            model_runtime_overrides,
            model_configuration_sources,
            paths,
            loaded_sources,
            overlay_sources,
            overlay_fields,
            field_sources,
            plaintext_secret_setting_names,
        })
    }
}

/// Provider names explicitly declared by a settings document; empty when it has no providers object.
fn provider_names_of(value: &Value) -> impl Iterator<Item = String> + '_ {
    value
        .get("providers")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|profiles| profiles.keys().cloned())
}

fn record_expanded_profile_sources(
    merged: &Value,
    field_sources: &mut BTreeMap<String, ConfigScope>,
    overlay_fields: &mut BTreeSet<String>,
) {
    let Some(profile) = merged.get("active_provider").and_then(Value::as_str) else {
        return;
    };
    for (profile_field, runtime_field) in [
        ("api_format", "api_format"),
        ("endpoint", "base_url"),
        ("default_model", "model"),
        ("reasoning_effort", "model_reasoning_effort"),
        ("reasoning_policy", "model_reasoning_policy"),
        ("context_window_tokens", "context_window_tokens"),
        (
            "auto_compact_threshold_tokens",
            "auto_compact_threshold_tokens",
        ),
        ("output_headroom_tokens", "context_output_headroom"),
        ("max_output_tokens", "max_tokens"),
        ("request_timeout_secs", "request_timeout_secs"),
        ("user_agent", "openai_user_agent"),
        ("max_retries", "max_retries"),
        ("retry_base_delay_ms", "retry_base_delay_ms"),
        ("no_proxy", "provider_no_proxy"),
    ] {
        if field_sources.contains_key(runtime_field) || overlay_fields.contains(runtime_field) {
            continue;
        }
        let definition = &merged["providers"][profile];
        let selected_model = merged
            .get("active_model_selection")
            .filter(|selection| selection["source_profile"].as_str() == Some(profile))
            .and_then(|selection| selection["model"].as_str())
            .or_else(|| merged.get("model").and_then(Value::as_str))
            .filter(|model| definition["models"].get(*model).is_some())
            .or_else(|| definition["default_model"].as_str());
        let profile_path = if let Some(model) = selected_model
            && definition["models"][model].get(profile_field).is_some()
        {
            format!("providers.{profile}.models.{model}.{profile_field}")
        } else {
            format!("providers.{profile}.{profile_field}")
        };
        if overlay_fields.contains(&profile_path) {
            overlay_fields.insert(runtime_field.to_string());
        } else if let Some(scope) = field_sources.get(&profile_path).copied() {
            field_sources.insert(runtime_field.to_string(), scope);
        }
    }
}

fn expand_active_provider_below_explicit_settings(merged: &mut Value) -> Result<()> {
    let configured: Settings =
        serde_json::from_value(merged.clone()).context("failed to inspect configured Provider")?;
    let Some(name) = configured.active_provider.as_deref() else {
        return Ok(());
    };
    let profile = configured
        .providers
        .get(name)
        .ok_or_else(|| anyhow::anyhow!("active_provider '{name}' is not present in providers"))?;
    let selected_model = configured
        .active_model_selection
        .as_ref()
        .filter(|selection| selection.source_profile == name)
        .map(|selection| selection.model.as_str())
        .or_else(|| merged.get("model").and_then(Value::as_str))
        .filter(|model| profile.has_model(model))
        .unwrap_or(&profile.default_model);
    let profile = profile.effective_for_model(selected_model)?;
    let mut profile_values = serde_json::json!({
        "active_provider": name,
        "provider": name,
        "api_format": profile.api_format,
        "base_url": profile.endpoint,
        "model": profile.default_model,
        "model_reasoning_effort": profile.reasoning_effort,
        "model_reasoning_policy": profile.reasoning_policy,
        "context_window_tokens": profile.context_window_tokens,
        "auto_compact_threshold_tokens": profile.auto_compact_threshold_tokens,
        "context_output_headroom": profile.output_headroom_tokens,
        "max_tokens": profile.max_output_tokens,
        "request_timeout_secs": profile.request_timeout_secs,
        "openai_user_agent": profile.user_agent,
        "provider_no_proxy": profile.no_proxy,
        "provider_extra_body": profile.extra_body,
        "provider_chat_protocol": profile.chat_protocol,
        "model_capabilities": profile.capabilities,
    });
    if let Some(max_retries) = profile.max_retries {
        profile_values["max_retries"] = serde_json::json!(max_retries);
    }
    if let Some(retry_base_delay_ms) = profile.retry_base_delay_ms {
        profile_values["retry_base_delay_ms"] = serde_json::json!(retry_base_delay_ms);
    }
    merge_settings_value(&mut profile_values, std::mem::take(merged));
    *merged = profile_values;
    Ok(())
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

impl Serialize for CredentialStore {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        if self.revoked.iter().any(|id| self.credentials.contains_key(id)) {
            return Err(serde::ser::Error::custom("Credential cannot be both present and revoked"));
        }
        let mut entries = self.credentials.iter().map(|(provider, key)| (
            provider, StoredApiCredential { credential_type: "api".into(), key: Some(key.clone()) }
        )).collect::<BTreeMap<_, _>>();
        for provider in &self.revoked {
            entries.insert(provider, StoredApiCredential { credential_type: "revoked".into(), key: None });
        }
        entries.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CredentialStore {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let stored = StoredCredentialDocument::deserialize(deserializer)?;
        let mut revoked = std::collections::BTreeSet::new();
        let credentials = match stored {
            StoredCredentialDocument::Legacy(legacy) => {
                let mut credentials = legacy.api_keys;
                if let Some(retired) = credentials.remove("minimax") {
                    credentials.entry("kunlunmeta".into()).or_insert(retired);
                }
                credentials
            },
            StoredCredentialDocument::Current(stored) => {
                let mut credentials = BTreeMap::new();
                for (provider, credential) in stored {
                    if credential.credential_type == "revoked" {
                        if credential.key.is_some() {
                            return Err(serde::de::Error::custom("Revoked credential must not contain a key"));
                        }
                        revoked.insert(provider);
                        continue;
                    }
                    if credential.credential_type != "api" {
                        return Err(serde::de::Error::custom(format!(
                            "credential for provider '{provider}' must have type 'api'"
                        )));
                    }
                    let key = credential.key.ok_or_else(|| serde::de::Error::custom("API credential requires a key"))?;
                    credentials.insert(provider, key);
                }
                credentials
            }
        };
        Ok(Self { credentials, revoked })
    }
}

impl CredentialStore {
    /// Read-modify-write credentials under the same per-file lock used by settings writers.
    pub fn update_file<F>(path: &Path, update: F) -> Result<()>
    where
        F: FnOnce(&mut Self) -> Result<()>,
    {
        let _transaction_guard = provider_transaction::write_guard(path)?;
        let lock = lock_settings_path(path)?;
        let result = (|| {
            let mut store = Self::load_from(path)?;
            let original = store.clone();
            update(&mut store)?;
            if store == original { return Ok(()); }
            store.save_to(path)
        })();
        FileExt::unlock(&lock).context("failed to unlock credential file")?;
        result
    }

    pub fn load() -> Result<Self> {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let path = ConfigPaths::discover(&cwd)?.credentials;
        Self::load_from(&path)
    }

    pub fn load_from(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = fs::read_to_string(path)
            .with_context(|| format!("failed to read credentials from {}", path.display()))?;
        serde_json::from_str(&content)
            .with_context(|| format!("failed to parse credentials from {}", path.display()))
    }

    pub fn save(&self) -> Result<()> {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let path = ConfigPaths::discover(&cwd)?.credentials;
        self.save_to(&path)
    }

    pub fn save_to(&self, path: &Path) -> Result<()> {
        let value = serde_json::to_value(self).context("failed to serialize credentials")?;
        write_json_atomic(path, &value, true)
    }

    pub fn set_api_key(&mut self, provider: &str, api_key: String) -> Result<()> {
        let provider = normalize_provider(provider)?;
        anyhow::ensure!(!api_key.trim().is_empty(), "API key must not be empty");
        self.revoked.remove(&provider);
        self.credentials.insert(provider, api_key);
        Ok(())
    }

    pub fn remove_api_key(&mut self, provider: &str) -> Result<bool> {
        let provider = normalize_provider(provider)?;
        let removed = self.credentials.remove(&provider).is_some();
        self.revoked.insert(provider);
        Ok(removed)
    }

    pub fn has_api_key(&self, provider: &str) -> bool {
        normalize_provider(provider)
            .ok()
            .is_some_and(|provider| self.credentials.contains_key(&provider))
    }
}

pub fn read_scope(paths: &ConfigPaths, scope: ConfigScope) -> Result<Value> {
    Ok(read_optional_json_object(paths.for_scope(scope))?
        .unwrap_or_else(|| Value::Object(Map::new())))
}

pub fn write_scope(paths: &ConfigPaths, scope: ConfigScope, value: &Value) -> Result<()> {
    let path = paths.for_scope(scope);
    let _transaction_guard = provider_transaction::write_guard(path)?;
    let lock = lock_settings_path(path)?;
    let result = write_scope_unlocked(paths, scope, value);
    FileExt::unlock(&lock)
        .with_context(|| format!("failed to unlock settings {}", path.display()))?;
    result
}

fn write_scope_unlocked(paths: &ConfigPaths, scope: ConfigScope, value: &Value) -> Result<()> {
    if !value.is_object() {
        bail!("settings root must be a JSON object");
    }
    // Validate the file as a partial Settings document. Serde defaults fill
    // omitted fields while still rejecting invalid values for present fields.
    validate_settings_document(value)
        .with_context(|| format!("invalid {} settings", scope.as_str()))?;
    write_json_atomic(paths.for_scope(scope), value, scope == ConfigScope::User)?;
    if matches!(scope, ConfigScope::Project | ConfigScope::Local) {
        ensure_project_gitignore(&paths.project_root)?;
    }
    Ok(())
}

/// Read, modify, and atomically write one configuration scope under the same file lock.
///
/// Every read-modify-write operation should use this function so processes neither share temporary files nor overwrite each other's updates.
pub fn update_scope<F>(paths: &ConfigPaths, scope: ConfigScope, update: F) -> Result<Value>
where
    F: FnOnce(&mut Value) -> Result<()>,
{
    let path = paths.for_scope(scope);
    let _transaction_guard = provider_transaction::write_guard(path)?;
    let lock = lock_settings_path(path)?;
    let result = (|| {
        let source = read_raw_optional_jsonc_object(path)?;
        let original = source
            .as_ref()
            .map(|document| document.value.clone())
            .unwrap_or_else(|| Value::Object(Map::new()));
        let mut value = original.clone();
        normalize_config_version(&mut value).map_err(|error| {
            anyhow::anyhow!("invalid settings version in {}: {error}", path.display())
        })?;
        normalize_legacy_settings_document(&mut value);
        update(&mut value)?;
        validate_settings_document(&value)
            .with_context(|| format!("invalid {} settings", scope.as_str()))?;
        write_jsonc_update_atomic(
            path,
            source.as_ref().map(|document| document.source.as_str()),
            &original,
            &value,
            scope == ConfigScope::User,
        )?;
        if matches!(scope, ConfigScope::Project | ConfigScope::Local) {
            ensure_project_gitignore(&paths.project_root)?;
        }
        Ok(value)
    })();
    FileExt::unlock(&lock)
        .with_context(|| format!("failed to unlock settings {}", path.display()))?;
    result
}

/// Update an explicit user-settings file from current on-disk content while holding its file lock.
///
/// This entry point does not merge product defaults, project configuration, or
/// read-only overlays first; callers always receive the JSON object declared by
/// the user file itself. The updated document is revalidated and atomically
/// replaced, allowing narrow field writes without materializing merged runtime state into the user layer.
pub fn update_settings_file<F>(path: &Path, update: F) -> Result<Value>
where
    F: FnOnce(&mut Value) -> Result<()>,
{
    let _transaction_guard = provider_transaction::write_guard(path)?;
    let lock = lock_settings_path(path)?;
    let result = (|| {
        let source = read_raw_optional_jsonc_object(path)?;
        let original = source
            .as_ref()
            .map(|document| document.value.clone())
            .unwrap_or_else(|| Value::Object(Map::new()));
        let mut value = original.clone();
        update(&mut value)?;
        validate_settings_document(&value)
            .with_context(|| format!("invalid user settings in {}", path.display()))?;
        write_jsonc_update_atomic(
            path,
            source.as_ref().map(|document| document.source.as_str()),
            &original,
            &value,
            true,
        )?;
        Ok(value)
    })();
    FileExt::unlock(&lock)
        .with_context(|| format!("failed to unlock settings {}", path.display()))?;
    result
}

/// Read an explicit user-settings file without home discovery, scope merging, or
/// writes. Treat a missing file as an empty object. JSONC comments participate in
/// parsing, while the read itself leaves file bytes unchanged.
pub fn read_settings_file(path: &Path) -> Result<Value> {
    let _transaction_guard = provider_transaction::read_guard(path)?;
    read_raw_optional_json_object(path)
        .map(|value| value.unwrap_or_else(|| Value::Object(Map::new())))
}

fn lock_settings_path(path: &Path) -> Result<fs::File> {
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create config directory {}", parent.display()))?;
    }
    let lock_path = path.with_extension("json.lock");
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .with_context(|| format!("failed to open settings lock {}", lock_path.display()))?;
    FileExt::lock_exclusive(&lock)
        .with_context(|| format!("failed to lock settings {}", lock_path.display()))?;
    Ok(lock)
}

/// Create a settings scope only when it does not already exist.
///
/// Returns `true` when the file was created. Concurrent creators are safe: an
/// existing file always wins and is never replaced.
pub fn write_scope_if_missing(
    paths: &ConfigPaths,
    scope: ConfigScope,
    value: &Value,
) -> Result<bool> {
    if !value.is_object() {
        bail!("settings root must be a JSON object");
    }
    validate_settings_document(value)
        .with_context(|| format!("invalid {} settings", scope.as_str()))?;
    let path = paths.for_scope(scope);
    let _transaction_guard = provider_transaction::write_guard(path)?;
    let lock = lock_settings_path(path)?;
    let result = if path.exists() {
        Ok(false)
    } else {
        // Write a complete temporary file before atomic publication. All cooperating
        // writers for one scope hold the same lock, so readers never observe a settings.json
        // that was created but not fully written.
        write_json_atomic(path, value, scope == ConfigScope::User).map(|()| true)
    };
    FileExt::unlock(&lock)
        .with_context(|| format!("failed to unlock settings {}", path.display()))?;
    let created = result?;
    if created && matches!(scope, ConfigScope::Project | ConfigScope::Local) {
        ensure_project_gitignore(&paths.project_root)?;
    }
    Ok(created)
}

/// Ensure project-local KCoder state is ignored without hiding shared project
/// settings, specs, skills, or plugins from version control.
pub fn ensure_project_gitignore(project_root: &Path) -> Result<PathBuf> {
    let kcoder_dir = project_root.join(".kcoder");
    fs::create_dir_all(&kcoder_dir)
        .with_context(|| format!("failed to create {}", kcoder_dir.display()))?;

    let path = kcoder_dir.join(".gitignore");
    let existing = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()));
        }
    };
    let existing_lines = existing.lines().map(str::trim).collect::<BTreeSet<_>>();
    let has_header = existing_lines.contains(PROJECT_GITIGNORE_HEADER);
    let missing_rules = PROJECT_GITIGNORE_RULES
        .iter()
        .copied()
        .filter(|rule| !existing_lines.contains(rule))
        .collect::<Vec<_>>();
    if missing_rules.is_empty() {
        return Ok(path);
    }

    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    if !updated.is_empty() {
        updated.push('\n');
    }
    if !has_header {
        updated.push_str(PROJECT_GITIGNORE_HEADER);
        updated.push('\n');
    }
    for rule in missing_rules {
        updated.push_str(rule);
        updated.push('\n');
    }
    fs::write(&path, updated).with_context(|| format!("failed to update {}", path.display()))?;
    Ok(path)
}

pub fn set_dotted_value(root: &mut Value, key: &str, value: Value) -> Result<()> {
    let parts = dotted_parts(key)?;
    let mut cursor = root;
    for part in &parts[..parts.len() - 1] {
        let object = cursor
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("setting parent '{}' is not an object", part))?;
        cursor = object
            .entry((*part).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    let object = cursor
        .as_object_mut()
        .context("settings root is not a JSON object")?;
    object.insert(parts[parts.len() - 1].to_string(), value);
    Ok(())
}

pub fn remove_dotted_value(root: &mut Value, key: &str) -> Result<bool> {
    let parts = dotted_parts(key)?;
    let mut cursor = root;
    for part in &parts[..parts.len() - 1] {
        let Some(next) = cursor
            .as_object_mut()
            .and_then(|object| object.get_mut(*part))
        else {
            return Ok(false);
        };
        cursor = next;
    }
    Ok(cursor
        .as_object_mut()
        .and_then(|object| object.remove(parts[parts.len() - 1]))
        .is_some())
}

pub fn dotted_value<'a>(root: &'a Value, key: &str) -> Result<Option<&'a Value>> {
    let parts = dotted_parts(key)?;
    let mut cursor = root;
    for part in parts {
        let Some(next) = cursor.as_object().and_then(|object| object.get(part)) else {
            return Ok(None);
        };
        cursor = next;
    }
    Ok(Some(cursor))
}

/// Resolve the user-level KCoder configuration directory.
///
/// `KCODER_CONFIG_DIR` is the highest-priority explicit override; `KCODER_HOME`
/// selects an explicit profile directory. When neither is set, choose the
/// development profile from the executable name, while regular `kcoder` uses
/// `$HOME/.config/kcoder`。
pub fn user_config_dir() -> Result<PathBuf> {
    resolve_user_config_dir(
        std::env::var_os(CONFIG_DIR_ENV),
        std::env::var_os(KCODER_HOME_ENV),
        std::env::current_exe()
            .ok()
            .and_then(|path| path.file_stem().map(|stem| stem.to_os_string())),
        dirs::home_dir(),
    )
}

fn resolve_user_config_dir(
    config_override: Option<std::ffi::OsString>,
    kcoder_home: Option<std::ffi::OsString>,
    executable_stem: Option<std::ffi::OsString>,
    home_dir: Option<PathBuf>,
) -> Result<PathBuf> {
    if let Some(path) = config_override.filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = kcoder_home.filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }

    let home_dir = home_dir.context("could not determine home directory")?;
    let config_dir = home_dir.join(".config").join("kcoder");
    let executable_stem = executable_stem
        .as_deref()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default();
    let development_profile = executable_stem.eq_ignore_ascii_case(DEVELOPMENT_EXECUTABLE_STEM);
    if development_profile {
        return Ok(home_dir.join(".config").join("kcoder-dev"));
    }
    Ok(config_dir)
}

fn canonical_or_original(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn normalize_config_version(document: &mut Value) -> Result<()> {
    let Some(root) = document.as_object_mut() else {
        return Ok(());
    };
    let meta = root
        .entry("meta")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(meta) = meta.as_object_mut() else {
        bail!("settings meta must be an object");
    };
    let Some(version_value) = meta.get("config_version") else {
        meta.insert(
            "config_version".to_string(),
            Value::from(CURRENT_CONFIG_VERSION),
        );
        return Ok(());
    };
    let Some(version) = version_value.as_u64() else {
        bail!("settings meta.config_version must be integer v1");
    };
    if version > CURRENT_CONFIG_VERSION {
        bail!(
            "unsupported future settings meta.config_version={version}; current supported version is v{}",
            CURRENT_CONFIG_VERSION
        );
    }
    if version < CURRENT_CONFIG_VERSION {
        bail!(
            "unsupported settings meta.config_version={version}; current supported version is v{}",
            CURRENT_CONFIG_VERSION
        );
    }
    Ok(())
}

fn read_optional_json_object(path: &Path) -> Result<Option<Value>> {
    let Some(mut value) = read_raw_optional_json_object(path)? else {
        return Ok(None);
    };
    normalize_config_version(&mut value).map_err(|error| {
        anyhow::anyhow!("invalid settings version in {}: {error}", path.display())
    })?;
    normalize_legacy_settings_document(&mut value);
    Ok(Some(value))
}

struct RawJsoncObject {
    source: String,
    value: Value,
}

fn read_raw_optional_json_object(path: &Path) -> Result<Option<Value>> {
    Ok(read_raw_optional_jsonc_object(path)?.map(|document| document.value))
}

fn read_raw_optional_jsonc_object(path: &Path) -> Result<Option<RawJsoncObject>> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path)
        .with_context(|| format!("failed to read settings from {}", path.display()))?;
    let value: Value = if content.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        jsonc_parser::parse_to_serde_value(&content, &Default::default())
            .with_context(|| format!("failed to parse settings from {}", path.display()))?
    };
    if !value.is_object() {
        bail!(
            "settings file {} must contain a JSON object",
            path.display()
        );
    }
    Ok(Some(RawJsoncObject {
        source: content,
        value,
    }))
}

fn validate_settings_document(value: &Value) -> Result<()> {
    let mut normalized_value = value.clone();
    normalize_config_version(&mut normalized_value)?;
    normalize_legacy_settings_document(&mut normalized_value);
    crate::schema::validate_settings_schema(&normalized_value)
        .map_err(|error| anyhow::anyhow!("settings failed embedded schema validation: {error}"))?;
    let complete_providers = normalized_value
        .get("providers")
        .and_then(Value::as_object)
        .map(|profiles| {
            profiles
                .iter()
                .filter(|(_, profile)| {
                    let transport_complete = ["api_format", "endpoint", "default_model"]
                        .iter()
                        .all(|field| profile.get(field).is_some());
                    transport_complete
                        && (profile
                            .get("models")
                            .and_then(Value::as_object)
                            .is_some_and(|models| !models.is_empty())
                            || [
                                "api_format",
                                "endpoint",
                                "default_model",
                                "context_window_tokens",
                                "output_headroom_tokens",
                                "max_output_tokens",
                            ]
                            .iter()
                            .all(|field| profile.get(field).is_some()))
                })
                .map(|(name, _)| name.clone())
                .collect::<std::collections::BTreeSet<_>>()
        })
        .unwrap_or_default();
    let mut validation_value = normalized_value;
    if let Some(profiles) = validation_value
        .get_mut("providers")
        .and_then(Value::as_object_mut)
    {
        for profile in profiles.values_mut() {
            let mut complete = serde_json::json!({
                "api_format": "anthropic_messages",
                "endpoint": "https://placeholder.invalid",
                "default_model": "placeholder",
                "context_window_tokens": 1,
                "output_headroom_tokens": 1,
                "max_output_tokens": 1
            });
            merge_settings_value(&mut complete, std::mem::replace(profile, Value::Null));
            *profile = complete;
        }
    }
    let content = serde_json::to_string(&validation_value)
        .context("failed to serialize settings for validation")?;
    let mut deserializer = serde_json::Deserializer::from_str(&content);
    let mut unknown = Vec::new();
    let settings: Settings = serde_ignored::deserialize(&mut deserializer, |path| {
        let path = path.to_string();
        // The `hooks` top-level field is owned by the hooks subsystem
        // (kcoder_hooks reads the same settings files); it is not part of the
        // main settings schema but must not fail startup.
        if path != "hooks" && path != "$schema" {
            unknown.push(path);
        }
    })
    .context("settings contain an invalid value")?;
    if !unknown.is_empty() {
        unknown.sort();
        unknown.dedup();
        bail!("unknown setting field(s): {}", unknown.join(", "));
    }
    if let (Some(total), Some(output)) = (
        settings.context_window_tokens,
        settings.context_output_headroom,
    ) {
        let hard = settings
            .context_hard_input_tokens
            .unwrap_or_else(|| total.saturating_sub(output));
        if hard == 0 || hard >= total {
            bail!(
                "context_hard_input_tokens must be greater than zero and below context_window_tokens"
            );
        }
        if settings
            .auto_compact_threshold_tokens
            .is_some_and(|soft| soft == 0 || soft >= hard)
        {
            bail!(
                "auto_compact_threshold_tokens must be greater than zero and below the hard input limit"
            );
        }
        let soft = settings.auto_compact_threshold_tokens.unwrap_or_else(|| {
            let percentage = settings
                .context_compaction
                .auto_threshold
                .percentage_for(total);
            hard.saturating_mul(percentage) / 100
        });
        if settings
            .prefire_threshold_tokens
            .is_some_and(|prefire| prefire == 0 || prefire >= soft)
        {
            bail!(
                "prefire_threshold_tokens must be greater than zero and below auto_compact_threshold_tokens"
            );
        }
    }
    if settings.estimated_tool_growth_tokens == Some(0) {
        bail!("estimated_tool_growth_tokens must be greater than zero");
    }
    for (name, profile) in &settings.providers {
        if !complete_providers.contains(name) {
            continue;
        }
        if profile.endpoint.trim().is_empty()
            || !(profile.endpoint.starts_with("http://")
                || profile.endpoint.starts_with("https://"))
        {
            bail!("Provider '{name}' has an invalid HTTP(S) endpoint");
        }
        if profile.default_model.trim().is_empty() {
            bail!("provider '{name}' has an empty default_model");
        }
        let credential = profile.credential(name);
        crate::validate_provider_id(&credential.id)
            .with_context(|| format!("Provider '{name}' has an invalid provider id"))?;
        for env_name in &credential.env {
            let mut chars = env_name.chars();
            let valid = chars
                .next()
                .is_some_and(|ch| ch == '_' || ch.is_ascii_alphabetic())
                && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric());
            if !valid {
                bail!("Provider '{name}' has invalid credential_env name '{env_name}'");
            }
        }
        profile
            .validate_models()
            .with_context(|| format!("Provider '{name}' has invalid model configuration"))?;
        if profile.request_timeout_secs == Some(0) {
            bail!("Provider '{name}' request_timeout_secs must be greater than zero");
        }
        if profile.retry_base_delay_ms == Some(0) {
            bail!("Provider '{name}' retry_base_delay_ms must be greater than zero");
        }
        let provider = crate::validate_provider_id(name)?;
        let compatible = match provider.as_str() {
            "anthropic" | "kunlunmeta" => profile.api_format == crate::ApiFormat::AnthropicMessages,
            "openai" | "local" | "grok" => matches!(
                profile.api_format,
                crate::ApiFormat::OpenaiChatCompletions | crate::ApiFormat::OpenaiResponses
            ),
            "gemini" => profile.api_format == crate::ApiFormat::GeminiGenerateContent,
            // Custom providers select their transport explicitly with api_format.
            _ => true,
        };
        if !compatible {
            bail!(
                "provider '{name}' uses incompatible api_format '{}'",
                profile.api_format.as_str()
            );
        }
    }
    Ok(())
}

fn validate_profile_references(value: &Value) -> Result<()> {
    let settings: Settings =
        serde_json::from_value(value.clone()).context("failed to validate Provider references")?;
    if let Some(profile) = settings.summary_profile.as_deref()
        && !settings.providers.contains_key(profile)
    {
        bail!("summary_profile references unknown Provider '{profile}'");
    }
    if let Some(profile) = settings.goal_pro.verifier_profile.as_deref()
        && !settings.providers.contains_key(profile)
    {
        bail!("goal_pro.verifier_profile references unknown Provider '{profile}'");
    }
    for slot in &settings.goal_pro.verifier_models {
        if let Some(profile) = slot.profile.as_deref()
            && !settings.providers.contains_key(profile)
        {
            bail!("goal_pro.verifier_models references unknown Provider '{profile}'");
        }
    }
    validate_orchestrate_settings(&settings)?;
    for (id, profile) in &settings.providers {
        if !profile.authentication.is_api_key()
            && profile.api_format != crate::ApiFormat::OpenaiChatCompletions
        {
            bail!(
                "Provider '{id}' supports authentication.mode=none only with openai_chat_completions"
            );
        }
    }
    validate_goal_pro_model_escalation(&settings)?;
    for (preset_name, preset) in &settings.moa.presets {
        for slot in preset
            .reference_models
            .iter()
            .chain(std::iter::once(&preset.aggregator))
        {
            if let Some(profile) = slot.profile.as_deref()
                && !settings.providers.contains_key(profile)
            {
                bail!("MoA preset '{preset_name}' references unknown Provider '{profile}'");
            }
        }
    }
    Ok(())
}

fn validate_orchestrate_settings(settings: &Settings) -> Result<()> {
    let orchestrate = &settings.orchestrate;
    if let Some(allowlist) = orchestrate.main.optional_tool_allowlist.as_ref() {
        if allowlist.iter().any(|tool| tool.trim().is_empty()) {
            bail!("orchestrate.main.optional_tool_allowlist contains an empty tool name");
        }
        let core = crate::orchestrate_main_core_tools();
        let protected = allowlist
            .iter()
            .filter(|tool| core.contains(&tool.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !protected.is_empty() {
            bail!(
                "orchestrate.main.optional_tool_allowlist must not list protected core capabilities because they are always enabled: {}",
                protected.join(", ")
            );
        }
        let optional = crate::orchestrate_main_optional_tools();
        let unknown = allowlist
            .iter()
            .filter(|tool| !optional.contains(&tool.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            bail!(
                "orchestrate.main.optional_tool_allowlist contains unknown optional tools: {}",
                unknown.join(", ")
            );
        }
    }
    if !(30..=3_600).contains(&orchestrate.delivery.lease_timeout_seconds) {
        bail!("orchestrate.delivery.lease_timeout_seconds must be between 30 and 3600");
    }
    if !(1..=64).contains(&orchestrate.delivery.max_attempts) {
        bail!("orchestrate.delivery.max_attempts must be between 1 and 64");
    }
    if !(1..=100).contains(&orchestrate.fleet.max_members) {
        bail!("orchestrate.fleet.max_members must be between 1 and 100");
    }
    if !(1_024..=32_768).contains(&orchestrate.fleet.max_inject_bytes) {
        bail!("orchestrate.fleet.max_inject_bytes must be between 1024 and 32768");
    }
    for (name, value) in [
        (
            "repeated_action_threshold",
            orchestrate.breaker.repeated_action_threshold,
        ),
        (
            "consecutive_error_threshold",
            orchestrate.breaker.consecutive_error_threshold,
        ),
        ("no_progress_rounds", orchestrate.breaker.no_progress_rounds),
    ] {
        if !(1..=64).contains(&value) {
            bail!("orchestrate.breaker.{name} must be between 1 and 64");
        }
    }
    if !(128..=65_536).contains(&orchestrate.audit.max_events) {
        bail!("orchestrate.audit.max_events must be between 128 and 65536");
    }
    if !(512..=65_536).contains(&orchestrate.audit.max_event_bytes) {
        bail!("orchestrate.audit.max_event_bytes must be between 512 and 65536");
    }
    for (tier_name, slot) in &settings.orchestrate.tiers {
        if tier_name.trim().is_empty() {
            bail!("orchestrate.tiers names must not be empty");
        }
        if slot.profile.is_some() && (slot.provider.is_some() || slot.model.is_some()) {
            bail!("orchestrate.tiers.{tier_name} cannot combine profile with provider/model");
        }
        if let Some(referenced) = slot.profile.as_deref().or(slot.provider.as_deref())
            && !settings.providers.contains_key(referenced)
        {
            bail!("orchestrate.tiers.{tier_name} references unknown Provider '{referenced}'");
        }
    }
    for (name, entry) in &settings.orchestrate.roster {
        if !matches!(name.as_str(), "junior" | "oracle" | "librarian" | "critic") {
            bail!("orchestrate.roster contains unknown persona '{name}'");
        }
        if !settings.orchestrate.tiers.contains_key(&entry.tier) {
            bail!(
                "orchestrate.roster.{name}.tier references unknown tier '{}'",
                entry.tier
            );
        }
        if let Some(allowlist) = entry.tool_allowlist.as_ref()
            && allowlist.iter().any(|tool| tool.trim().is_empty())
        {
            bail!("orchestrate.roster.{name}.tool_allowlist contains an empty tool name");
        }
        if let Some(allowlist) = entry.tool_allowlist.as_ref() {
            let maximum = crate::orchestrate_persona_max_tools(name)
                .expect("known persona must have a compiled capability profile");
            let expanded = allowlist
                .iter()
                .filter(|tool| !maximum.contains(&tool.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            if !expanded.is_empty() {
                bail!(
                    "orchestrate.roster.{name}.tool_allowlist would expand the compiled base-role capability with: {}",
                    expanded.join(", ")
                );
            }
        }
        if entry.context_mode == crate::OrchestrateContextMode::Full {
            let tier = settings
                .orchestrate
                .tiers
                .get(&entry.tier)
                .expect("tier existence checked above");
            if let Some(target_name) = tier.profile.as_deref().or(tier.provider.as_deref()) {
                let main_name = settings
                    .active_provider
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("kunlunmeta");
                let main = settings.providers.get(main_name).ok_or_else(|| {
                    anyhow::anyhow!(
                        "orchestrate.roster.{name}.context_mode=full requires active Provider '{main_name}'"
                    )
                })?;
                let target = settings.providers.get(target_name).ok_or_else(|| {
                    anyhow::anyhow!(
                        "orchestrate.roster.{name} references unknown Provider '{target_name}'"
                    )
                })?;
                let main = main.effective_for_model(if main.has_model(&settings.model) {
                    &settings.model
                } else {
                    &main.default_model
                })?;
                let target_model = tier.model.as_deref().unwrap_or(&target.default_model);
                let target = if target.has_model(target_model) {
                    target.effective_for_model(target_model)?
                } else if target.models.is_empty() {
                    target.effective_for_model(&target.default_model)?
                } else {
                    bail!(
                        "orchestrate full-context tier references unconfigured model '{target_model}'"
                    );
                };
                if target.api_format != main.api_format
                    || target.context_window_tokens != main.context_window_tokens
                {
                    bail!(
                        "orchestrate.roster.{name}.context_mode=full is incompatible: tier Provider '{target_name}' must share api_format and context_window_tokens with active Provider '{main_name}'"
                    );
                }
            }
        }
    }
    Ok(())
}

/// Load-time consistency validation for Goal Pro model-escalation rungs. Full
/// primary-agent context inheritance requires every rung to share the primary
/// provider's api_format and context window; fail fast otherwise.
fn validate_goal_pro_model_escalation(settings: &Settings) -> Result<()> {
    let escalation = &settings.goal_pro.model_escalation;
    if !escalation.enabled {
        return Ok(());
    }
    if escalation.models.is_empty() {
        bail!("goal_pro.model_escalation is enabled but models is empty");
    }
    if escalation.threshold == 0 {
        bail!("goal_pro.model_escalation.threshold must be at least 1");
    }
    let main_name = settings
        .active_provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("kunlunmeta");
    let main = settings.providers.get(main_name).ok_or_else(|| {
        anyhow::anyhow!(
            "goal_pro.model_escalation requires the active Provider '{main_name}' to be declared in providers"
        )
    })?;
    let main = main.effective_for_model(if main.has_model(&settings.model) {
        &settings.model
    } else {
        &main.default_model
    })?;
    for slot in &escalation.models {
        let referenced = slot.profile.as_deref().or(slot.provider.as_deref());
        let Some(referenced) = referenced else {
            // Three empty slots inherit the primary runtime and therefore always match the primary provider.
            continue;
        };
        let config = settings.providers.get(referenced).ok_or_else(|| {
            anyhow::anyhow!(
                "goal_pro.model_escalation.models references unknown Provider '{referenced}'"
            )
        })?;
        let selected_model = slot.model.as_deref().unwrap_or(&config.default_model);
        let config = if config.has_model(selected_model) {
            config.effective_for_model(selected_model)?
        } else if config.models.is_empty() {
            config.effective_for_model(&config.default_model)?
        } else {
            bail!("goal_pro.model_escalation references unconfigured model '{selected_model}'");
        };
        if config.api_format != main.api_format {
            bail!(
                "goal_pro.model_escalation entry '{referenced}' uses api_format '{}' but the main Provider '{main_name}' uses '{}'; escalation models must share the main Provider's api_format and context window",
                config.api_format.as_str(),
                main.api_format.as_str(),
            );
        }
        if config.context_window_tokens != main.context_window_tokens {
            bail!(
                "goal_pro.model_escalation entry '{referenced}' has context_window_tokens={} but the main Provider '{main_name}' has {}; escalation models must share the main Provider's api_format and context window",
                config.context_window_tokens,
                main.context_window_tokens,
            );
        }
    }
    Ok(())
}

fn merge_settings_value(target: &mut Value, source: Value) {
    merge_settings_value_at(target, source, &mut Vec::new());
}

fn merge_settings_value_at(target: &mut Value, source: Value, path: &mut Vec<String>) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, source_value) in source {
                if path.len() == 2 && path[0] == "providers" && key == "models" {
                    target.insert(key, source_value);
                    continue;
                }
                path.push(key.clone());
                match target.get_mut(&key) {
                    Some(target_value) => merge_settings_value_at(target_value, source_value, path),
                    None => {
                        target.insert(key, source_value);
                    }
                }
                path.pop();
            }
        }
        (target @ Value::Array(_), source @ Value::Array(_)) => *target = source,
        (target, source) => *target = source,
    }
}

/// Merge a partial settings document into another using normal layer semantics.
pub fn merge_settings_documents(target: &mut Value, source: Value) {
    merge_settings_value(target, source);
}

/// Validate one user settings document against the complete embedded defaults
/// and return the resolved runtime settings without credentials or environment
/// overrides.
pub fn validate_and_resolve_settings_document(value: &Value) -> Result<Settings> {
    validate_settings_document(value).context("invalid user settings")?;
    let mut merged = default_settings_document();
    merge_settings_value(&mut merged, value.clone());
    // A standalone document has the same catalog ownership as an explicit file layer.
    if value.get("providers").is_some() {
        let declared: BTreeSet<_> = provider_names_of(value).collect();
        if let Some(profiles) = merged.get_mut("providers").and_then(Value::as_object_mut) {
            profiles.retain(|name, _| declared.contains(name));
        }
        if value.get("active_provider").is_none()
            && !merged
                .get("active_provider")
                .and_then(Value::as_str)
                .is_some_and(|name| declared.contains(name))
        {
            merged["active_provider"] = declared
                .first()
                .cloned()
                .map(Value::String)
                .unwrap_or(Value::Null);
        }
    }
    normalize_legacy_profile_references(&mut merged);
    validate_settings_document(&merged).context("invalid merged settings")?;
    validate_profile_references(&merged)?;
    expand_active_provider_below_explicit_settings(&mut merged)?;
    let settings: Settings = serde_json::from_value(merged).context("failed to deserialize resolved KCoder settings")?;
    settings.validate_model_reasoning_policy()?;
    Ok(settings)
}

fn record_leaf_sources(
    value: &Value,
    prefix: &str,
    scope: ConfigScope,
    sources: &mut BTreeMap<String, ConfigScope>,
) {
    if let Value::Object(object) = value {
        for (key, nested) in object {
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            if nested.as_object().is_some_and(|object| !object.is_empty()) {
                record_leaf_sources(nested, &path, scope, sources);
            } else {
                sources.insert(path, scope);
            }
        }
    }
}

fn record_leaf_names(value: &Value, prefix: &str, names: &mut BTreeSet<String>) {
    if let Value::Object(object) = value {
        for (key, nested) in object {
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            if nested.as_object().is_some_and(|object| !object.is_empty()) {
                record_leaf_names(nested, &path, names);
            } else {
                names.insert(path);
            }
        }
    }
}

fn write_json_atomic(path: &Path, value: &Value, require_user_only: bool) -> Result<()> {
    let content = serde_json::to_string_pretty(value).context("failed to serialize JSON")?;
    write_bytes_atomic(path, format!("{content}\n").as_bytes(), require_user_only)
}

/// Rewrite only JSONC nodes whose semantics changed, preserving user comments and adjacent formatting during incremental persistence.
fn write_jsonc_update_atomic(
    path: &Path,
    source: Option<&str>,
    original: &Value,
    updated: &Value,
    require_user_only: bool,
) -> Result<()> {
    if original == updated {
        return Ok(());
    }

    let Some(source) = source else {
        return write_json_atomic(path, updated, require_user_only);
    };
    let root = CstRootNode::parse(source, &Default::default())
        .with_context(|| format!("failed to parse JSONC syntax tree from {}", path.display()))?;
    let object = root.object_value_or_create().ok_or_else(|| {
        anyhow::anyhow!(
            "settings file {} must contain a JSON object",
            path.display()
        )
    })?;
    reconcile_jsonc_object(
        &object,
        original
            .as_object()
            .context("original settings root is not a JSON object")?,
        updated
            .as_object()
            .context("updated settings root is not a JSON object")?,
        "",
    )?;

    let rendered = root.to_string();
    let reparsed: Value = jsonc_parser::parse_to_serde_value(&rendered, &Default::default())
        .with_context(|| {
            format!(
                "failed to verify updated JSONC document for {}",
                path.display()
            )
        })?;
    if &reparsed != updated {
        bail!(
            "refusing to write {} because the JSONC edit did not reproduce the requested settings",
            path.display()
        );
    }
    write_bytes_atomic(path, rendered.as_bytes(), require_user_only)
}

fn reconcile_jsonc_object(
    object: &CstObject,
    original: &Map<String, Value>,
    updated: &Map<String, Value>,
    prefix: &str,
) -> Result<()> {
    for key in original.keys().filter(|key| !updated.contains_key(*key)) {
        let path = dotted_child(prefix, key);
        single_jsonc_property(object, key, &path)?.remove();
    }

    for (key, updated_value) in updated {
        let path = dotted_child(prefix, key);
        let Some(original_value) = original.get(key) else {
            object.append(key, json_value_to_cst(updated_value));
            continue;
        };
        if original_value == updated_value {
            continue;
        }

        let property = single_jsonc_property(object, key, &path)?;
        match (original_value.as_object(), updated_value.as_object()) {
            (Some(original_object), Some(updated_object)) => {
                let nested = property.object_value().ok_or_else(|| {
                    anyhow::anyhow!(
                        "cannot safely update JSONC property '{path}' because its syntax is not an object"
                    )
                })?;
                reconcile_jsonc_object(&nested, original_object, updated_object, &path)?;
            }
            // Arrays lack stable element identities; replace the whole array on semantic changes instead of guessing moves or removals.
            _ => property.set_value(json_value_to_cst(updated_value)),
        }
    }
    Ok(())
}

fn single_jsonc_property(object: &CstObject, key: &str, path: &str) -> Result<CstObjectProp> {
    let mut matches = Vec::new();
    for property in object.properties() {
        let name = property
            .name()
            .ok_or_else(|| anyhow::anyhow!("JSONC property in '{path}' has no name"))?;
        let decoded = name.decoded_value().map_err(|error| {
            anyhow::anyhow!("failed to decode JSONC property name near '{path}': {error:?}")
        })?;
        if decoded == key {
            matches.push(property);
        }
    }
    match matches.len() {
        1 => Ok(matches.pop().expect("one JSONC property was counted")),
        0 => bail!("cannot safely update missing JSONC property '{path}'"),
        _ => bail!("cannot safely update duplicate JSONC property '{path}'"),
    }
}

fn dotted_child(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        key.to_string()
    } else {
        format!("{prefix}.{key}")
    }
}

fn json_value_to_cst(value: &Value) -> CstInputValue {
    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(value) => CstInputValue::Bool(*value),
        Value::Number(value) => CstInputValue::Number(value.to_string()),
        Value::String(value) => CstInputValue::String(value.clone()),
        Value::Array(values) => {
            CstInputValue::Array(values.iter().map(json_value_to_cst).collect())
        }
        Value::Object(values) => CstInputValue::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), json_value_to_cst(value)))
                .collect(),
        ),
    }
}

pub(crate) fn write_bytes_atomic(
    path: &Path,
    content: &[u8],
    require_user_only: bool,
) -> Result<()> {
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create config directory {}", parent.display()))?;
    }
    let parent = fs::canonicalize(path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new(".")))?;
    let name = path.file_name().context("Configuration filename is missing")?;
    let directory = crate::private_files::PrivateDirectory::open_existing(&parent)?;
    let _ = require_user_only;
    directory.atomic_replace(name, content)

}

fn dotted_parts(key: &str) -> Result<Vec<&str>> {
    let parts = key.split('.').collect::<Vec<_>>();
    if parts.is_empty() || parts.iter().any(|part| part.trim().is_empty()) {
        bail!("setting name must be a non-empty dotted path");
    }
    Ok(parts)
}

fn normalize_provider(provider: &str) -> Result<String> {
    crate::validate_provider_id(provider)
}

fn apply_credentials(settings: &mut Settings, credentials: &CredentialStore) {
    // Markers in credentials.json resolve through the operating-system credential store; a
    // marker that cannot be resolved is dropped so it never reaches a Provider as an API key.
    let (resolved, diagnostics) = crate::resolve_stored_credentials(
        &credentials.credentials,
        &crate::OsCredentialBackend::new(),
        settings.credential_store,
    );
    for diagnostic in &diagnostics {
        tracing::warn!(target: "kcoder_config::credentials", "{diagnostic}");
    }
    settings.stored_provider_credentials = resolved.clone();
    settings.revoked_provider_credentials = credentials.revoked.clone();
    for (provider, api_key) in &resolved {
        let target = match provider.as_str() {
            "anthropic" => &mut settings.anthropic_api_key,
            "kunlunmeta" => &mut settings.kunlunmeta_api_key,
            "openai" => &mut settings.openai_api_key,
            "local" => &mut settings.local_api_key,
            "gemini" => &mut settings.gemini_api_key,
            "grok" => &mut settings.grok_api_key,
            _ => continue,
        };
        *target = Some(api_key.clone());
    }
}

#[cfg(test)]
mod credential_store_tests {
    use super::*;

    fn write_credentials(path: &Path, provider: &str, value: &str) {
        std::fs::write(
            path,
            format!("{{\"{provider}\": {{\"type\": \"api\", \"key\": \"{value}\"}}}}"),
        )
        .unwrap();
    }

    #[test]
    fn revocation_survives_reload_blocks_fallback_and_login_clears_it() {
        let temp = tempfile::tempdir().unwrap();
        let loader = SettingsLoader::new(temp.path()).with_config_dir(temp.path());
        let paths = loader.paths().unwrap();
        let mut store = CredentialStore::default();
        store.set_api_key("openai", "stored-fixture".into()).unwrap();
        assert!(store.remove_api_key("openai").unwrap());
        store.save_to(&paths.credentials).unwrap();
        let document: Value = serde_json::from_slice(&fs::read(&paths.credentials).unwrap()).unwrap();
        assert_eq!(document["openai"], serde_json::json!({"type":"revoked"}));
        // The old wire shape requires a key, so an old client cannot silently fall back.
        #[derive(Deserialize)]
        struct OldEntry { #[serde(rename="key")] _key: String }
        assert!(serde_json::from_value::<BTreeMap<String, OldEntry>>(document).is_err());
        let mut settings = Settings::default();
        settings.openai_api_key = Some("legacy-fixture".into());
        settings.api_key = Some("global-fixture".into());
        loader.refresh_stored_provider_credentials(&mut settings).unwrap();
        assert!(settings.resolve_provider_api_key(Some("openai"), None).is_none());
        assert_eq!(settings.resolve_provider_api_key(Some("openai"), Some("explicit-fixture".into())).as_deref(), Some("explicit-fixture"));
        let mut restored = CredentialStore::load_from(&paths.credentials).unwrap();
        assert!(restored.set_api_key("openai", " ".into()).is_err());
        assert!(restored.revoked.contains("openai"));
        restored.set_api_key("openai", "replacement-fixture".into()).unwrap();
        restored.save_to(&paths.credentials).unwrap();
        loader.refresh_stored_provider_credentials(&mut settings).unwrap();
        assert_eq!(settings.resolve_provider_api_key(Some("openai"), None).as_deref(), Some("replacement-fixture"));
    }

    #[test]
    fn revocation_only_update_is_persisted_and_conflicting_entries_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        CredentialStore::update_file(&path, |store| {
            store.remove_api_key("fixture")?;
            Ok(())
        }).unwrap();
        assert!(CredentialStore::load_from(&path).unwrap().revoked.contains("fixture"));
        assert!(serde_json::from_value::<CredentialStore>(serde_json::json!({"fixture":{"type":"revoked","key":"secret-fixture"}})).is_err());
        let mut conflicting = CredentialStore::default();
        conflicting.revoked.insert("fixture".into());
        conflicting.credentials.insert("fixture".into(), "secret-fixture".into());
        assert!(serde_json::to_value(&conflicting).is_err());
    }

    #[test]
    fn credential_refresh_preserves_semantics_and_observes_rotation_and_removal() {
        let temp = tempfile::tempdir().unwrap();
        let loader = SettingsLoader::new(temp.path()).with_config_dir(temp.path());
        let paths = loader.paths().unwrap();
        // An unrelated invalid edit must not invalidate an in-flight model snapshot.
        std::fs::write(&paths.user_settings, "invalid settings document").unwrap();
        let mut settings = Settings::default();
        settings.model = "pinned-model".into();
        settings.max_tokens = Some(1234);
        settings.credential_store = crate::CredentialStoreMode::File;
        write_credentials(&paths.credentials, "openai", "first-fixture");
        loader.refresh_stored_provider_credentials(&mut settings).unwrap();
        let source = settings.resolve_provider_api_key_with_source(Some("openai"), None).unwrap().source;
        write_credentials(&paths.credentials, "openai", "rotated-fixture");
        loader.refresh_stored_provider_credentials(&mut settings).unwrap();
        assert_eq!(settings.resolve_bound_provider_api_key(Some("openai"), None, &source).unwrap().into_key(), "rotated-fixture");
        assert_eq!(settings.model, "pinned-model");
        assert_eq!(settings.max_tokens, Some(1234));
        std::fs::write(&paths.credentials, "{}").unwrap();
        loader.refresh_stored_provider_credentials(&mut settings).unwrap();
        assert!(settings.resolve_bound_provider_api_key(Some("openai"), None, &source).is_err());
        assert!(settings.openai_api_key.is_none());
    }

    #[test]
    fn markers_are_dropped_when_the_credential_store_is_file() {
        let temp = tempfile::tempdir().unwrap();
        let credentials = temp.path().join("credentials.json");
        write_credentials(&credentials, "deepseek", "keyring:kcoder/deepseek");
        let mut settings = Settings::default();
        settings.credential_store = crate::CredentialStoreMode::File;
        let store = CredentialStore::load_from(&credentials).unwrap();
        apply_credentials(&mut settings, &store);
        assert!(settings.stored_provider_credentials.is_empty());

        write_credentials(&credentials, "deepseek", "sk-plaintext");
        let store = CredentialStore::load_from(&credentials).unwrap();
        apply_credentials(&mut settings, &store);
        assert_eq!(
            settings
                .stored_provider_credentials
                .get("deepseek")
                .map(String::as_str),
            Some("sk-plaintext")
        );

        write_credentials(&credentials, "openai", "sk-legacy-openai");
        let store = CredentialStore::load_from(&credentials).unwrap();
        apply_credentials(&mut settings, &store);
        assert_eq!(settings.openai_api_key.as_deref(), Some("sk-legacy-openai"));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn resolved_document_preserves_an_explicit_empty_provider_catalog() {
        for document in [
            serde_json::json!({"providers": {}}),
            serde_json::json!({"providers": {}, "active_provider": null}),
        ] {
            let settings = super::validate_and_resolve_settings_document(&document).unwrap();
            assert!(settings.providers.is_empty());
            assert!(settings.active_provider.is_none());
        }
    }

    #[test]
    fn resolved_document_selects_only_declared_providers() {
        let profile = serde_json::to_value(crate::default_active_provider_config()).unwrap();
        let settings = super::validate_and_resolve_settings_document(&serde_json::json!({
            "providers": {"remote-only": profile}
        }))
        .unwrap();
        assert_eq!(
            settings
                .providers
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["remote-only"]
        );
        assert_eq!(settings.active_provider.as_deref(), Some("remote-only"));
        assert!(
            super::validate_and_resolve_settings_document(&serde_json::json!({}))
                .unwrap()
                .providers
                .contains_key("kunlunmeta")
        );
        assert!(
            super::validate_and_resolve_settings_document(&serde_json::json!({
                "providers": {}, "active_provider": "kunlunmeta"
            }))
            .is_err()
        );
    }

    use super::*;
    use tempfile::TempDir;

    #[test]
    fn recovery_total_timeout_settings_boundaries_and_layers() {
        let mut document = serde_json::json!({});
        let defaults = validate_and_resolve_settings_document(&document).unwrap();
        assert!(
            serde_json::to_value(defaults).unwrap()["recovery"]["provider"]["total_timeout_ms"]
                .is_null()
        );
        for timeout in [1, 86_400_000] {
            merge_settings_documents(
                &mut document,
                serde_json::json!({"recovery":{"provider":{"total_timeout_ms":timeout}}}),
            );
            let settings = validate_and_resolve_settings_document(&document).unwrap();
            assert_eq!(
                serde_json::to_value(settings).unwrap()["recovery"]["provider"]["total_timeout_ms"],
                timeout
            );
        }
        merge_settings_documents(
            &mut document,
            serde_json::json!({"recovery":{"provider":{"total_timeout_ms":null}}}),
        );
        assert!(
            serde_json::to_value(validate_and_resolve_settings_document(&document).unwrap())
                .unwrap()["recovery"]["provider"]["total_timeout_ms"]
                .is_null()
        );
        for timeout in [
            serde_json::json!(0),
            serde_json::json!(86_400_001),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("10"),
        ] {
            assert!(
                serde_json::from_value::<Settings>(
                    serde_json::json!({"recovery":{"provider":{"total_timeout_ms":timeout}}})
                )
                .is_err()
            );
            let error = validate_and_resolve_settings_document(
                &serde_json::json!({"recovery":{"provider":{"total_timeout_ms":timeout}}}),
            )
            .unwrap_err();
            assert!(format!("{error:#}").contains("schema"), "{error:#}");
        }
    }

    #[test]
    fn recovery_total_timeout_file_layers_and_startup_rejection() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write(
            &config.join("settings.json"),
            r#"{"recovery":{"provider":{"total_timeout_ms":1000}}}"#,
        );
        write(
            &project.join(".kcoder/settings.json"),
            r#"{"recovery":{"provider":{"total_timeout_ms":2000}}}"#,
        );
        write(
            &project.join(".kcoder/settings.local.json"),
            r#"{"recovery":{"provider":{"total_timeout_ms":3000}}}"#,
        );
        let overlay = temp.path().join("overlay.jsonc");
        write(
            &overlay,
            r#"{"recovery":{"provider":{"total_timeout_ms":null}}}"#,
        );
        let loader = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_executable_dir(temp.path().join("exe"));
        let loaded = loader.load().unwrap();
        assert_eq!(
            loaded.settings.recovery.provider.total_timeout_ms,
            Some(3000)
        );
        assert_eq!(
            loaded.field_sources["recovery.provider.total_timeout_ms"],
            ConfigScope::Local
        );
        let loader = loader.with_overlay_files([overlay.clone()]);
        assert_eq!(
            loader
                .load()
                .unwrap()
                .settings
                .recovery
                .provider
                .total_timeout_ms,
            None
        );
        write(
            &overlay,
            r#"{"recovery":{"provider":{"total_timeout_ms":0}}}"#,
        );
        assert!(format!("{:#}", loader.load().unwrap_err()).contains("total_timeout_ms"));
    }

    #[test]
    fn prepended_overlay_files_stay_below_explicit_overlays() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        fs::create_dir_all(&config).unwrap();
        write(
            &config.join("settings.json"),
            r#"{"permission_mode":"auto","model":"profile-model"}"#,
        );
        let explicit = temp.path().join("explicit.jsonc");
        write(&explicit, r#"{"model":"explicit-model"}"#);
        let template = temp.path().join("template.jsonc");
        write(
            &template,
            r#"{"model":"template-model","permission_mode":"ask"}"#,
        );

        let loader = SettingsLoader::new(temp.path())
            .with_config_dir(&config)
            .with_executable_dir(temp.path().join("exe"))
            .with_overlay_files([explicit.clone()]);
        assert_eq!(loader.load().unwrap().settings.model, "explicit-model");

        let loader = loader.with_prepended_overlay_files([template.clone()]);
        let loaded = loader.load().unwrap();
        // The explicit overlay keeps the higher precedence...
        assert_eq!(loaded.settings.model, "explicit-model");
        // ...while fields it does not set still come from the template.
        assert_eq!(loaded.settings.permission_mode, crate::PermissionMode::Ask);
        assert_eq!(loaded.overlay_sources, vec![template, explicit]);
        assert!(loaded.overlay_fields.contains("permission_mode"));
        assert!(loaded.overlay_fields.contains("model"));
    }

    #[test]
    fn credential_update_file_serializes_different_keys_and_preserves_existing_fields() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        CredentialStore::update_file(&path, |store| {
            store.set_api_key("VendorA", "fixture-preserved".into())
        })
        .unwrap();
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|index| {
                    let path = &path;
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        CredentialStore::update_file(path, |store| {
                            std::thread::sleep(std::time::Duration::from_millis(2));
                            store.set_api_key(
                                &format!("provider-{index}"),
                                format!("fixture-key-{index}"),
                            )
                        })
                        .unwrap();
                    })
                })
                .collect();
            for handle in handles {
                handle.join().unwrap();
            }
        });
        let stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored.as_object().unwrap().len(), 9);
        assert_eq!(
            stored["VendorA"],
            serde_json::json!({"type":"api", "key":"fixture-preserved"})
        );
        for index in 0..8 {
            assert_eq!(
                stored[format!("provider-{index}")],
                serde_json::json!({"type":"api", "key":format!("fixture-key-{index}")})
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn credential_update_file_error_closure_does_not_persist_partial_mutations() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.json");
        let original = b"{\n  \"VendorA\": {\"type\": \"api\", \"key\": \"fixture-original\"}\n}\n";
        fs::write(&path, original).unwrap();
        let result = CredentialStore::update_file(&path, |store| {
            store.remove_api_key("VendorA")?;
            store.set_api_key("other", "fixture-discarded".into())?;
            anyhow::bail!("fixture mutation rejected")
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        CredentialStore::update_file(&path, |store| {
            store.set_api_key("retry", "fixture-retry".into())
        })
        .unwrap();
        let reloaded = CredentialStore::load_from(&path).unwrap();
        assert!(reloaded.has_api_key("VendorA"));
        assert!(reloaded.has_api_key("retry"));
        assert!(!reloaded.has_api_key("other"));
    }
    #[test]
    fn dev_and_release_profile_paths_do_not_share_state_roots() {
        let temp = TempDir::new().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let dev =
            ConfigPaths::with_config_dir(&project, temp.path().join("home/.config/kcoder-dev"));
        let release =
            ConfigPaths::with_config_dir(&project, temp.path().join("home/.config/kcoder"));

        assert_ne!(dev.config_dir, release.config_dir);
        assert_ne!(dev.user_settings, release.user_settings);
        assert_ne!(dev.credentials, release.credentials);
        assert_ne!(
            dev.config_dir.join("memory"),
            release.config_dir.join("memory")
        );
        assert_ne!(
            dev.config_dir.join("history"),
            release.config_dir.join("history")
        );
        assert_ne!(
            dev.config_dir.join("projects"),
            release.config_dir.join("projects")
        );
    }

    #[test]
    fn credential_store_preserves_exact_provider_ids_without_aliases() {
        let mut credentials = CredentialStore::default();
        credentials
            .set_api_key("VendorA", "upper-key".to_string())
            .unwrap();
        credentials
            .set_api_key("vendora", "lower-key".to_string())
            .unwrap();
        credentials
            .set_api_key("vllm", "vllm-key".to_string())
            .unwrap();

        assert_eq!(credentials.credentials["VendorA"], "upper-key");
        assert_eq!(credentials.credentials["vendora"], "lower-key");
        assert_eq!(credentials.credentials["vllm"], "vllm-key");
        assert!(!credentials.has_api_key("local"));
    }

    #[test]
    fn credential_store_uses_root_provider_shape() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("credentials.json");
        let mut credentials = CredentialStore::default();
        credentials
            .set_api_key("kunlunmeta", "test-key".to_string())
            .unwrap();

        credentials.save_to(&path).unwrap();

        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["kunlunmeta"]["type"], "api");
        assert_eq!(value["kunlunmeta"]["key"], "test-key");
        assert!(value.get("api_keys").is_none());
        assert_eq!(CredentialStore::load_from(&path).unwrap(), credentials);
    }

    #[test]
    fn credential_store_reads_and_migrates_the_legacy_api_keys_wrapper() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("credentials.json");
        write(
            &path,
            r#"{"api_keys":{"minimax":"legacy-minimax","openai":"legacy-openai"}}"#,
        );

        let credentials = CredentialStore::load_from(&path).unwrap();
        assert_eq!(credentials.credentials["kunlunmeta"], "legacy-minimax");
        assert_eq!(credentials.credentials["openai"], "legacy-openai");

        credentials.save_to(&path).unwrap();
        let migrated: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(migrated["kunlunmeta"]["type"], "api");
        assert_eq!(migrated["kunlunmeta"]["key"], "legacy-minimax");
        assert!(migrated.get("minimax").is_none());
        assert!(migrated.get("api_keys").is_none());
    }

    #[test]
    fn credential_store_rejects_mixed_legacy_and_current_documents_without_rewriting() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("credentials.json");
        let original =
            r#"{"api_keys":{"openai":"legacy"},"minimax":{"type":"api","key":"current"}}"#;
        write(&path, original);

        let error = CredentialStore::load_from(&path).unwrap_err();
        assert!(error.to_string().contains("failed to parse credentials"));
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn profile_home_prefers_explicit_config_override() {
        let path = resolve_user_config_dir(
            Some("/tmp/explicit".into()),
            Some("/tmp/profile".into()),
            Some("kcoder-dev".into()),
            Some(PathBuf::from("/home/kcoder-test")),
        )
        .unwrap();
        assert_eq!(path, PathBuf::from("/tmp/explicit"));
    }

    #[test]
    fn profile_home_uses_kcoder_home() {
        let path = resolve_user_config_dir(
            None,
            Some("/home/kcoder-test/.config/custom-profile".into()),
            None,
            Some(PathBuf::from("/home/kcoder-test")),
        )
        .unwrap();
        assert_eq!(
            path,
            PathBuf::from("/home/kcoder-test/.config/custom-profile")
        );
    }

    #[test]
    fn dev_executable_uses_isolated_profile() {
        let path = resolve_user_config_dir(
            None,
            None,
            Some("kcoder-dev".into()),
            Some(PathBuf::from("/home/kcoder-test")),
        )
        .unwrap();
        assert_eq!(path, PathBuf::from("/home/kcoder-test/.config/kcoder-dev"));
    }

    #[test]
    fn release_executable_uses_formal_profile() {
        let path = resolve_user_config_dir(
            None,
            None,
            Some("kcoder".into()),
            Some(PathBuf::from("/home/kcoder-test")),
        )
        .unwrap();
        assert_eq!(path, PathBuf::from("/home/kcoder-test/.config/kcoder"));
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn project_gitignore_covers_local_runtime_data_only() {
        let temp = TempDir::new().unwrap();
        let path = ensure_project_gitignore(temp.path()).unwrap();
        let content = fs::read_to_string(path).unwrap();

        for rule in PROJECT_GITIGNORE_RULES {
            assert!(content.lines().any(|line| line == *rule), "missing {rule}");
        }
        assert!(!content.lines().any(|line| line == "/settings.json"));
        assert!(!content.contains("/specs/"));
        assert!(!content.contains("/plugins/"));
        assert!(!content.contains("/skills/\n"));
    }

    #[test]
    fn project_gitignore_preserves_custom_rules_and_is_idempotent() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(".kcoder/.gitignore");
        write(
            &path,
            &format!("{PROJECT_GITIGNORE_HEADER}\n/custom-local-data/\n/settings.local.json\n"),
        );

        ensure_project_gitignore(temp.path()).unwrap();
        let once = fs::read_to_string(&path).unwrap();
        ensure_project_gitignore(temp.path()).unwrap();
        let twice = fs::read_to_string(&path).unwrap();

        assert_eq!(once, twice);
        assert!(once.contains("/custom-local-data/"));
        assert_eq!(
            once.lines()
                .filter(|line| *line == "/settings.local.json")
                .count(),
            1
        );
        assert_eq!(once.matches(PROJECT_GITIGNORE_HEADER).count(), 1);
    }

    #[test]
    fn writing_local_settings_does_not_modify_root_gitignore() {
        let temp = TempDir::new().unwrap();
        let project = temp.path().join("project");
        let config = temp.path().join("config");
        fs::create_dir_all(&project).unwrap();
        write(&project.join(".gitignore"), "/target/\n");
        let paths = ConfigPaths::with_config_dir(&project, config);

        write_scope(
            &paths,
            ConfigScope::Local,
            &serde_json::json!({"model": "local-model"}),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(project.join(".gitignore")).unwrap(),
            "/target/\n"
        );
        let nested = fs::read_to_string(project.join(".kcoder/.gitignore")).unwrap();
        assert!(nested.lines().any(|line| line == "/settings.local.json"));
        assert!(nested.lines().any(|line| line == "/settings.json.lock"));
        assert!(
            nested
                .lines()
                .any(|line| line == "/settings.local.json.lock")
        );
        assert!(
            nested
                .lines()
                .any(|line| line == "/settings.local.json.*.tmp")
        );
    }

    #[test]
    fn tool_profile_obeys_user_project_local_and_explicit_layer_order() {
        use crate::ToolProfile;
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        let overlay = temp.path().join("explicit.json");
        fs::create_dir_all(&project).unwrap();
        let load = || SettingsLoader::new(&project).with_config_dir(&config).load().unwrap().settings;
        assert_eq!(load().tools.profile, ToolProfile::Full);
        write(&config.join("settings.json"), r#"{"tools":{"profile":"core"}}"#);
        assert_eq!(load().tools.profile, ToolProfile::Core);
        write(&project.join(".kcoder/settings.json"), r#"{"tools":{"profile":"nano"}}"#);
        assert_eq!(load().tools.profile, ToolProfile::Nano);
        write(&project.join(".kcoder/settings.local.json"), r#"{"tools":{"profile":"none"}}"#);
        assert_eq!(load().tools.profile, ToolProfile::None);
        write(&overlay, r#"{"tools":{"profile":"full"}}"#);
        let explicit = SettingsLoader::new(&project).with_config_dir(&config)
            .with_overlay_files([overlay]).load().unwrap();
        assert_eq!(explicit.settings.tools.profile, ToolProfile::Full);
        assert!(explicit.overlay_fields.contains("tools.profile"));
    }

    #[test]
    fn loads_user_workspace_and_local_settings_in_precedence_order() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write(
            &config.join("settings.json"),
            r#"{"model":"user","allowed_tools":["read"]}"#,
        );
        write(
            &project.join(".kcoder/settings.json"),
            r#"{"model":"project","allowed_tools":["write"]}"#,
        );
        write(
            &project.join(".kcoder/settings.local.json"),
            r#"{"model":"local","permission_mode":"auto"}"#,
        );

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap();

        assert_eq!(loaded.settings.model, "local");
        assert_eq!(
            loaded.settings.permission_mode,
            super::super::PermissionMode::Auto
        );
        assert_eq!(loaded.settings.allowed_tools, vec!["write"]);
        assert_eq!(loaded.paths.project_root, project);
        assert_eq!(loaded.loaded_sources.len(), 3);
        assert_eq!(loaded.field_sources["model"], ConfigScope::Local);
    }

    #[test]
    fn explicit_goal_limits_override_embedded_defaults() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write(
            &config.join("settings.json"),
            r#"{
                "goal_max_auto_continuations": 3,
                "goal_pro": {
                    "verifier_max_turns": 11,
                    "completion_rejection_limit": 5
                }
            }"#,
        );

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap();

        assert_eq!(loaded.settings.goal_max_auto_continuations, 3);
        assert_eq!(loaded.settings.goal_pro.verifier_max_turns, 11);
        assert_eq!(loaded.settings.goal_pro.completion_rejection_limit, 5);
        assert_eq!(
            loaded.field_sources["goal_max_auto_continuations"],
            ConfigScope::User
        );
        assert_eq!(
            loaded.field_sources["goal_pro.verifier_max_turns"],
            ConfigScope::User
        );
        assert_eq!(
            loaded.field_sources["goal_pro.completion_rejection_limit"],
            ConfigScope::User
        );
    }

    #[test]
    fn loads_executable_directory_settings_between_user_and_project_settings() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let executable_dir = temp.path().join("bin");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".kcoder")).unwrap();
        fs::create_dir_all(&executable_dir).unwrap();
        write(
            &config.join("settings.json"),
            r#"{"model":"user","permission_mode":"ask"}"#,
        );
        write(
            &executable_dir.join("settings.json"),
            r#"{"model":"executable","request_timeout_secs":11}"#,
        );
        write(
            &project.join(".kcoder/settings.json"),
            r#"{"model":"project"}"#,
        );
        write(
            &project.join(".kcoder/settings.local.json"),
            r#"{"model":"local"}"#,
        );

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_executable_dir(&executable_dir)
            .load()
            .unwrap();

        assert_eq!(loaded.settings.model, "local");
        assert_eq!(
            loaded.settings.permission_mode,
            super::super::PermissionMode::Ask
        );
        assert_eq!(loaded.settings.request_timeout_secs, Some(11));
        assert_eq!(loaded.field_sources["model"], ConfigScope::Local);
        assert_eq!(
            loaded.field_sources["request_timeout_secs"],
            ConfigScope::Executable
        );
        assert_eq!(
            loaded.loaded_sources,
            vec![
                ConfigSource {
                    scope: ConfigScope::User,
                    path: config.join("settings.json"),
                },
                ConfigSource {
                    scope: ConfigScope::Executable,
                    path: executable_dir.join("settings.json"),
                },
                ConfigSource {
                    scope: ConfigScope::Project,
                    path: project.join(".kcoder/settings.json"),
                },
                ConfigSource {
                    scope: ConfigScope::Local,
                    path: project.join(".kcoder/settings.local.json"),
                },
            ]
        );
    }

    #[test]
    fn explicitly_empty_provider_catalog_is_authoritative_in_every_file_scope() {
        for scope in ["user", "executable", "project", "local", "overlay"] {
            for bundled in [false, true] {
                let temp = TempDir::new().unwrap();
                let project = temp.path().join("project");
                fs::create_dir_all(&project).unwrap();
                let mut loader = SettingsLoader::new(&project)
                    .with_config_dir(temp.path().join("config"))
                    .with_executable_dir(temp.path().join("executable"))
                    .with_bundled_providers(bundled);
                let paths = loader.paths().unwrap();
                let path = match scope {
                    "user" => paths.user_settings,
                    "executable" => paths.executable_settings,
                    "project" => paths.project_settings,
                    "local" => paths.local_settings,
                    _ => {
                        let path = temp.path().join("overlay.json");
                        loader = loader.with_overlay_files([path.clone()]);
                        path
                    }
                };
                let source = r#"{"providers":{}}"#;
                write(&path, source);
                let loaded = loader.load().unwrap();
                assert!(
                    loaded.settings.providers.is_empty(),
                    "scope={scope}, bundled={bundled}"
                );
                assert_eq!(loaded.settings.active_provider, None);
                assert_eq!(fs::read_to_string(path).unwrap(), source);
            }
        }
    }

    #[test]
    fn empty_provider_layers_preserve_other_explicit_names_without_restoring_defaults() {
        let temp = TempDir::new().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let loader = SettingsLoader::new(&project)
            .with_config_dir(temp.path().join("config"))
            .with_executable_dir(temp.path().join("executable"))
            .with_bundled_providers(true);
        let paths = loader.paths().unwrap();
        write(&paths.user_settings, r#"{"providers":{}}"#);
        write(&paths.local_settings, r#"{"providers":{}}"#);
        write(
            &paths.project_settings,
            r#"{"providers":{"fixture":{
            "api_format":"openai_chat_completions","endpoint":"https://example.test/v1",
            "default_model":"fixture-model","context_window_tokens":32000,
            "max_output_tokens":4096,"output_headroom_tokens":4096
        }}}"#,
        );
        let loaded = loader.load().unwrap();
        assert_eq!(
            loaded
                .settings
                .providers
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["fixture"]
        );
        assert_eq!(loaded.settings.active_provider.as_deref(), Some("fixture"));
        write(
            &paths.project_settings,
            r#"{"providers":{},"active_provider":"removed"}"#,
        );
        assert!(
            loader.load().is_err(),
            "an explicit invalid selection must not be silently cleared"
        );
    }

    #[test]
    fn user_providers_are_authoritative_over_embedded_defaults() {
        // A settings file declaring providers owns the complete model list; a
        // built-in default must not restore an entry removed by the user.
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write(
            &config.join("settings.json"),
            r#"{
                "active_provider": "minimax",
                "providers": {
                    "minimax": {
                        "provider": "minimax",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://api.minimaxi.com/anthropic",
                        "model": "MiniMax-M3",
                        "context_window_tokens": 500000,
                        "output_headroom_tokens": 40960,
                        "max_output_tokens": 40960
                    }
                }
            }"#,
        );
        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap();
        assert_eq!(loaded.settings.providers.len(), 1);
        assert!(loaded.settings.providers.contains_key("kunlunmeta"));
        assert!(!loaded.settings.providers.contains_key("minimax"));
        assert!(!loaded.settings.providers.contains_key("kimi"));
        assert!(!loaded.settings.providers.contains_key("openai-chat"));

        // Files without provider declarations continue to use the single embedded kunlunmeta provider.
        let config2 = temp.path().join("config2");
        fs::create_dir_all(&config2).unwrap();
        write(&config2.join("settings.json"), r#"{"model":"anything"}"#);
        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config2)
            .load()
            .unwrap();
        assert_eq!(loaded.settings.providers.len(), 1);
        assert!(loaded.settings.providers.contains_key("kunlunmeta"));
    }

    #[test]
    fn bundled_kunlunmeta_can_be_merged_with_user_providers_for_source_launches() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write(
            &config.join("settings.json"),
            r#"{
                "providers": {
                    "kunlunmeta": {
                        "model": "user-selected-model"
                    },
                    "kunlunmeta-deepseek-v4-flash": {
                        "provider": "kunlunmeta",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://example.test/v1",
                        "model": "DeepSeek-V4-Flash",
                        "context_window_tokens": 200000,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 12000
                    }
                }
            }"#,
        );

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_bundled_providers(true)
            .load()
            .unwrap();

        assert!(loaded.settings.providers.contains_key("kunlunmeta"));
        assert!(!loaded.settings.providers.contains_key("minimax"));
        assert!(!loaded.settings.providers.contains_key("kimi"));
        assert!(
            loaded
                .settings
                .providers
                .contains_key("kunlunmeta-deepseek-v4-flash")
        );
        assert_eq!(
            loaded.settings.providers["kunlunmeta"].default_model,
            "user-selected-model"
        );
        assert_eq!(
            loaded.settings.providers.len(),
            crate::default_providers().len() + 1
        );
    }

    #[test]
    fn does_not_load_settings_from_parent_directories() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let parent = temp.path().join("parent");
        let workspace = parent.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        write(
            &parent.join(".kcoder/settings.json"),
            r#"{"model":"parent-model"}"#,
        );

        let loaded = SettingsLoader::new(&workspace)
            .with_config_dir(&config)
            .load()
            .unwrap();

        assert_eq!(loaded.paths.project_root, workspace);
        assert_eq!(
            loaded.paths.project_settings,
            loaded.paths.project_root.join(".kcoder/settings.json")
        );
        assert_ne!(loaded.settings.model, "parent-model");
        assert!(
            loaded
                .loaded_sources
                .iter()
                .all(|source| source.scope != ConfigScope::Project)
        );
    }

    #[test]
    fn obsolete_settings_are_ignored_in_every_file_scope() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        let overlay = temp.path().join("overlay.json");
        fs::create_dir_all(project.join(".kcoder")).unwrap();
        write(
            &config.join("settings.json"),
            r#"{"model":"user","max_tool_timeout_ms":600000}"#,
        );
        write(
            &project.join(".kcoder/settings.json"),
            r#"{"model":"project","max_tool_timeout_ms":600000}"#,
        );
        write(
            &project.join(".kcoder/settings.local.json"),
            r#"{"model":"local","max_tool_timeout_ms":600000}"#,
        );
        write(
            &overlay,
            r#"{"model":"overlay","max_tool_timeout_ms":600000}"#,
        );

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_overlay_files([overlay])
            .load()
            .unwrap();

        assert_eq!(loaded.settings.model, "overlay");
        assert_eq!(loaded.loaded_sources.len(), 3);
        assert_eq!(loaded.overlay_sources.len(), 1);
        assert!(!loaded.field_sources.contains_key("max_tool_timeout_ms"));
        assert!(!loaded.overlay_fields.contains("max_tool_timeout_ms"));
    }

    #[test]
    fn nested_objects_merge_without_erasing_sibling_values() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write(
            &config.join("settings.json"),
            r#"{"tui":{"alternate_screen":"never"},"tools":{"luna":{"allowed":["read"]}}}"#,
        );
        write(
            &project.join(".kcoder/settings.json"),
            r#"{"tools":{"luna":{"allowed":["grep"]}}}"#,
        );

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap();
        assert_eq!(
            loaded.settings.tui.alternate_screen,
            super::super::TuiAltScreenMode::Never
        );
        assert_eq!(loaded.settings.tools.luna.allowed, vec!["grep"]);
    }

    #[test]
    fn no_settings_files_load_the_builtin_deployment_profile() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap();

        assert!(loaded.loaded_sources.is_empty());
        assert_eq!(
            loaded.settings.active_provider.as_deref(),
            Some(crate::DEFAULT_ACTIVE_PROVIDER)
        );
        assert_eq!(loaded.settings.provider.as_deref(), Some("kunlunmeta"));
        assert_eq!(loaded.settings.model, crate::DEFAULT_MODEL);
        assert_eq!(loaded.settings.max_tokens, Some(100_000));
        assert_eq!(loaded.settings.context_output_headroom, Some(100_000));
        assert_eq!(
            loaded.settings.base_url.as_deref(),
            Some(crate::DEFAULT_KUNLUNMETA_ENDPOINT)
        );
    }

    #[test]
    fn user_and_project_settings_override_builtin_provider() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".kcoder")).unwrap();
        write(
            &config.join("settings.json"),
            r#"{"providers":{"kunlunmeta":{"default_model":"stale-user-model","max_output_tokens":1}}}"#,
        );

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap();
        assert_eq!(loaded.settings.model, "stale-user-model");
        assert_eq!(loaded.settings.max_tokens, Some(1));
        assert_eq!(loaded.field_sources["model"], ConfigScope::User);
        assert_eq!(
            loaded.field_sources["providers.kunlunmeta.default_model"],
            ConfigScope::User
        );

        write(
            &project.join(".kcoder/settings.json"),
            r#"{"providers":{"kunlunmeta":{"default_model":"project-model","max_output_tokens":222}}}"#,
        );
        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap();
        assert_eq!(loaded.settings.model, "project-model");
        assert_eq!(loaded.settings.max_tokens, Some(222));
        assert_eq!(loaded.field_sources["model"], ConfigScope::Project);
    }

    #[test]
    fn explicit_overlays_have_highest_file_precedence() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        let overlay = temp.path().join("development.json");
        fs::create_dir_all(&project).unwrap();
        write(&config.join("settings.json"), r#"{"model":"user"}"#);
        write(&overlay, r#"{"model":"development"}"#);

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_overlay_files([overlay.clone()])
            .load()
            .unwrap();

        assert_eq!(loaded.settings.model, "development");
        assert_eq!(loaded.overlay_sources, vec![overlay]);
        assert!(loaded.overlay_fields.contains("model"));
    }

    #[test]
    fn development_overlay_configures_dedicated_summary_and_moa_profiles() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        // The development overlay reuses the active runtime for summary/MoA,
        // so a user-owned profile catalog remains authoritative.
        write(
            &config.join("settings.json"),
            r#"{
                "providers": {
                    "minimax": {
                        "provider": "minimax",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://api.minimaxi.com/anthropic",
                        "model": "MiniMax-M3",
                        "context_window_tokens": 500000,
                        "output_headroom_tokens": 40960,
                        "max_output_tokens": 40960
                    },
                    "minimax-summary": {
                        "provider": "minimax",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://api.minimaxi.com/anthropic",
                        "model": "MiniMax-M2.7-highspeed",
                        "context_window_tokens": 1048576,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 20000
                    }
                }
            }"#,
        );
        let overlay = PathBuf::from(
            std::env::var_os("KCODER_WORKSPACE_ROOT")
                .expect("Cargo 应提供当前 KCoder 工作区根目录"),
        )
        .join("crates/kcoder_config/setting_dev_user.jsonc");

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_overlay_files([overlay])
            .load()
            .unwrap();

        assert_eq!(loaded.settings.summary_profile, None);
        assert_eq!(
            loaded.settings.providers["kunlunmeta"].default_model,
            "MiniMax-M3"
        );
        let preset = &loaded.settings.moa.presets["default"];
        assert_eq!(preset.reference_models[0].profile, None);
        assert_eq!(preset.reference_models[0].provider, "current");
        assert_eq!(preset.reference_models[0].model, "current");
        assert_eq!(preset.reference_models.len(), 1);
        assert_eq!(preset.aggregator.profile, None);
        assert_eq!(preset.aggregator.provider, "current");
        assert_eq!(preset.aggregator.model, "current");
    }

    #[test]
    fn goal_pro_verifier_models_reject_unknown_profile_reference() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let config = temp.path().join("config");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&config).unwrap();
        write(
            &config.join("settings.json"),
            r#"{
                "providers": {
                    "minimax": {
                        "provider": "minimax",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://api.minimaxi.com/anthropic",
                        "model": "MiniMax-M3",
                        "context_window_tokens": 500000,
                        "output_headroom_tokens": 40960,
                        "max_output_tokens": 40960
                    }
                },
                "goal_pro": {
                    "verifier_models": [
                        { "profile": "minimax" },
                        { "profile": "ghost-profile" }
                    ]
                }
            }"#,
        );

        let error = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .expect_err("unknown verifier panel profile must fail the load");
        assert!(
            format!("{error:#}")
                .contains("goal_pro.verifier_models references unknown Provider 'ghost-profile'"),
            "{error:#}"
        );
    }

    fn write_escalation_config(config: &Path, goal_pro: &str) {
        fs::create_dir_all(config).unwrap();
        let content = format!(
            r#"{{
                "active_provider": "main",
                "providers": {{
                    "main": {{
                        "provider": "main",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://main.example/anthropic",
                        "model": "main-model",
                        "context_window_tokens": 200000,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 20000
                    }},
                    "ladder-same": {{
                        "provider": "ladder-same",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://ladder.example/anthropic",
                        "model": "ladder-model",
                        "context_window_tokens": 200000,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 20000
                    }},
                    "ladder-other-format": {{
                        "provider": "ladder-other-format",
                        "api_format": "openai_responses",
                        "endpoint": "https://ladder.example/v1",
                        "model": "ladder-model",
                        "context_window_tokens": 200000,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 20000
                    }},
                    "ladder-other-window": {{
                        "provider": "ladder-other-window",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://ladder.example/anthropic",
                        "model": "ladder-model",
                        "context_window_tokens": 128000,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 20000
                    }}
                }},
                {goal_pro}
            }}"#
        );
        write(&config.join("settings.json"), &content);
    }

    fn load_escalation_error(goal_pro: &str) -> Option<String> {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let config = temp.path().join("config");
        fs::create_dir_all(&project).unwrap();
        write_escalation_config(&config, goal_pro);
        SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .err()
            .map(|error| format!("{error:#}"))
    }

    #[test]
    fn goal_pro_model_escalation_accepts_a_consistent_ladder() {
        assert!(
            load_escalation_error(
                r#""goal_pro": {
                "model_escalation": {
                    "enabled": true,
                    "threshold": 2,
                    "models": [
                        { "profile": "ladder-same" },
                        { "provider": "ladder-same", "model": "ladder-model" },
                        {}
                    ]
                }
            }"#
            )
            .is_none()
        );
    }

    #[test]
    fn goal_pro_model_escalation_rejects_an_empty_ladder_when_enabled() {
        let error = load_escalation_error(
            r#""goal_pro": { "model_escalation": { "enabled": true, "models": [] } }"#,
        )
        .expect("empty ladder must fail");
        assert!(error.contains("models is empty"), "{error}");
    }

    #[test]
    fn goal_pro_model_escalation_rejects_unknown_provider_reference() {
        let error = load_escalation_error(
            r#""goal_pro": {
                "model_escalation": {
                    "enabled": true,
                    "models": [{ "profile": "ghost" }]
                }
            }"#,
        )
        .expect("unknown reference must fail");
        assert!(error.contains("unknown Provider 'ghost'"), "{error}");
    }

    #[test]
    fn goal_pro_model_escalation_rejects_api_format_mismatch() {
        let error = load_escalation_error(
            r#""goal_pro": {
                "model_escalation": {
                    "enabled": true,
                    "models": [{ "profile": "ladder-other-format" }]
                }
            }"#,
        )
        .expect("api_format mismatch must fail");
        assert!(error.contains("api_format"), "{error}");
        assert!(error.contains("ladder-other-format"), "{error}");
    }

    #[test]
    fn goal_pro_model_escalation_rejects_context_window_mismatch() {
        let error = load_escalation_error(
            r#""goal_pro": {
                "model_escalation": {
                    "enabled": true,
                    "models": [{ "profile": "ladder-other-window" }]
                }
            }"#,
        )
        .expect("context window mismatch must fail");
        assert!(error.contains("context_window_tokens"), "{error}");
        assert!(error.contains("ladder-other-window"), "{error}");
    }

    #[test]
    fn object_runtime_overrides_survive_model_reselection_with_layered_semantics() {
        for overlay in [false, true] {
            for clear in [false, true] {
                let temp = TempDir::new().unwrap();
                let config = temp.path().join("config");
                let project = temp.path().join("project");
                fs::create_dir_all(&project).unwrap();
                write(
                    &config.join("settings.json"),
                    &serde_json::json!({
                        "active_provider": "fixture",
                        "providers": {"fixture": {
                            "api_format": "openai_chat_completions",
                            "endpoint": "http://127.0.0.1:1/v1",
                            "default_model": "fixture-model",
                            "context_window_tokens": 32000, "output_headroom_tokens": 1024,
                            "max_output_tokens": 1024,
                            "capabilities": {"tools": true},
                            "extra_body": {"temperature": 0.1}
                        }}
                    })
                    .to_string(),
                );
                let body = if clear {
                    serde_json::json!({})
                } else {
                    serde_json::json!({"temperature": 0.7})
                };
                let overrides = serde_json::json!({"provider_extra_body": body, "model_capabilities": {"tools": false}});
                let override_path = if overlay {
                    temp.path().join("overlay.json")
                } else {
                    project.join(".kcoder/settings.json")
                };
                write(&override_path, &overrides.to_string());
                let mut loader = SettingsLoader::new(&project)
                    .with_config_dir(&config)
                    .with_executable_dir(temp.path());
                if overlay {
                    loader = loader.with_overlay_files([override_path]);
                }
                let loaded = loader.load().unwrap();
                // Empty legacy root patches are no-ops, unlike explicit per-model bodies.
                let expected = if clear {
                    serde_json::json!({"temperature": 0.1})
                } else {
                    body.clone()
                };
                assert_eq!(
                    serde_json::to_value(&loaded.settings.provider_extra_body).unwrap(),
                    expected
                );
                let mut selected = loaded.settings.clone();
                selected
                    .apply_discovered_model("fixture", "fixture-model")
                    .unwrap();
                assert_eq!(selected.provider_extra_body["temperature"], 0.1);
                loaded.model_runtime_overrides.apply(&mut selected).unwrap();
                assert_eq!(
                    serde_json::to_value(&selected.provider_extra_body).unwrap(),
                    expected,
                    "explicit object override must survive selection (overlay={overlay}, clear={clear})"
                );
                assert!(!selected.model_capabilities.tools);
                if clear {
                    if overlay {
                        assert!(loaded.overlay_fields.contains("provider_extra_body"));
                    } else {
                        assert_eq!(
                            loaded.field_sources["provider_extra_body"],
                            ConfigScope::Project
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn active_provider_is_a_baseline_below_project_overrides() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let config = temp.path().join("config");
        fs::create_dir_all(project.join(".kcoder")).unwrap();
        write(
            &config.join("settings.json"),
            &serde_json::json!({
                "active_provider": "remote",
                "providers": {
                    "remote": {
                        "provider": "openai",
                        "api_format": "openai_responses",
                        "endpoint": "https://example.test/v1",
                        "model": "profile-model",
                        "context_window_tokens": 200000,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 12000,
                        "request_timeout_secs": 45,
                        "no_proxy": true,
                        "extra_body": {"temperature": 0.1}
                    }
                }
            })
            .to_string(),
        );
        write(
            &project.join(".kcoder/settings.json"),
            &serde_json::json!({
                "providers": {"remote": {"model": "project-profile-model"}},
                "model": "project-model",
                "max_tokens": 4000
            })
            .to_string(),
        );

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap();

        assert_eq!(loaded.settings.model, "project-model");
        assert_eq!(loaded.settings.max_tokens, Some(4000));
        assert_eq!(
            loaded.settings.base_url.as_deref(),
            Some("https://example.test/v1")
        );
        assert_eq!(
            loaded.settings.api_format,
            Some(crate::ApiFormat::OpenaiResponses)
        );
        assert_eq!(loaded.settings.request_timeout_secs, Some(45));
        assert!(loaded.settings.provider_no_proxy);
        assert_eq!(loaded.settings.provider_extra_body["temperature"], 0.1);
        assert_eq!(
            loaded.settings.providers["remote"].default_model,
            "project-profile-model"
        );
    }

    #[test]
    fn credentials_are_loaded_outside_settings_json() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let mut credentials = CredentialStore::default();
        credentials
            .set_api_key("kunlunmeta", "kunlunmeta-secret".to_string())
            .unwrap();
        credentials
            .set_api_key("deepseek", "deepseek-secret".to_string())
            .unwrap();
        credentials
            .save_to(&config.join("credentials.json"))
            .unwrap();
        let mut raw: Value =
            serde_json::from_str(&fs::read_to_string(config.join("credentials.json")).unwrap())
                .unwrap();
        raw["minimax"] = serde_json::json!({"type": "api", "key": "retired-secret"});
        write(
            &config.join("credentials.json"),
            &serde_json::to_string_pretty(&raw).unwrap(),
        );

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap();
        assert_eq!(
            loaded.settings.kunlunmeta_api_key.as_deref(),
            Some("kunlunmeta-secret")
        );
        assert!(loaded.settings.stored_provider_credentials.contains_key("minimax"));
        assert_eq!(
            loaded
                .settings
                .stored_provider_credentials
                .get("deepseek")
                .map(String::as_str),
            Some("deepseek-secret")
        );
        let serialized = serde_json::to_string(&loaded.settings).unwrap();
        assert!(!serialized.contains("secret-value"));
        assert!(!serialized.contains("kunlunmeta-secret"));
        assert!(!serialized.contains("deepseek-secret"));
    }

    #[test]
    fn dotted_values_support_set_get_and_remove() {
        let mut value = Value::Object(Map::new());
        set_dotted_value(
            &mut value,
            "tui.alternate_screen",
            Value::String("never".into()),
        )
        .unwrap();
        assert_eq!(
            dotted_value(&value, "tui.alternate_screen").unwrap(),
            Some(&Value::String("never".into()))
        );
        assert!(remove_dotted_value(&mut value, "tui.alternate_screen").unwrap());
        assert!(
            dotted_value(&value, "tui.alternate_screen")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn settings_file_update_preserves_jsonc_comments_and_unchanged_formatting() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let source = r#"{
  // 根级说明
  "model": "kept-model", // 行尾说明
  "goal_pro": {
    // 独立验证器轮数
    "verifier_max_turns": 16,
  },
  "permission_mode": "ask",
}
"#;
        write(&path, source);

        update_settings_file(&path, |document| {
            set_dotted_value(document, "goal_pro.verifier_max_turns", Value::from(30))
        })
        .unwrap();

        let expected = source.replacen(
            "\"verifier_max_turns\": 16",
            "\"verifier_max_turns\": 30",
            1,
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
    }

    #[test]
    fn settings_file_noop_update_is_byte_for_byte_unchanged() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let source =
            b"{\r\n  // no-op must not normalize this file\r\n  \"model\": \"kept\",\r\n}\r\n";
        fs::write(&path, source).unwrap();

        update_settings_file(&path, |_| Ok(())).unwrap();

        assert_eq!(fs::read(&path).unwrap(), source);
    }

    #[test]
    fn scope_update_preserves_jsonc_while_materializing_normalized_fields() {
        let temp = TempDir::new().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let paths = ConfigPaths::with_config_dir(&project, temp.path().join("config"));
        let path = paths.for_scope(ConfigScope::User);
        let source = "{\r\n  // 此注释必须保留\r\n  \"model\": \"kept-model\",\r\n  \"permission_mode\": \"ask\",\r\n}\r\n";
        write(path, source);

        update_scope(&paths, ConfigScope::User, |document| {
            set_dotted_value(document, "permission_mode", Value::String("auto".into()))
        })
        .unwrap();

        let updated = fs::read_to_string(path).unwrap();
        assert!(updated.contains("// 此注释必须保留\r\n"));
        assert!(updated.contains("  \"model\": \"kept-model\",\r\n"));
        assert!(updated.contains("  \"permission_mode\": \"auto\",\r\n"));
        assert!(!updated.replace("\r\n", "").contains('\n'));
        let document = read_scope(&paths, ConfigScope::User).unwrap();
        assert_eq!(document["meta"]["config_version"], CURRENT_CONFIG_VERSION);
        assert_eq!(document["permission_mode"], "auto");
    }

    #[test]
    fn duplicate_jsonc_property_change_fails_without_rewriting() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let source = r#"{
  "goal_pro": {
    "verifier_max_turns": 12,
    "verifier_max_turns": 16
  }
}
"#;
        write(&path, source);

        let error = update_settings_file(&path, |document| {
            set_dotted_value(document, "goal_pro.verifier_max_turns", Value::from(30))
        })
        .unwrap_err();

        assert!(error.to_string().contains("duplicate JSONC property"));
        assert_eq!(fs::read_to_string(&path).unwrap(), source);
    }

    #[test]
    fn concurrent_settings_updates_preserve_both_changes_and_comments() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        let source = r#"{
  // 并发更新后仍应保留
  "model": "kept-model",
}
"#;
        write(&path, source);

        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let first_path = path.clone();
        let first = std::thread::spawn(move || {
            update_settings_file(&first_path, |document| {
                entered_tx.send(()).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(100));
                set_dotted_value(document, "permission_mode", Value::String("auto".into()))
            })
            .unwrap();
        });
        entered_rx.recv().unwrap();
        let second_path = path.clone();
        let second = std::thread::spawn(move || {
            update_settings_file(&second_path, |document| {
                set_dotted_value(document, "goal_pro.verifier_max_turns", Value::from(30))
            })
            .unwrap();
        });
        first.join().unwrap();
        second.join().unwrap();

        let updated = fs::read_to_string(&path).unwrap();
        assert!(updated.contains("// 并发更新后仍应保留"));
        assert!(updated.contains("  \"model\": \"kept-model\","));
        let document = read_settings_file(&path).unwrap();
        assert_eq!(document["permission_mode"], "auto");
        assert_eq!(document["goal_pro"]["verifier_max_turns"], 30);
    }

    #[test]
    fn concurrent_scope_updates_share_one_read_modify_write_lock() {
        let temp = TempDir::new().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let paths = ConfigPaths::with_config_dir(&project, temp.path().join("config"));
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let first_paths = paths.clone();
        let first = std::thread::spawn(move || {
            update_scope(&first_paths, ConfigScope::User, |document| {
                entered_tx.send(()).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(100));
                set_dotted_value(
                    document,
                    "tui.alternate_screen",
                    Value::String("never".into()),
                )
            })
            .unwrap();
        });
        entered_rx.recv().unwrap();
        let second_paths = paths.clone();
        let second = std::thread::spawn(move || {
            update_scope(&second_paths, ConfigScope::User, |document| {
                set_dotted_value(document, "permission_mode", Value::String("ask".into()))
            })
            .unwrap();
        });
        first.join().unwrap();
        second.join().unwrap();

        let document = read_scope(&paths, ConfigScope::User).unwrap();
        assert_eq!(document["tui"]["alternate_screen"], "never");
        assert_eq!(document["permission_mode"], "ask");
    }

    #[test]
    fn create_if_missing_uses_the_scope_lock_and_publishes_atomically() {
        let temp = TempDir::new().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let paths = ConfigPaths::with_config_dir(&project, temp.path().join("config"));
        let settings_path = paths.for_scope(ConfigScope::User).to_path_buf();
        let lock = lock_settings_path(&settings_path).unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker_paths = paths.clone();
        let worker = std::thread::spawn(move || {
            let result = write_scope_if_missing(
                &worker_paths,
                ConfigScope::User,
                &serde_json::json!({"model": "created-under-lock"}),
            );
            done_tx.send(result).unwrap();
        });

        assert!(
            done_rx
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err()
        );
        assert!(!settings_path.exists());
        FileExt::unlock(&lock).unwrap();

        assert!(
            done_rx
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap()
                .unwrap()
        );
        worker.join().unwrap();
        assert_eq!(
            read_scope(&paths, ConfigScope::User).unwrap()["model"],
            "created-under-lock"
        );
    }

    #[test]
    fn rejects_unknown_setting_fields_instead_of_silently_ignoring_them() {
        let value = serde_json::json!({ "modle": "typo" });
        let error = validate_settings_document(&value).unwrap_err().to_string();
        assert!(error.contains("modle"), "{error}");
        assert!(error.contains("schema"), "{error}");
        assert!(error.contains("spelling"), "{error}");
    }

    #[test]
    fn rejects_invalid_complete_context_boundaries() {
        let value = serde_json::json!({
            "context_window_tokens": 100000,
            "context_output_headroom": 12000,
            "context_hard_input_tokens": 88000,
            "auto_compact_threshold_tokens": 90000
        });
        let error = validate_settings_document(&value).unwrap_err().to_string();
        assert!(error.contains("below the hard input limit"), "{error}");

        let value = serde_json::json!({
            "context_window_tokens": 100000,
            "context_output_headroom": 12000,
            "auto_compact_threshold_tokens": 76000,
            "prefire_threshold_tokens": 76000
        });
        let error = validate_settings_document(&value).unwrap_err().to_string();
        assert!(
            error.contains("below auto_compact_threshold_tokens"),
            "{error}"
        );

        let value = serde_json::json!({
            "context_window_tokens": 1000000,
            "context_output_headroom": 100000,
            "prefire_threshold_tokens": 700000
        });
        let error = validate_settings_document(&value).unwrap_err().to_string();
        assert!(
            error.contains("below auto_compact_threshold_tokens"),
            "{error}"
        );
    }

    #[test]
    fn rejects_auto_compact_percentages_outside_one_to_ninety_nine() {
        for percent in [0, 100] {
            let value = serde_json::json!({
                "context_compaction": {
                    "auto_threshold": {
                        "large_window_percent": percent
                    }
                }
            });
            let error = validate_settings_document(&value).unwrap_err().to_string();
            assert!(error.contains("large_window_percent"), "{error}");
        }
    }

    #[test]
    fn missing_config_version_defaults_to_v1_and_future_version_is_rejected() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write(
            &config.join("settings.json"),
            r#"{"tui":{"alternate_screen":"never"}}"#,
        );

        let loaded = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap();
        assert_eq!(loaded.settings.meta.config_version, CURRENT_CONFIG_VERSION);
        assert_eq!(
            loaded.settings.tui.alternate_screen,
            super::super::TuiAltScreenMode::Never
        );

        write(
            &config.join("settings.json"),
            r#"{"meta":{"config_version":2}}"#,
        );
        let error = SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap_err()
            .to_string();
        assert!(error.contains("future"), "{error}");
        assert!(error.contains("config_version=2"), "{error}");
    }
}

/// Atomically validate, journal, and recover a Provider settings/credential pair.
pub fn update_settings_and_credentials<F>(path: &Path, update: F) -> Result<Value>
where F: FnOnce(&mut Value, &mut CredentialStore) -> Result<()> {
    provider_transaction::update(path, update)
}

fn sync_parent(path: &Path) -> Result<()> {
    #[cfg(unix)]
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) { fs::File::open(parent)?.sync_all()?; }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod frozen_overlay_tests {
    use super::*;

    #[test]
    fn session_overlay_is_pinned_while_user_settings_reload() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("config");
        std::fs::create_dir(&home).unwrap();
        let user = home.join("settings.json");
        let overlay = temp.path().join("template.json");
        std::fs::write(&user, r#"{"max_retries":1}"#).unwrap();
        std::fs::write(&overlay, r#"{"max_tokens":128,"tools":{"disabled":["PRIVATE_OVERLAY_SENTINEL"]}}"#).unwrap();
        let live = SettingsLoader::new(temp.path()).with_config_dir(&home)
            .with_executable_dir(temp.path()).with_overlay_files([overlay.clone()]);
        let frozen = live.clone().freeze_overlays().unwrap();
        assert!(!format!("{frozen:?}").contains("PRIVATE_OVERLAY_SENTINEL"));
        std::fs::write(&user, r#"{"max_retries":2}"#).unwrap();
        std::fs::write(&overlay, r#"{"max_tokens":256}"#).unwrap();
        let loaded = frozen.load().unwrap().settings;
        assert_eq!(loaded.max_tokens, Some(128));
        assert_eq!(loaded.max_retries, 2);
        assert_eq!(live.load().unwrap().settings.max_tokens, Some(256));
        std::fs::remove_file(&overlay).unwrap();
        assert_eq!(frozen.load().unwrap().settings.max_tokens, Some(128));
        assert!(live.load().is_err());
    }
}
