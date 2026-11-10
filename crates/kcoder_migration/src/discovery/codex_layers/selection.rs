//! Only an existing user grant may derive a new static hierarchy grant.
use super::*;
pub struct SelectedCodexLayers {
    pub source: DiscoveredConfiguration,
    pub replaces_source_ids: Vec<String>,
}
impl SourceRegistry {
    pub fn select_codex_layers(
        &mut self,
        source_id: &str,
        trusted_root: &Path,
        cwd: &Path,
    ) -> Result<SelectedCodexLayers> {
        let selected = self.selected(source_id)?;
        ensure!(
            selected.kind == MigrationSourceKind::Codex
                && selected.scope == "user"
                && !selected.has_configuration_layers(),
            "migration_codex_user_source_required"
        );
        selected.read()?;
        let profile = selected.codex_profile.as_ref().map(|_| selected.clone());
        let binding =
            ConfigurationBinding::capture_codex_layers(&selected.root, trusted_root, cwd, profile)?;
        selected.read()?;
        let replaces_source_ids = self
            .grants
            .iter()
            .filter(|(_, grant)| {
                grant.binding.kind == MigrationSourceKind::Codex
                    && matches!(grant.scope, "user" | "project" | "codex-project-layers")
            })
            .map(|(id, _)| id.clone())
            .collect();
        let label = selected
            .profile_label()
            .unwrap_or_else(|| "user configuration".into());
        let mut sources = Vec::new();
        self.grant_configuration(
            binding,
            "codex-project-layers",
            Instant::now(),
            &mut sources,
        )?;
        let mut source = sources.remove(0);
        source.display_name = format!("Codex · {label} · selected project layers");
        Ok(SelectedCodexLayers {
            source,
            replaces_source_ids,
        })
    }
}
