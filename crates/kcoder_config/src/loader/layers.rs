//! Layers stage of configuration loading.

use super::*;

impl std::fmt::Debug for ModelRuntimeOverrides {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("ModelRuntimeOverrides")
            .field(&self.0.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl ModelRuntimeOverrides {
    pub fn apply(&self, settings: &mut Settings) -> Result<()> {
        macro_rules! apply_fields { ($($field:ident),* $(,)?) => { $(
            if let Some(value) = self.0.get(stringify!($field)) {
                settings.$field = serde_json::from_value(value.clone())?;
            }
        )* }; }
        apply_fields!(
            api_format,
            base_url,
            model_reasoning_effort,
            model_reasoning_policy,
            context_window_tokens,
            context_output_headroom,
            auto_compact_threshold_tokens,
            max_tokens,
            request_timeout_secs,
            openai_user_agent,
            max_retries,
            retry_base_delay_ms,
            provider_no_proxy,
            provider_chat_protocol
        );
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

impl std::fmt::Debug for FrozenOverlay {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("FrozenOverlay(<redacted>)")
    }
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
                self.frozen_overlays
                    .insert(path.clone(), FrozenOverlay(value));
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
        let mut model_configuration_sources =
            crate::ModelConfigurationSources::from_defaults(&merged);
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

        let model_runtime_overrides = ModelRuntimeOverrides(
            [
                "api_format",
                "base_url",
                "model_capabilities",
                "model_reasoning_effort",
                "model_reasoning_policy",
                "context_window_tokens",
                "context_output_headroom",
                "auto_compact_threshold_tokens",
                "max_tokens",
                "request_timeout_secs",
                "openai_user_agent",
                "max_retries",
                "retry_base_delay_ms",
                "provider_no_proxy",
                "provider_extra_body",
                "provider_chat_protocol",
            ]
            .into_iter()
            .filter(|field| {
                // Object-valued overrides have leaf provenance rather than a parent
                // entry. Capture the whole explicit value before profile expansion.
                field_sources
                    .keys()
                    .chain(overlay_fields.iter())
                    .any(|path| {
                        path == *field
                            || path
                                .strip_prefix(*field)
                                .is_some_and(|tail| tail.starts_with('.'))
                    })
            })
            .filter_map(|field| {
                merged
                    .get(field)
                    .cloned()
                    .map(|value| (field.to_owned(), value))
            })
            .collect(),
        );
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

pub(super) fn merge_settings_value(target: &mut Value, source: Value) {
    merge_settings_value_at(target, source, &mut Vec::new());
}

pub(super) fn merge_settings_value_at(target: &mut Value, source: Value, path: &mut Vec<String>) {
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
    let settings: Settings =
        serde_json::from_value(merged).context("failed to deserialize resolved KCoder settings")?;
    settings.validate_model_reasoning_policy()?;
    Ok(settings)
}

pub(super) fn record_leaf_sources(
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

pub(super) fn record_leaf_names(value: &Value, prefix: &str, names: &mut BTreeSet<String>) {
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
