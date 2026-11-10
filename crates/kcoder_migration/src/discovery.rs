//! Source grants are native-account scoped; clients receive opaque references, never paths.
use crate::{MigrationInventory, parse_claude_settings, source::SourceDocument};
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::migration::{MigrationCategory, MigrationSourceKind};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const GRANT_LIFETIME: Duration = Duration::from_secs(600);
const MAX_GRANTS: usize = 256;
mod assets;
pub mod codex_layers;
mod codex_profiles;
mod definitions;
pub use definitions::DefinitionSourcePage;
mod history;
mod memory;
mod plugins;
mod projects;
mod source_bindings;
pub use plugins::{DiscoveredPlugin, DiscoveredPluginPage};

#[cfg(all(test, windows))]
mod windows_tests;

pub(crate) fn codex_profile_filename(name: &str) -> bool {
    codex_profiles::file_profile(name).is_some()
}

fn product_name(kind: MigrationSourceKind) -> &'static str {
    match kind {
        MigrationSourceKind::ClaudeCode => "Claude Code",
        MigrationSourceKind::Codex => "Codex",
    }
}

/// Durable private provenance, not a renderer request or public result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurationBinding {
    root: PathBuf,
    directory_identity: String,
    name: String,
    pub kind: MigrationSourceKind,
    pub revision: String,
    #[serde(default)]
    scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    codex_profile: Option<codex_profiles::CodexProfileBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    configuration_layers: Option<Box<crate::configuration_layers::ConfigurationLayersBinding>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    codex_layers: Option<Box<codex_layers::CodexLayersBinding>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selected_root: Option<crate::selected_source_root::SelectedRootBinding>,
}

impl ConfigurationBinding {
    pub fn uploaded_source(
        &self,
    ) -> Result<Option<kcoder_types::migration_source_upload::SourceUploadProvenance>> {
        self.verify_selected_directory()?;
        Ok(self
            .selected_root
            .as_ref()
            .and_then(|root| root.uploaded())
            .map(|uploaded| uploaded.provenance()))
    }
    fn verify_selected_directory(&self) -> Result<()> {
        if let Some(root) = &self.selected_root {
            let user = if let Some(layers) = &self.codex_layers {
                layers.user_directory()?
            } else if let Some(layers) = &self.configuration_layers {
                layers.user_directory()?
            } else {
                self.root.clone()
            };
            root.verify(&user, self.kind)?;
        }
        Ok(())
    }

    fn selected_root_identity(&self, identity: String) -> String {
        use sha2::{Digest, Sha256};
        match &self.selected_root {
            Some(root) => format!(
                "{:x}",
                Sha256::digest(format!(
                    "{identity}\0selected-root:{}",
                    root.logical_identity()
                ))
            ),
            None => identity,
        }
    }
    /// Native capture provenance; a remote client cannot replace it with a scope label.
    pub fn source_scope(&self) -> &str {
        &self.scope
    }

    /// A direct CLI file selection grants only its configuration and same-directory profile base.
    pub fn capture_selected(path: &Path, kind: MigrationSourceKind) -> Result<Self> {
        Self::capture(path, kind, "user")
    }

    /// The caller explicitly authorizes both user and project settings locations.
    pub fn capture_claude_layers(user: &Path, project: &Path) -> Result<Option<Self>> {
        let Some(layers) = crate::configuration_layers::ConfigurationLayersBinding::capture_claude(
            user,
            Some(project),
        )?
        else {
            return Ok(None);
        };
        Self::from_layers(layers).map(Some)
    }
    fn from_layers(
        layers: crate::configuration_layers::ConfigurationLayersBinding,
    ) -> Result<Self> {
        let mut binding = Self::capture(
            &layers.primary_path()?,
            MigrationSourceKind::ClaudeCode,
            "project-effective",
        )?;
        binding.revision = layers.revision()?;
        binding.configuration_layers = Some(Box::new(layers));
        binding.read()?;
        Ok(binding)
    }
    /// All paths are explicit Native selections; project hierarchy does not grant source execution.
    pub fn capture_codex_layers(
        user: &Path,
        trusted_root: &Path,
        cwd: &Path,
        profile: Option<ConfigurationBinding>,
    ) -> Result<Self> {
        Self::from_codex_layers(codex_layers::CodexLayersBinding::capture(
            user,
            trusted_root,
            cwd,
            profile,
        )?)
    }
    fn from_codex_layers(layers: codex_layers::CodexLayersBinding) -> Result<Self> {
        let mut binding = Self::capture(
            &layers.primary_path()?,
            MigrationSourceKind::Codex,
            "codex-project-layers",
        )?;
        binding.revision = layers.revision()?;
        binding.codex_layers = Some(Box::new(layers));
        binding.read()?;
        Ok(binding)
    }
    pub fn codex_layer_report(&self) -> Result<Option<codex_layers::CodexLayerReport>> {
        self.verify_selected_directory()?;
        self.codex_layers
            .as_ref()
            .map(|value| value.report())
            .transpose()
    }
    /// Live Host operations must retain the original target's project trust authority.
    pub fn verify_codex_layer_authority(&self, profile: &Path) -> Result<()> {
        self.verify_selected_directory()?;
        if let Some(layers) = &self.codex_layers {
            layers.verify_host_trust(profile)?;
        }
        Ok(())
    }
    pub fn codex_layer_snapshot_report(&self) -> Result<Option<codex_layers::CodexLayerReport>> {
        self.codex_layers
            .as_ref()
            .map(|value| {
                ensure!(
                    self.kind == MigrationSourceKind::Codex
                        && self.scope == "codex-project-layers"
                        && self.configuration_layers.is_none()
                        && self.codex_profile.is_none()
                        && self.revision == value.revision()?,
                    "migration_invalid_source_binding"
                );
                value.snapshot_report()
            })
            .transpose()
            .map(Option::flatten)
    }
    pub fn has_configuration_layers(&self) -> bool {
        self.configuration_layers.is_some() || self.codex_layers.is_some()
    }
    pub fn layer_report(
        &self,
    ) -> Result<Option<crate::configuration_layers::ConfigurationLayerReport>> {
        self.verify_selected_directory()?;
        self.configuration_layers
            .as_ref()
            .map(|layers| layers.report())
            .transpose()
    }
    /// Saved provenance does not reread or execute the original source.
    pub fn layer_snapshot_report(
        &self,
    ) -> Result<Option<crate::configuration_layers::ConfigurationLayerReport>> {
        self.configuration_layers
            .as_ref()
            .map(|layers| {
                ensure!(
                    self.kind == MigrationSourceKind::ClaudeCode
                        && self.scope == "project-effective"
                        && self.codex_profile.is_none()
                        && self.revision == layers.revision()?,
                    "migration_invalid_source_binding"
                );
                layers.snapshot_report()
            })
            .transpose()
            .map(Option::flatten)
    }
    pub(crate) fn read_layer_private_field(
        &self,
        pointer: &str,
    ) -> Result<Option<zeroize::Zeroizing<String>>> {
        self.verify_selected_directory()?;
        self.configuration_layers
            .as_ref()
            .map(|layers| layers.private_field(pointer))
            .transpose()
    }

    pub(crate) fn refreshed(&self) -> Result<Self> {
        self.verify_selected_directory()?;
        let mut binding = if let Some(layers) = &self.codex_layers {
            Self::from_codex_layers(layers.refreshed()?)?
        } else if let Some(layers) = &self.configuration_layers {
            Self::from_layers(layers.refreshed()?)?
        } else {
            let directory = PrivateDirectory::open_existing(&self.root)?;
            ensure!(
                directory.directory_identity()? == self.directory_identity,
                "migration_source_changed"
            );
            self.refreshed_profile(Self::capture(
                &self.root.join(&self.name),
                self.kind,
                &self.scope,
            )?)?
        };
        binding.selected_root = self.selected_root.clone();
        binding.read()?;
        Ok(binding)
    }
    pub(crate) fn logical_identity(&self) -> String {
        if let Some(layers) = &self.codex_layers {
            return self.selected_root_identity(layers.logical_identity());
        }
        use sha2::{Digest, Sha256};
        if let Some(layers) = &self.configuration_layers {
            return self.selected_root_identity(layers.logical_identity());
        }
        let identity = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "{:?}\0{}\0{}\0{}\0{}",
                    self.kind,
                    self.root.display(),
                    self.directory_identity,
                    self.name,
                    self.scope
                )
                .as_bytes()
            )
        );
        let identity = self.selected_root_identity(identity);
        match self.profile_label() {
            Some(label) => format!("{:x}", Sha256::digest(format!("{identity}\0{label}"))),
            None => identity,
        }
    }
    fn capture(path: &Path, kind: MigrationSourceKind, scope: &str) -> Result<Self> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("migration_unsafe_source_path"))?;
        let directory = PrivateDirectory::open_existing(parent)?;
        let root = parent
            .canonicalize()
            .map_err(|_| anyhow::anyhow!("migration_source_unavailable"))?;
        let name = path
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(|| anyhow::anyhow!("migration_unsafe_source_path"))?
            .to_owned();
        ensure!(
            PrivateDirectory::open_existing(&root)?.directory_identity()?
                == directory.directory_identity()?,
            "migration_source_changed"
        );
        directory
            .verify_trusted_config_directory()
            .map_err(|_| anyhow::anyhow!("migration_source_directory_untrusted"))?;
        let document = SourceDocument::read_configuration_at(&directory, OsStr::new(&name))?;
        let codex_profile = if kind == MigrationSourceKind::Codex && scope == "user" {
            codex_profiles::capture_file(&directory, &name)?
        } else {
            None
        };
        Ok(Self {
            root,
            directory_identity: directory.directory_identity()?,
            name,
            kind,
            revision: document.revision(),
            scope: scope.into(),
            codex_profile,
            configuration_layers: None,
            codex_layers: None,
            selected_root: None,
        })
    }

    pub fn read(&self) -> Result<SourceDocument> {
        self.verify_selected_directory()?;
        if let Some(layers) = &self.codex_layers {
            ensure!(
                self.kind == MigrationSourceKind::Codex
                    && self.scope == "codex-project-layers"
                    && self.codex_profile.is_none()
                    && self.configuration_layers.is_none()
                    && self.revision == layers.revision()?,
                "migration_invalid_source_binding"
            );
            let document = layers.read()?;
            self.verify_selected_directory()?;
            return Ok(document);
        }
        if let Some(layers) = &self.configuration_layers {
            ensure!(
                self.kind == MigrationSourceKind::ClaudeCode
                    && self.scope == "project-effective"
                    && self.codex_profile.is_none()
                    && self.revision == layers.revision()?,
                "migration_invalid_source_binding"
            );
            let document = layers.read()?;
            self.verify_selected_directory()?;
            return Ok(document);
        }
        ensure!(self.root.is_absolute(), "migration_unsafe_source_path");
        let directory = PrivateDirectory::open_existing(&self.root)
            .map_err(|_| anyhow::anyhow!("migration_source_unavailable"))?;
        directory
            .verify_trusted_config_directory()
            .map_err(|_| anyhow::anyhow!("migration_unsafe_source_path"))?;
        ensure!(
            directory.directory_identity()? == self.directory_identity,
            "migration_source_changed"
        );
        let document = SourceDocument::read_configuration_at(&directory, OsStr::new(&self.name))?;
        if let Some(root) = &self.selected_root {
            root.verify_uploaded_bytes(&self.root.join(&self.name), document.text().as_bytes())?;
        }
        ensure!(
            document.revision() == self.revision,
            "migration_source_changed"
        );
        let document = self.profile_document(&directory, document)?;
        self.verify_selected_directory()?;
        Ok(document)
    }

    pub fn project_root(&self) -> Option<std::path::PathBuf> {
        if let Some(layers) = &self.codex_layers {
            return layers.project_root();
        }
        if let Some(layers) = &self.configuration_layers {
            return layers.project_root();
        }
        if !self.scope.starts_with("project") {
            return None;
        }
        if self.name == ".mcp.json" {
            Some(self.root.clone())
        } else {
            self.root.parent().map(std::path::Path::to_path_buf)
        }
    }

    pub fn inventory(&self) -> Result<MigrationInventory> {
        if let Some(layers) = &self.codex_layers {
            self.read()?;
            return layers.inventory();
        }
        if let Some(layers) = &self.configuration_layers {
            self.read()?;
            return layers.inventory();
        }
        let source = self.read()?;
        let mut inventory = match self.kind {
            MigrationSourceKind::ClaudeCode => parse_claude_settings(source.text()),
            MigrationSourceKind::Codex => crate::adapters::parse_codex_config_with_redactions(
                source.text(),
                &source.private_values(),
            ),
        }?;
        self.profile_inventory(&mut inventory, &source)?;
        if self.kind == MigrationSourceKind::Codex && self.scope.starts_with("project") {
            // Project fields cannot create a user-level Provider that the source never used.
            for item in &mut inventory.items {
                if item.provider.is_some() {
                    item.preview
                        .issues
                        .push(kcoder_types::migration::MigrationIssue {
                            code: kcoder_types::migration::MigrationIssueCode::RequiresReview,
                            severity: kcoder_types::migration::MigrationIssueSeverity::Blocking,
                            phase: kcoder_types::migration::MigrationIssuePhase::Import,
                            field: Some("project_provider_scope".into()),
                        });
                    item.preview.status =
                        kcoder_types::migration::MigrationItemStatus::RequiresAction;
                    item.preview.selected_by_default = false;
                }
            }
        }
        Ok(inventory)
    }

    /// Revalidate old plans against the current adapter without discarding explicit field choices.
    pub(crate) fn validate_provider_item(&self, planned: &crate::NormalizedItem) -> Result<()> {
        let inventory = self.inventory()?;
        let original = inventory
            .items
            .iter()
            .find(|item| {
                item.provider.is_some() && item.preview.source_name == planned.preview.source_name
            })
            .ok_or_else(|| anyhow::anyhow!("migration_not_a_provider"))?;
        let resolved = planned
            .provider
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_a_provider"))?;
        ensure!(
            original.provider.as_ref().unwrap().api_format == resolved.api_format,
            "migration_source_changed"
        );
        ensure!(
            !original
                .preview
                .issues
                .iter()
                .any(|issue| issue.blocks_import() && !crate::providers::resolution_can_fix(issue)),
            "migration_item_requires_resolution"
        );
        Ok(())
    }
}

/// Paths come from the authenticated app-server host, never from RPC parameters.
pub struct DiscoveryRoots {
    pub home: PathBuf,
    pub claude_config_dir: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
    pub project: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct DiscoveredConfiguration {
    pub source_id: String,
    pub kind: MigrationSourceKind,
    pub scope: &'static str,
    pub format_revision: String,
    pub categories: Vec<MigrationCategory>,
    pub display_name: String,
}

#[derive(Debug, Clone)]
pub struct DiscoveryProblem {
    pub kind: MigrationSourceKind,
    pub scope: &'static str,
    pub code: &'static str,
}

pub struct SourceRegistry {
    definition_project: Option<crate::selected_source_root::SelectedProjectRoot>,
    definition_catalogs: BTreeMap<String, definitions::Catalog>,
    memory_catalogs: BTreeMap<String, memory::Catalog>,
    project_catalogs: BTreeMap<String, projects::Catalog>,
    pub(crate) selected_root: Option<crate::selected_source_root::SelectedRootGrant>,
    roots: DiscoveryRoots,
    grants: BTreeMap<String, SourceGrant>,
    asset_grants: BTreeMap<String, AssetGrant>,
    history_catalogs: BTreeMap<String, crate::history_discovery::HistoryCatalog>,
    plugin_catalogs: BTreeMap<String, plugins::Catalog>,
}

struct AssetGrant {
    binding: crate::asset_sources::AssetBundleBinding,
    scope: &'static str,
    created: Instant,
}

struct SourceGrant {
    binding: ConfigurationBinding,
    scope: &'static str,
    created: Instant,
}

impl SourceRegistry {
    /// Native callers explicitly authorize the actual trusted workspace, independently of product roots.
    pub fn authorize_selected_project(
        &mut self,
        profile: &Path,
        project: Option<&Path>,
    ) -> Result<()> {
        if let Some(selected) = &mut self.selected_root {
            let project =
                project.ok_or_else(|| anyhow::anyhow!("migration_project_source_not_trusted"))?;
            let root = selected.binding.authorize_project(profile, project)?;
            self.roots.project = Some(root);
        }
        Ok(())
    }

    pub fn new(roots: DiscoveryRoots) -> Self {
        Self {
            definition_project: None,
            definition_catalogs: BTreeMap::new(),
            memory_catalogs: BTreeMap::new(),
            project_catalogs: BTreeMap::new(),
            selected_root: None,
            roots,
            grants: BTreeMap::new(),
            asset_grants: BTreeMap::new(),
            history_catalogs: BTreeMap::new(),
            plugin_catalogs: BTreeMap::new(),
        }
    }

    pub fn discover(
        &mut self,
        kinds: &[MigrationSourceKind],
        include_project: bool,
    ) -> (Vec<DiscoveredConfiguration>, Vec<DiscoveryProblem>) {
        self.discover_with_assets(kinds, include_project, true)
    }

    /// Configuration-only callers must not inspect or grant unrelated work assets.
    pub fn discover_with_assets(
        &mut self,
        kinds: &[MigrationSourceKind],
        include_project: bool,
        include_assets: bool,
    ) -> (Vec<DiscoveredConfiguration>, Vec<DiscoveryProblem>) {
        if self.verify_selected_root(None).is_err() {
            return (
                Vec::new(),
                vec![DiscoveryProblem {
                    kind: self.selected_root.as_ref().unwrap().binding.kind(),
                    scope: "selected-directory",
                    code: "migration_selected_root_unavailable",
                }],
            );
        }
        if include_project && self.verify_selected_project().is_err() {
            return (
                Vec::new(),
                vec![DiscoveryProblem {
                    kind: self.selected_root.as_ref().unwrap().binding.kind(),
                    scope: "project",
                    code: "migration_project_source_unavailable",
                }],
            );
        }
        if let Some(root) = &self.selected_root
            && kinds.iter().any(|kind| *kind != root.binding.kind())
        {
            return (
                Vec::new(),
                vec![DiscoveryProblem {
                    kind: root.binding.kind(),
                    scope: "selected-directory",
                    code: "migration_selected_root_scope_changed",
                }],
            );
        }
        let now = Instant::now();
        self.grants
            .retain(|_, grant| now.duration_since(grant.created) < GRANT_LIFETIME);
        self.asset_grants
            .retain(|_, grant| now.duration_since(grant.created) < GRANT_LIFETIME);
        let mut found = Vec::new();
        let mut problems = Vec::new();
        let mut candidates = Vec::new();
        let mut layered_roots = Vec::new();
        for kind in [MigrationSourceKind::ClaudeCode, MigrationSourceKind::Codex] {
            if !kinds.is_empty() && !kinds.contains(&kind) {
                continue;
            }
            if self.verify_selected_root(Some(kind)).is_err() {
                continue;
            }
            let custom = match kind {
                MigrationSourceKind::ClaudeCode => self.roots.claude_config_dir.as_ref(),
                MigrationSourceKind::Codex => self.roots.codex_home.as_ref(),
            };
            if custom.is_some_and(|path| !path.is_absolute()) {
                problems.push(DiscoveryProblem {
                    kind,
                    scope: "user",
                    code: "migration_unsafe_source_path",
                });
                continue;
            }
            let directory = custom.cloned().unwrap_or_else(|| {
                self.roots.home.join(match kind {
                    MigrationSourceKind::ClaudeCode => ".claude",
                    MigrationSourceKind::Codex => ".codex",
                })
            });
            candidates.push((
                kind,
                "user",
                directory.join(match kind {
                    MigrationSourceKind::ClaudeCode => "settings.json",
                    MigrationSourceKind::Codex => "config.toml",
                }),
            ));
            if kind == MigrationSourceKind::Codex {
                match codex_profiles::files(&directory) {
                    Ok(profiles) => {
                        candidates.extend(profiles.into_iter().map(|path| (kind, "user", path)))
                    }
                    Err(_) => problems.push(DiscoveryProblem {
                        kind,
                        scope: "user",
                        code: "migration_profile_discovery_incomplete",
                    }),
                }
            }
            if kind == MigrationSourceKind::ClaudeCode && custom.is_none() {
                candidates.push((kind, "user-mcp", self.roots.home.join(".claude.json")));
            }
            if include_project && let Some(project) = &self.roots.project {
                if kind == MigrationSourceKind::ClaudeCode {
                    layered_roots.push((directory.clone(), project.clone()));
                }
                let directory = project.join(match kind {
                    MigrationSourceKind::ClaudeCode => ".claude",
                    MigrationSourceKind::Codex => ".codex",
                });
                candidates.push((
                    kind,
                    "project",
                    directory.join(match kind {
                        MigrationSourceKind::ClaudeCode => "settings.json",
                        MigrationSourceKind::Codex => "config.toml",
                    }),
                ));
                if kind == MigrationSourceKind::ClaudeCode {
                    candidates.push((kind, "project-mcp", project.join(".mcp.json")));
                    candidates.push((kind, "project-local", directory.join("settings.local.json")));
                }
            }
        }
        for (kind, scope, path) in candidates {
            match std::fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    problems.push(DiscoveryProblem {
                        kind,
                        scope,
                        code: "migration_source_unavailable",
                    });
                    continue;
                }
                Ok(_) => {}
            }
            let result = ConfigurationBinding::capture(&path, kind, scope);
            match result {
                Ok(binding) => {
                    let mut bindings = match binding.legacy_profiles() {
                        Ok(bindings) => bindings,
                        Err(_) => {
                            problems.push(DiscoveryProblem {
                                kind,
                                scope,
                                code: "migration_profile_discovery_incomplete",
                            });
                            Vec::new()
                        }
                    };
                    bindings.insert(0, binding);
                    for binding in bindings {
                        if self
                            .grant_configuration(binding, scope, now, &mut found)
                            .is_err()
                        {
                            problems.push(DiscoveryProblem {
                                kind,
                                scope,
                                code: "migration_source_unreadable_or_unsupported",
                            });
                        }
                    }
                }
                Err(error) => problems.push(DiscoveryProblem {
                    kind,
                    scope,
                    code: if error.to_string() == "migration_source_directory_untrusted" {
                        "migration_source_directory_untrusted"
                    } else {
                        "migration_source_unreadable_or_unsupported"
                    },
                }),
            }
        }
        for (user, project) in layered_roots {
            match ConfigurationBinding::capture_claude_layers(&user, &project) {
                Ok(Some(binding)) => {
                    if self
                        .grant_configuration(binding, "project-effective", now, &mut found)
                        .is_err()
                    {
                        problems.push(DiscoveryProblem {
                            kind: MigrationSourceKind::ClaudeCode,
                            scope: "project-effective",
                            code: "migration_configuration_layers_unavailable",
                        });
                    }
                }
                Ok(None) => {}
                Err(_) => problems.push(DiscoveryProblem {
                    kind: MigrationSourceKind::ClaudeCode,
                    scope: "project-effective",
                    code: "migration_configuration_layers_unavailable",
                }),
            }
        }
        if include_assets {
            let (assets, asset_problems) = self.discover_assets(kinds, include_project);
            found.extend(assets);
            problems.extend(asset_problems);
        }
        if let Some(root) = &self.selected_root
            && self.verify_selected_root(None).is_err()
        {
            return (
                Vec::new(),
                vec![DiscoveryProblem {
                    kind: root.binding.kind(),
                    scope: "selected-directory",
                    code: "migration_selected_root_unavailable",
                }],
            );
        }
        (found, problems)
    }

    fn grant_configuration(
        &mut self,
        mut binding: ConfigurationBinding,
        scope: &'static str,
        now: Instant,
        found: &mut Vec<DiscoveredConfiguration>,
    ) -> Result<()> {
        if let Some(root) = &self.selected_root {
            binding.selected_root = Some(root.binding.for_read_scope(
                binding.has_configuration_layers()
                    || scope.starts_with("project")
                    || scope == "codex-project-layers",
            ));
            binding.verify_selected_directory()?;
        }
        let inventory = binding.inventory()?;
        let source_id = self
            .grants
            .iter()
            .find(|(_, grant)| grant.binding == binding && grant.scope == scope)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| format!("src-{}", uuid::Uuid::new_v4().simple()));
        let mut categories = Vec::new();
        for item in &inventory.items {
            if !categories.contains(&item.preview.category) {
                categories.push(item.preview.category);
            }
        }
        let product = product_name(binding.kind);
        found.push(DiscoveredConfiguration {
            source_id: source_id.clone(),
            kind: binding.kind,
            scope,
            format_revision: inventory.adapter_revision,
            categories,
            display_name: if binding.has_configuration_layers() {
                format!("{product} · selected settings layers")
            } else {
                binding
                    .profile_label()
                    .map(|name| format!("{product} · {name}"))
                    .unwrap_or_else(|| product.into())
            },
        });
        if let Some(grant) = self.grants.get_mut(&source_id) {
            grant.created = now;
        } else {
            if self.grants.len() >= MAX_GRANTS
                && let Some(oldest) = self
                    .grants
                    .iter()
                    .min_by_key(|(_, grant)| grant.created)
                    .map(|(id, _)| id.clone())
            {
                self.grants.remove(&oldest);
            }
            self.grants.insert(
                source_id,
                SourceGrant {
                    binding,
                    scope,
                    created: now,
                },
            );
        }
        Ok(())
    }

    pub fn selected(&self, source_id: &str) -> Result<ConfigurationBinding> {
        self.selected_at(source_id, Instant::now())
    }

    fn selected_at(&self, source_id: &str, now: Instant) -> Result<ConfigurationBinding> {
        self.verify_selected_root(None)?;
        self.grants
            .get(source_id)
            .filter(|grant| now.duration_since(grant.created) < GRANT_LIFETIME)
            .map(|grant| grant.binding.clone())
            .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn roots(path: &Path) -> DiscoveryRoots {
        DiscoveryRoots {
            home: path.into(),
            claude_config_dir: None,
            codex_home: None,
            project: None,
        }
    }
    #[test]
    fn configuration_only_discovery_never_grants_work_asset_access() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".claude")).unwrap();
        std::fs::write(root.path().join(".claude/settings.json"), "{}").unwrap();
        std::fs::write(
            root.path().join(".claude/CLAUDE.md"),
            "Do not read during configuration-only discovery.",
        )
        .unwrap();
        let mut registry = SourceRegistry::new(roots(root.path()));
        let (found, problems) =
            registry.discover_with_assets(&[MigrationSourceKind::ClaudeCode], false, false);
        assert!(problems.is_empty());
        assert_eq!(found.len(), 1);
        assert!(registry.asset_grants.is_empty());
        assert!(registry.selected(&found[0].source_id).is_ok());
        let (all, problems) = registry.discover(&[MigrationSourceKind::ClaudeCode], false);
        assert!(problems.is_empty());
        assert_eq!(all.len(), 2);
        assert_eq!(registry.asset_grants.len(), 1);
    }
    #[test]
    fn discovery_is_scoped_opaque_and_preserves_peer_grants_without_reading_authentication() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".codex")).unwrap();
        std::fs::write(root.path().join(".codex/config.toml"), "model='fixture'").unwrap();
        std::fs::write(
            root.path().join(".codex/auth.json"),
            "not JSON and must not be read",
        )
        .unwrap();
        let mut registry = SourceRegistry::new(roots(root.path()));
        let (sources, errors) = registry.discover(&[], false);
        assert!(errors.is_empty());
        assert_eq!(sources.len(), 1);
        assert!(!sources[0].source_id.contains(root.path().to_str().unwrap()));
        let selected = registry.selected(&sources[0].source_id).unwrap();
        assert_eq!(
            selected.inventory().unwrap().source,
            MigrationSourceKind::Codex
        );
        registry.discover(&[], false);
        assert!(registry.selected(&sources[0].source_id).is_ok());
        assert!(
            registry
                .selected_at(&sources[0].source_id, Instant::now() + GRANT_LIFETIME)
                .is_err()
        );
        std::fs::write(root.path().join(".codex/config.toml"), "model='changed'").unwrap();
        assert!(selected.read().is_err());
    }
    #[test]
    fn project_discovery_is_explicit_and_custom_homes_never_fall_back_to_other_roots() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::write(project.join(".claude/settings.json"), "{}").unwrap();
        let mut inputs = roots(root.path());
        inputs.project = Some(project);
        let mut registry = SourceRegistry::new(inputs);
        assert!(registry.discover(&[], false).0.is_empty());
        let sources = registry.discover(&[], true).0;
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().any(|source| source.scope == "project"));
        assert!(
            sources
                .iter()
                .any(|source| source.scope == "project-effective")
        );
        let mut inputs = roots(root.path());
        inputs.codex_home = Some("relative".into());
        let mut registry = SourceRegistry::new(inputs);
        assert_eq!(
            registry
                .discover(&[MigrationSourceKind::Codex], false)
                .1
                .len(),
            1
        );
    }

    #[test]
    fn grants_do_not_cross_registries_and_replaced_roots_cannot_reuse_a_binding() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join(".codex");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("config.toml"), "model='fixture'").unwrap();
        let mut registry = SourceRegistry::new(roots(root.path()));
        let selected = registry.discover(&[], false).0.remove(0);
        let other = SourceRegistry::new(roots(root.path()));
        assert!(other.selected(&selected.source_id).is_err());
        let binding = registry.selected(&selected.source_id).unwrap();
        std::fs::rename(&directory, root.path().join("moved")).unwrap();
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("config.toml"), "model='fixture'").unwrap();
        assert!(binding.read().is_err());
    }
}
