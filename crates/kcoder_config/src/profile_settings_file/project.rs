//! Project configuration is validated in the real layered runtime, never as a user profile.
use super::*;
use crate::{ConfigScope, LoadedSettings, SettingsLoader};
use std::path::Path;

impl ProfileSettingsFile {
    pub fn validate_project_change(
        &self,
        profile: &Path,
        cwd: &Path,
        before: &Value,
        next: &Value,
    ) -> Result<()> {
        let loader = SettingsLoader::new(cwd).with_config_dir(profile);
        let (loaded, _user_guard) = loader.load_with_profile_guard()?;
        self.check_project_layout(&loaded)?;
        validate(&loader, &loaded, before, next)
    }

    /// Hold the existing user snapshot before the project writer. No user values
    /// are copied into the project document or returned by the publication.
    pub fn update_project(
        &self,
        profile: &Path,
        cwd: &Path,
        update: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<Value> {
        self.update_project_with_catalog(profile, cwd, None, update)
    }

    /// A planned implicit catalog is checked under the same coordinator as its
    /// publication, so a concurrent explicit user catalog cannot be overwritten.
    pub fn update_project_with_catalog(
        &self,
        profile: &Path,
        cwd: &Path,
        expected_catalog: Option<&Value>,
        update: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<Value> {
        self.update_project_with_catalogs(profile, cwd, expected_catalog, None, update)
    }

    /// Both catalog assertions share the original user snapshot and project writer.
    pub fn update_project_with_catalogs(
        &self,
        profile: &Path,
        cwd: &Path,
        expected_catalog: Option<&Value>,
        expected_mcp: Option<&crate::ProjectMcpCatalogSelection>,
        update: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<Value> {
        let loader = SettingsLoader::new(cwd).with_config_dir(profile);
        let (loaded, _user_guard) = loader.load_with_profile_guard()?;
        self.check_project_layout(&loaded)?;
        self.update_validated(update, |before, next| {
            if before.get("providers").is_none()
                && next.get("providers").is_some()
                && let Some(expected) = expected_catalog
            {
                ensure!(
                    !loaded
                        .field_sources
                        .keys()
                        .any(|field| field == "providers" || field.starts_with("providers."))
                        && serde_json::to_value(&loaded.settings.providers)? == *expected,
                    "migration_target_changed"
                );
            }
            if before.get("mcp_servers").is_none()
                && next.get("mcp_servers").is_some()
                && let Some(expected) = expected_mcp
            {
                expected.verify(&crate::ProjectMcpCatalog::from_settings(&loaded.settings)?)?;
                ensure!(
                    next.get(crate::PROJECT_MCP_INHERITED_SERVERS)
                        == Some(&serde_json::to_value(&expected.names)?),
                    "migration_plan_changed"
                );
            }
            validate(&loader, &loaded, before, next)
        })
    }

    fn check_project_layout(&self, loaded: &LoadedSettings) -> Result<()> {
        let expected = loaded
            .paths
            .project_settings
            .parent()
            .ok_or_else(|| anyhow::anyhow!("migration_wrong_target"))?;
        let directory = PrivateDirectory::open_existing(expected)?;
        directory.verify_trusted_config_directory()?;
        ensure!(
            directory.directory_identity()? == self.directory_identity()?,
            "migration_wrong_target"
        );
        ensure!(
            loaded.paths.user_settings != loaded.paths.project_settings,
            "migration_wrong_target"
        );
        Ok(())
    }
}

fn validate(
    loader: &SettingsLoader,
    loaded: &LoadedSettings,
    before: &Value,
    next: &Value,
) -> Result<()> {
    let allowed = [
        "providers",
        "mcp_servers",
        "mcp_disabled_servers",
        crate::PROJECT_MCP_INHERITED_SERVERS,
    ];
    let a = before
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    let b = next
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    ensure!(
        a.keys()
            .chain(b.keys())
            .all(|key| allowed.contains(&key.as_str()) || a.get(key) == b.get(key)),
        "migration_project_settings_field_unsupported"
    );
    let changes = allowed
        .into_iter()
        .filter(|key| before.get(*key) != next.get(*key))
        .collect::<Vec<_>>();
    let covered = |field: &str| {
        // Other scopes accept only a null/no-op inheritance directive. It cannot
        // control the project; actual local/overlay MCP arrays still do.
        if field == crate::PROJECT_MCP_INHERITED_SERVERS {
            return false;
        }
        changes
            .iter()
            .any(|key| field == *key || field.starts_with(&format!("{key}.")))
    };
    ensure!(
        !loaded.overlay_fields.iter().any(|field| covered(field))
            && !loaded
                .field_sources
                .iter()
                .any(|(field, scope)| covered(field) && *scope == ConfigScope::Local),
        "migration_target_controlled_by_overlay"
    );

    // This is a private validation projection. Only the original project delta
    // reaches disk; inherited values and credential state never do.
    let mut effective = serde_json::to_value(&loaded.settings)?;
    if changes.contains(&"providers") {
        let old = before.get("providers").and_then(Value::as_object);
        let new = next.get("providers").and_then(Value::as_object);
        ensure!(
            next.get("providers").is_none() || new.is_some(),
            "migration_invalid_target_configuration"
        );
        let declared = loaded
            .field_sources
            .keys()
            .any(|field| field == "providers" || field.starts_with("providers."));
        if !declared && new.is_some() {
            ensure!(
                loaded.settings.providers.iter().all(|(name, provider)| {
                    new.and_then(|values| values.get(name))
                        == serde_json::to_value(provider).ok().as_ref()
                }),
                "migration_project_catalog_preservation_required"
            );
        }
        if let Some(new) = new {
            for (name, value) in new {
                if !old.is_some_and(|old| old.contains_key(name))
                    && let Some(inherited) = loaded.settings.providers.get(name)
                {
                    ensure!(
                        serde_json::to_value(inherited)? == *value,
                        "migration_target_conflict"
                    );
                }
            }
        }
        // Evaluate the proposed file at its real layer. Removing the first
        // explicit catalog restores inheritance; it must not simulate an empty map.
        let candidate = loader
            .clone()
            .with_project_document(next)
            .load_under_profile_guard()
            .map_err(|_| anyhow::anyhow!("migration_invalid_target_configuration"))?;
        ensure!(
            selection_preserved(loaded, &candidate.settings),
            "migration_default_selection_changed"
        );
        effective["providers"] = serde_json::to_value(&candidate.settings.providers)?;
        effective["active_provider"] = serde_json::to_value(&candidate.settings.active_provider)?;
    }
    if changes.contains(&"mcp_servers") {
        ensure!(
            before.get("mcp_servers").is_some()
                || loaded.settings.mcp_servers.is_empty()
                || next.get("mcp_servers").is_none()
                || next
                    .get(crate::PROJECT_MCP_INHERITED_SERVERS)
                    .is_some_and(Value::is_array),
            "migration_project_mcp_catalog_preservation_required"
        );
        if let Some(servers) = next.get("mcp_servers").and_then(Value::as_array) {
            let old = before.get("mcp_servers").and_then(Value::as_array);
            let disabled = next.get("mcp_disabled_servers").and_then(Value::as_array);
            for server in servers {
                let Some(name) = server.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let added = !old.is_some_and(|rows| {
                    rows.iter()
                        .any(|row| row.get("name").and_then(Value::as_str) == Some(name))
                });
                ensure!(
                    !added
                        || !loaded
                            .settings
                            .mcp_disabled_servers
                            .iter()
                            .any(|value| value == name)
                        || disabled
                            .is_some_and(|rows| rows.iter().any(|row| row.as_str() == Some(name))),
                    "migration_project_mcp_activation_denied"
                );
            }
        }
    }
    if changes.iter().any(|field| {
        matches!(*field, "mcp_servers" | "mcp_disabled_servers")
            || *field == crate::PROJECT_MCP_INHERITED_SERVERS
    }) {
        let candidate = loader
            .clone()
            .with_project_document(next)
            .load_under_profile_guard()
            .map_err(|_| anyhow::anyhow!("migration_invalid_target_configuration"))?;
        effective["mcp_servers"] = serde_json::to_value(&candidate.settings.mcp_servers)?;
        effective["mcp_disabled_servers"] =
            serde_json::to_value(&candidate.settings.mcp_disabled_servers)?;
    }
    let resolved = validate_and_resolve_settings_document(&effective)
        .map_err(|_| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    ensure!(
        selection_preserved(loaded, &resolved),
        "migration_default_selection_changed"
    );
    Ok(())
}

/// A migration never replaces an existing default selection. Fresh
/// installations ship no Provider and select none, so the only allowed changes
/// are: from no selection to a Provider that no loaded layer provided (the
/// first import), and the exact reverse when that Provider is removed again
/// (undo) while the selection is still implicit. An explicitly chosen
/// selection never moves.
fn selection_preserved(loaded: &LoadedSettings, candidate: &crate::Settings) -> bool {
    let before = loaded.settings.active_provider.as_deref();
    let after = candidate.active_provider.as_deref();
    if before == after && loaded.settings.model == candidate.model {
        return true;
    }
    match (before, after) {
        (None, Some(added)) => !loaded.settings.providers.contains_key(added),
        (Some(removed), None) => {
            !loaded.field_sources.contains_key("active_provider")
                && !candidate.providers.contains_key(removed)
        }
        _ => false,
    }
}
