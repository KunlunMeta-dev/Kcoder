//! Source project authority is separate from both product roots and destination workspaces.
use super::*;
use crate::selected_source_root::SelectedProjectRoot;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginSourceProject {
    binding: SelectedProjectRoot,
    kind: MigrationSourceKind,
    metadata: Vec<(String, Option<String>)>,
}
fn project_read(root: &PrivateDirectory, path: &str) -> Result<Option<Vec<u8>>> {
    match read(root, path) {
        Err(error) if missing(&error) => Ok(None),
        result => result,
    }
}
impl PluginSourceProject {
    pub fn capture(
        profile: &Path,
        authorized_project: &Path,
        kind: MigrationSourceKind,
    ) -> Result<Self> {
        let binding = SelectedProjectRoot::capture(profile, authorized_project)?;
        let root = PrivateDirectory::open_existing(binding.root())?;
        let paths: &[&str] = match kind {
            MigrationSourceKind::ClaudeCode => {
                &[".claude/settings.json", ".claude/settings.local.json"]
            }
            MigrationSourceKind::Codex => &[".codex/config.toml"],
        };
        let metadata = paths
            .iter()
            .map(|path| {
                Ok((
                    (*path).to_owned(),
                    project_read(&root, path)?.as_deref().map(hash),
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        let value = Self {
            binding,
            kind,
            metadata,
        };
        value.verify()?;
        Ok(value)
    }
    pub(crate) fn kind(&self) -> MigrationSourceKind {
        self.kind
    }
    pub(crate) fn verify(&self) -> Result<()> {
        self.binding.verify()?;
        let root = PrivateDirectory::open_existing(self.binding.root())?;
        for (path, expected) in &self.metadata {
            ensure!(
                project_read(&root, path)?.as_deref().map(hash).as_ref() == expected.as_ref(),
                "plugin_migration_source_changed"
            );
        }
        self.binding.verify()
    }
    pub(crate) fn identity(&self) -> String {
        self.binding.identity()
    }
    pub(crate) fn revision(&self) -> Result<String> {
        sha(self)
    }
    pub(super) fn matches(&self, declared: &Path) -> bool {
        if !declared.is_absolute()
            || declared
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        {
            return false;
        }
        let result = || -> Result<bool> {
            self.verify()?;
            let expected = PrivateDirectory::open_existing(self.binding.root())?;
            let actual = PrivateDirectory::open_existing(declared)?;
            actual.verify_trusted_config_directory()?;
            Ok(actual.directory_identity()? == expected.directory_identity()?)
        };
        result().unwrap_or(false)
    }
    pub(super) fn enabled(&self, scope: &str, id: &str) -> Result<Option<bool>> {
        self.verify()?;
        let root = PrivateDirectory::open_existing(self.binding.root())?;
        let mut value = None;
        for path in if scope == "local" {
            &[".claude/settings.json", ".claude/settings.local.json"][..]
        } else {
            &[".claude/settings.json"][..]
        } {
            if let Some(bytes) = project_read(&root, path)? {
                let document = json(&bytes)?;
                if let Some(next) = document
                    .get("enabledPlugins")
                    .and_then(|plugins| plugins.get(id))
                    .and_then(Value::as_bool)
                {
                    value = Some(next);
                }
            }
        }
        self.verify()?;
        Ok(value)
    }
    pub(super) fn codex_candidates(
        &self,
        root: &PrivateDirectory,
        canonical: &Path,
    ) -> Result<Vec<PluginMigrationCandidate>> {
        self.verify()?;
        ensure!(
            self.kind == MigrationSourceKind::Codex,
            "plugin_migration_source_changed"
        );
        let project = PrivateDirectory::open_existing(self.binding.root())?;
        let Some(bytes) = project_read(&project, ".codex/config.toml")? else {
            return Ok(vec![]);
        };
        let document: toml::Value = std::str::from_utf8(&bytes)
            .ok()
            .and_then(|text| toml::from_str(text).ok())
            .context("plugin_migration_invalid_index")?;
        let secret_document = serde_json::to_value(&document)?;
        let secrets = crate::adapters::secret_values(&secret_document);
        let native_identity = root.directory_identity()?;
        let mut candidates = Vec::new();
        if let Some(plugins) = document.get("plugins").and_then(toml::Value::as_table) {
            ensure!(
                plugins.len() <= 256,
                "plugin_migration_index_budget_exceeded"
            );
            for (source_id, entry) in plugins {
                let Ok(id) = source_id.parse::<PluginId>() else {
                    continue;
                };
                if safe(source_id, &secrets).is_none() {
                    continue;
                }
                let mut pending = vec!["plugin_project_mapping_required".into()];
                if !entry.as_table().is_some_and(|table| {
                    table.keys().all(|key| key == "enabled")
                        && table.get("enabled").is_none_or(toml::Value::is_bool)
                }) {
                    pending.push("plugin_install_policy_pending".into());
                }
                let base = PathBuf::from("plugins/cache")
                    .join(id.marketplace_name())
                    .join(id.plugin_name());
                let found = versions(root, &base).unwrap_or_default();
                let version = active(&found).filter(|value| safe(value, &secrets).is_some());
                if version.is_none() {
                    pending.push("plugin_install_payload_missing_or_unsafe".into());
                }
                let metadata = read(root, "config.toml")?.as_deref().map(hash);
                let binding = version.as_ref().map(|version| Source {
                    root: canonical.to_owned(),
                    identity: native_identity.clone(),
                    kind: self.kind,
                    source_id: source_id.clone(),
                    version: version.clone(),
                    relative: base.join(version),
                    metadata: vec![("config.toml".into(), metadata)],
                    cache_listing: sha(&found).ok(),
                    source_scope: "project".into(),
                    project: Some(Box::new(self.clone())),
                    received: None,
                    uploaded: None,
                });
                candidates.push(PluginMigrationCandidate {
                    id: sha(&(self.revision()?, source_id, &version))?,
                    source: self.kind,
                    name: safe(id.plugin_name(), &secrets).unwrap_or_else(|| "plugin".into()),
                    installed_version: version,
                    scope: "project".into(),
                    source_enabled: entry
                        .get("enabled")
                        .map(toml::Value::as_bool)
                        .unwrap_or(Some(true)),
                    pending,
                    binding,
                });
            }
        }
        self.verify()?;
        Ok(candidates)
    }
}
