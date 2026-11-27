//! Classification uses actual live grants, never display metadata or ID prefixes.
use super::*;
use kcoder_types::migration_source_bindings::MigrationSourceBindingFamily;

impl SourceRegistry {
    pub fn source_binding_family(&self, source_id: &str) -> Result<MigrationSourceBindingFamily> {
        self.verify_selected_root(None)?;
        self.source_binding_family_at(source_id, Instant::now())
    }
    fn source_binding_family_at(
        &self,
        source_id: &str,
        now: Instant,
    ) -> Result<MigrationSourceBindingFamily> {
        let configuration = self
            .grants
            .get(source_id)
            .is_some_and(|grant| now.duration_since(grant.created) < GRANT_LIFETIME);
        let assets = self
            .asset_grants
            .get(source_id)
            .is_some_and(|grant| now.duration_since(grant.created) < GRANT_LIFETIME);
        match (configuration, assets) {
            (true, false) => Ok(MigrationSourceBindingFamily::Configuration),
            (false, true) => Ok(MigrationSourceBindingFamily::Assets),
            (false, false) => anyhow::bail!("migration_source_selection_expired"),
            (true, true) => anyhow::bail!("migration_source_binding_ambiguous"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hook_only_configuration_is_not_misclassified_as_assets_and_expiry_does_not_refresh() {
        let root = tempfile::tempdir().unwrap();
        let user = root.path().join(".claude");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(
            user.join("settings.json"),
            r#"{"hooks":{"SessionStart":[]}}"#,
        )
        .unwrap();
        std::fs::write(user.join("CLAUDE.md"), "Only static instructions.\n").unwrap();
        let mut registry = SourceRegistry::new(DiscoveryRoots {
            home: root.path().to_owned(),
            claude_config_dir: Some(user),
            codex_home: None,
            project: None,
        });
        let (found, _) = registry.discover(&[MigrationSourceKind::ClaudeCode], false);
        let config = found.iter().find(|row| row.scope == "user").unwrap();
        let asset = found
            .iter()
            .find(|row| row.scope == "user-instructions")
            .unwrap();
        assert_eq!(
            registry.source_binding_family(&config.source_id).unwrap(),
            MigrationSourceBindingFamily::Configuration
        );
        assert_eq!(
            registry.source_binding_family(&asset.source_id).unwrap(),
            MigrationSourceBindingFamily::Assets
        );
        let after = Instant::now() + GRANT_LIFETIME;
        for id in [&config.source_id, &asset.source_id, &"invented".to_owned()] {
            assert_eq!(
                registry
                    .source_binding_family_at(id, after)
                    .unwrap_err()
                    .to_string(),
                "migration_source_selection_expired"
            );
        }
        assert_eq!(
            registry.source_binding_family(&config.source_id).unwrap(),
            MigrationSourceBindingFamily::Configuration
        );
    }
}
