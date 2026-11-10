//! Explicit trusted static hierarchy; project authentication/routing never becomes user authority.
use super::*;
use crate::configuration_layers::{ConfigurationLayerScope, storage::Layer};
use zeroize::{Zeroize, Zeroizing};
mod merge;
mod report;
mod selection;
pub use selection::SelectedCodexLayers;
mod routing;
#[cfg(test)]
mod tests;
pub const CODEX_LAYERS_REVISION: &str = "codex-selected-layers/v1";
const MAX_LAYERS: usize = 64;
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexLayersBinding {
    version: u32,
    trusted_root: PathBuf,
    trusted_identity: String,
    cwd: PathBuf,
    user: Layer,
    profile: Option<Box<ConfigurationBinding>>,
    projects: Vec<Layer>,
    routing: Vec<routing::Marker>,
    marker_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    snapshot_report: Option<CodexLayerReport>,
}
impl std::fmt::Debug for CodexLayersBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexLayersBinding")
            .field("projectLayers", &self.projects.len())
            .finish_non_exhaustive()
    }
}
pub use kcoder_types::codex_configuration_layers::{CodexFieldOrigin, CodexLayerReport};
struct Resolved {
    document: SourceDocument,
    report: CodexLayerReport,
}
impl CodexLayersBinding {
    pub(super) fn user_directory(&self) -> Result<PathBuf> {
        ensure!(
            self.user.scope() == ConfigurationLayerScope::User && self.user.name() == "config.toml",
            "migration_invalid_source_binding"
        );
        Ok(self.user.directory_path())
    }
    pub(super) fn verify_host_trust(&self, profile: &Path) -> Result<()> {
        use kcoder_config::{FolderTrust, FolderTrustStore};
        self.validate()?;
        let trust = FolderTrustStore::load(profile);
        let mut directory = self.cwd.as_path();
        for _ in 0..=MAX_LAYERS {
            ensure!(
                trust.check(directory) == FolderTrust::Trusted,
                "migration_codex_project_untrusted"
            );
            if directory == self.trusted_root {
                return Ok(());
            }
            directory = directory
                .parent()
                .ok_or_else(|| anyhow::anyhow!("migration_invalid_source_binding"))?;
        }
        anyhow::bail!("migration_invalid_source_binding")
    }
    /// The Native caller explicitly authorizes a trusted ancestor and cwd; no RPC path is accepted.
    pub fn capture(
        user: &Path,
        trusted_root: &Path,
        cwd: &Path,
        profile: Option<ConfigurationBinding>,
    ) -> Result<Self> {
        let (trusted_root, trusted_identity) = routing::directory(trusted_root)?;
        let (cwd, cwd_identity) = routing::directory(cwd)?;
        ensure!(
            cwd.starts_with(&trusted_root),
            "migration_codex_project_outside_selection"
        );
        let user = Layer::capture(user, "config.toml", ConfigurationLayerScope::User)?;
        if let Some(profile) = &profile {
            ensure!(
                profile.kind == MigrationSourceKind::Codex
                    && profile.scope == "user"
                    && !profile.has_configuration_layers()
                    && profile.codex_profile.is_some()
                    && profile.root == user.directory_path(),
                "migration_invalid_source_binding"
            );
            profile.read()?;
        }
        routing::check_source_trust(user.read()?.as_ref(), &cwd)?;
        let document = profile
            .as_ref()
            .map(ConfigurationBinding::read)
            .transpose()?
            .or(user.read()?);
        let marker_names = routing::names(document.as_ref())?;
        let (routing, directories) = routing::capture(&trusted_root, &cwd, &marker_names)?;
        routing::check_cwd(&routing, &cwd, &cwd_identity)?;
        let mut captured_bytes = user.read()?.as_ref().map_or(0, |value| value.text().len());
        if let Some(profile) = &profile {
            captured_bytes += profile_delta(profile)?.text().len();
        }
        ensure!(
            captured_bytes <= MAX_BYTES,
            "migration_source_budget_exceeded"
        );
        let mut projects = Vec::new();
        for path in &directories {
            let layer = Layer::capture(
                &path.join(".codex"),
                "config.toml",
                ConfigurationLayerScope::Project,
            )?;
            captured_bytes += layer.read()?.as_ref().map_or(0, |value| value.text().len());
            ensure!(
                captured_bytes <= MAX_BYTES,
                "migration_source_budget_exceeded"
            );
            projects.push(layer);
        }
        let mut value = Self {
            version: 1,
            trusted_root,
            trusted_identity,
            cwd,
            user,
            profile: profile.map(Box::new),
            projects,
            routing,
            marker_names,
            snapshot_report: None,
        };
        value.snapshot_report = Some(value.resolve()?.report);
        Ok(value)
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1
                && self.projects.len() <= MAX_LAYERS
                && self.user.scope() == ConfigurationLayerScope::User
                && self.user.name() == "config.toml",
            "migration_invalid_source_binding"
        );
        let (root, identity) = routing::directory(&self.trusted_root)?;
        ensure!(
            root == self.trusted_root
                && identity == self.trusted_identity
                && self.cwd.starts_with(root),
            "migration_source_changed"
        );
        let directories = routing::validate(
            &self.trusted_root,
            &self.cwd,
            &self.marker_names,
            &self.routing,
        )?;
        ensure!(
            directories.len() == self.projects.len(),
            "migration_invalid_source_binding"
        );
        for (directory, layer) in directories.iter().zip(&self.projects) {
            ensure!(
                layer.name() == "config.toml"
                    && layer.scope() == ConfigurationLayerScope::Project
                    && layer.directory_path() == directory.join(".codex"),
                "migration_invalid_source_binding"
            );
        }
        if let Some(profile) = &self.profile {
            ensure!(
                profile.kind == MigrationSourceKind::Codex
                    && profile.scope == "user"
                    && !profile.has_configuration_layers()
                    && profile.codex_profile.is_some()
                    && profile.root == self.user.directory_path(),
                "migration_invalid_source_binding"
            );
        }
        Ok(())
    }
    fn documents(&self) -> Result<Vec<Option<SourceDocument>>> {
        self.validate()?;
        let base = self.user.read()?;
        routing::check_source_trust(base.as_ref(), &self.cwd)?;
        let routing_source = self
            .profile
            .as_ref()
            .map(|profile| profile.read())
            .transpose()?;
        ensure!(
            routing::names(routing_source.as_ref().or(base.as_ref()))? == self.marker_names,
            "migration_invalid_source_binding"
        );
        drop(routing_source);
        let mut values = Vec::new();
        let mut total = 0;
        push_document(&mut values, &mut total, base)?;
        if let Some(profile) = &self.profile {
            push_document(&mut values, &mut total, Some(profile_delta(profile)?))?;
        }
        for layer in &self.projects {
            push_document(&mut values, &mut total, layer.read()?)?;
        }
        Ok(values)
    }
    fn resolve(&self) -> Result<Resolved> {
        let documents = self.documents()?;
        let value = merge::resolve(&documents, usize::from(self.profile.is_some()) + 1)?;
        self.documents()?;
        Ok(value)
    }
    pub fn report(&self) -> Result<CodexLayerReport> {
        Ok(self.resolve()?.report)
    }
    pub(crate) fn read(&self) -> Result<SourceDocument> {
        Ok(self.resolve()?.document)
    }
    pub(crate) fn inventory(&self) -> Result<MigrationInventory> {
        let resolved = self.resolve()?;
        let mut inventory = crate::adapters::parse_codex_config_with_redactions(
            resolved.document.text(),
            &resolved.document.private_values(),
        )?;
        inventory.adapter_revision = CODEX_LAYERS_REVISION.into();
        codex_profiles::append_template(
            &mut inventory,
            &resolved.document,
            "Codex selected project layers".into(),
        )?;
        merge::annotate(&mut inventory, &resolved.report);
        Ok(inventory)
    }
    pub(crate) fn revision(&self) -> Result<String> {
        use sha2::{Digest, Sha256};
        Ok(format!(
            "codex-layers-{:x}",
            Sha256::digest(
                serde_json::to_vec(self)
                    .map_err(|_| anyhow::anyhow!("migration_invalid_source_binding"))?
            )
        ))
    }
    pub(crate) fn logical_identity(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut digest = Sha256::new();
        digest.update(CODEX_LAYERS_REVISION);
        self.user.hash_logical(&mut digest);
        for value in [
            self.trusted_root.as_os_str().as_encoded_bytes(),
            self.trusted_identity.as_bytes(),
            self.cwd.as_os_str().as_encoded_bytes(),
        ] {
            digest.update((value.len() as u64).to_le_bytes());
            digest.update(value);
        }
        digest.update([u8::from(self.profile.is_some())]);
        if let Some(profile) = &self.profile {
            digest.update(profile.logical_identity());
        }
        format!("{:x}", digest.finalize())
    }
    pub(crate) fn primary_path(&self) -> Result<PathBuf> {
        self.projects
            .iter()
            .rev()
            .chain(std::iter::once(&self.user))
            .find(|layer| layer.present())
            .map(Layer::path)
            .or_else(|| {
                self.profile
                    .as_ref()
                    .map(|profile| profile.root.join(&profile.name))
            })
            .ok_or_else(|| anyhow::anyhow!("migration_source_unavailable"))
    }
    pub(crate) fn project_root(&self) -> Option<PathBuf> {
        self.projects
            .first()?
            .directory_path()
            .parent()
            .map(Path::to_path_buf)
    }
    pub(crate) fn refreshed(&self) -> Result<Self> {
        let (root, identity) = routing::directory(&self.trusted_root)?;
        ensure!(
            root == self.trusted_root && identity == self.trusted_identity,
            "migration_source_changed"
        );
        self.user.refreshed()?;
        for project in &self.projects {
            project.refreshed()?;
        }
        Self::capture(
            &self.user.directory_path(),
            &self.trusted_root,
            &self.cwd,
            self.profile
                .as_ref()
                .map(|value| value.refreshed())
                .transpose()?,
        )
    }
}

fn profile_delta(profile: &ConfigurationBinding) -> Result<SourceDocument> {
    profile.read()?;
    let directory = PrivateDirectory::open_existing(&profile.root)?;
    let document = SourceDocument::read_configuration_at(&directory, OsStr::new(&profile.name))?;
    let Some(codex_profiles::CodexProfileBinding::LegacyTable { name }) = &profile.codex_profile
    else {
        return Ok(document);
    };
    let mut table = merge::PrivateTable(
        toml::from_str(document.text())
            .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?,
    );
    let selected = table
        .0
        .get_mut("profiles")
        .and_then(toml::Value::as_table_mut)
        .and_then(|profiles| profiles.remove(name))
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_source_binding"))?;
    let toml::Value::Table(selected) = selected else {
        anyhow::bail!("migration_invalid_source_binding");
    };
    let selected = merge::PrivateTable(selected);
    let text = toml::to_string(&selected.0)
        .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
    SourceDocument::from_private_configuration(text, Zeroizing::new(Vec::new()))
}

fn push_document(
    values: &mut Vec<Option<SourceDocument>>,
    total: &mut usize,
    value: Option<SourceDocument>,
) -> Result<()> {
    *total += value.as_ref().map_or(0, |document| document.text().len());
    ensure!(*total <= MAX_BYTES, "migration_source_budget_exceeded");
    values.push(value);
    Ok(())
}
