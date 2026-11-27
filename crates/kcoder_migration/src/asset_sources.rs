//! Account-scoped bounded asset reads. Source code, imports and command substitutions never execute.
use crate::{
    MigrationInventory,
    adapters::issue,
    model::{AssetCandidate, NormalizedItem},
};
use anyhow::{Result, ensure};
use kcoder_config::{PrivateDirectory, imported_context::ImportedContextScope};
use kcoder_types::migration::{
    MigrationCategory as Category, MigrationIssueCode as Code, MigrationIssueSeverity as Severity,
    MigrationItemPreview, MigrationItemStatus as Status, MigrationSourceKind,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
};

mod imports;
mod instructions;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetBundleBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instructions: Option<Box<crate::instruction_assets::binding::InstructionBinding>>,
    root: PathBuf,
    identity: String,
    single: Option<String>,
    pub kind: MigrationSourceKind,
    pub category: Category,
    pub scope: ImportedContextScope,
    #[serde(default)]
    fingerprints: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    received: Option<Box<crate::source_transfer::ReceivedAssetBinding>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selected_root: Option<crate::selected_source_root::SelectedRootBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    memory: Option<Box<crate::memory_sources::MemorySourceBinding>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    definition_hooks: Option<Box<crate::definition_sources::InlineHooksBinding>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    definition_project: Option<Box<crate::selected_source_root::SelectedProjectRoot>>,
}

/// Private source material. Debug and public inventories never include its contents.
pub struct SourceAsset {
    pub key: String,
    pub name: String,
    pub files: Vec<kcoder_skills::SkillPackageFile>,
    pub native_reference: bool,
}
impl SourceAsset {
    pub fn revision(&self) -> String {
        let mut hash = Sha256::new();
        let mut files = self.files.iter().collect::<Vec<_>>();
        files.sort_by_key(|file| &file.relative_path);
        for file in files {
            hash.update(file.relative_path.as_os_str().as_encoded_bytes());
            hash.update([0]);
            hash.update((file.content.len() as u64).to_le_bytes());
            hash.update(&file.content);
            hash.update([u8::from(file.executable)]);
        }
        format!("{:x}", hash.finalize())
    }
}

impl AssetBundleBinding {
    pub fn uploaded_source(
        &self,
    ) -> Result<Option<kcoder_types::migration_source_upload::SourceUploadProvenance>> {
        if let Some(received) = self.received_binding()? {
            return received.uploaded_source();
        }
        if let Some(hooks) = &self.definition_hooks {
            return hooks.configuration.uploaded_source();
        }
        if let Some(root) = &self.selected_root {
            root.verify(&self.root, self.kind)?;
        }
        Ok(self
            .selected_root
            .as_ref()
            .and_then(|root| root.uploaded())
            .map(|uploaded| uploaded.provenance()))
    }
    pub(crate) fn from_received(
        binding: crate::source_transfer::ReceivedAssetBinding,
    ) -> Result<Self> {
        let (kind, category, scope, key) = binding.metadata()?;
        validate_name(&key)?;
        Ok(Self {
            root: binding.profile().into(),
            identity: binding.logical_identity()?,
            single: Some(key),
            kind,
            category,
            scope,
            instructions: None,
            fingerprints: Default::default(),
            received: Some(Box::new(binding)),
            selected_root: None,
            memory: None,
            definition_hooks: None,
            definition_project: None,
        })
    }
    fn received_binding(&self) -> Result<Option<&crate::source_transfer::ReceivedAssetBinding>> {
        let Some(binding) = self.received.as_deref() else {
            return Ok(None);
        };
        let (kind, category, scope, key) = binding.metadata()?;
        ensure!(
            self.kind == kind
                && self.category == category
                && self.scope == scope
                && self.single.as_deref() == Some(&key)
                && self.root == binding.profile()
                && self.identity == binding.logical_identity()?,
            "source_transfer_binding_changed"
        );
        Ok(Some(binding))
    }
    pub(crate) fn stable_source_identity(&self) -> Option<String> {
        self.allows_reuse().then(|| self.logical_identity())
    }
    pub(crate) fn allows_reuse(&self) -> bool {
        if self.is_scoped_instruction() {
            return false;
        }
        self.received
            .as_deref()
            .is_none_or(|binding| binding.allows_reuse())
    }
    pub(crate) fn verify_batch_parent(&self, parent: &PrivateDirectory) -> Result<()> {
        self.verify_instruction_parent(parent)?;
        if let Some(binding) = self.received_binding()? {
            binding.verify_batch_parent(parent)?;
        }
        Ok(())
    }
    pub(crate) fn logical_identity(&self) -> String {
        if self.received.is_some() {
            return self.identity.clone();
        }
        let identity = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "{:?}\0{}\0{}\0{:?}\0{:?}\0{:?}",
                    self.kind,
                    self.root.display(),
                    self.identity,
                    self.single,
                    self.category,
                    self.scope
                )
                .as_bytes()
            )
        );
        let identity = if let Some(memory) = &self.memory {
            format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(&(&identity, memory.layout(), memory.group()))
                        .expect("private memory origin")
                )
            )
        } else {
            identity
        };
        let identity = if let Some(hooks) = &self.definition_hooks {
            format!(
                "{:x}",
                Sha256::digest(format!(
                    "{identity}\0inline-hooks:{}",
                    hooks.configuration.logical_identity()
                ))
            )
        } else {
            identity
        };
        let identity = if let Some(project) = &self.definition_project {
            format!(
                "{:x}",
                Sha256::digest(format!(
                    "{identity}\0definition-project:{}",
                    project.identity()
                ))
            )
        } else {
            identity
        };
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
    pub fn capture(
        path: &Path,
        kind: MigrationSourceKind,
        category: Category,
        scope: ImportedContextScope,
        directory: bool,
    ) -> Result<Self> {
        let parent = if directory {
            path
        } else {
            path.parent()
                .ok_or_else(|| anyhow::anyhow!("migration_unsafe_source_path"))?
        };
        let handle = PrivateDirectory::open_existing(parent)?;
        handle.verify_trusted_config_directory()?;
        let root = parent.canonicalize()?;
        ensure!(
            PrivateDirectory::open_existing(&root)?.directory_identity()?
                == handle.directory_identity()?,
            "migration_source_changed"
        );
        Ok(Self {
            root,
            identity: handle.directory_identity()?,
            single: if directory {
                None
            } else {
                Some(
                    path.file_name()
                        .and_then(OsStr::to_str)
                        .ok_or_else(|| anyhow::anyhow!("migration_unsafe_source_path"))?
                        .into(),
                )
            },
            kind,
            category,
            scope,
            instructions: None,
            fingerprints: Default::default(),
            received: None,
            selected_root: None,
            memory: None,
            definition_hooks: None,
            definition_project: None,
        })
    }
    pub(crate) fn from_inline_hooks(
        configuration: crate::discovery::ConfigurationBinding,
    ) -> Result<Option<Self>> {
        if configuration.definition_hook_bytes()?.is_none() {
            return Ok(None);
        }
        let (root, identity) = configuration.definition_location();
        let scope = configuration
            .project_root()
            .map(|root| ImportedContextScope::Project { root })
            .unwrap_or(ImportedContextScope::Global);
        Ok(Some(Self {
            root: root.into(),
            identity: identity.into(),
            single: Some("inline-hooks.json".into()),
            kind: configuration.kind,
            category: Category::Hook,
            scope,
            instructions: None,
            fingerprints: Default::default(),
            received: None,
            selected_root: None,
            memory: None,
            definition_project: None,
            definition_hooks: Some(Box::new(crate::definition_sources::InlineHooksBinding {
                configuration,
            })),
        }))
    }
    pub(crate) fn with_definition_project(
        mut self,
        project: Option<crate::selected_source_root::SelectedProjectRoot>,
    ) -> Result<Self> {
        ensure!(
            matches!(self.category, Category::Agent | Category::Hook),
            "migration_not_a_definition"
        );
        self.definition_project = project.map(Box::new);
        self.verify_definition_project()?;
        Ok(self)
    }
    fn verify_definition_project(&self) -> Result<()> {
        ensure!(
            !matches!(self.category, Category::Agent | Category::Hook)
                || !matches!(self.scope, ImportedContextScope::Project { .. })
                || self.received.is_some()
                || self.definition_project.is_some(),
            "migration_project_source_not_trusted"
        );
        if let Some(project) = &self.definition_project {
            ensure!(
                matches!(self.category, Category::Agent | Category::Hook)
                    && self.root.starts_with(project.root())
                    && self.scope
                        == ImportedContextScope::Project {
                            root: project.root().into()
                        },
                "migration_invalid_source_binding"
            );
            project.verify()?;
        }
        Ok(())
    }
    pub(crate) fn with_selected_root(
        mut self,
        root: Option<crate::selected_source_root::SelectedRootBinding>,
    ) -> Result<Self> {
        let root = root.map(|root| {
            root.for_read_scope(matches!(self.scope, ImportedContextScope::Project { .. }))
        });
        if let Some(root) = &root {
            root.verify(&self.root, self.kind)?;
        }
        self.selected_root = root;
        Ok(self)
    }
    pub(crate) fn with_memory(
        mut self,
        layout: kcoder_types::imported_memory::ImportedMemoryLayout,
        group: String,
    ) -> Result<Self> {
        ensure!(
            self.category == Category::Memory,
            "migration_invalid_source_binding"
        );
        self.memory = Some(Box::new(
            crate::memory_sources::MemorySourceBinding::capture(&self.open()?, layout, group)?,
        ));
        Ok(self)
    }
    pub(crate) fn memory_descriptor(
        &self,
    ) -> Option<(kcoder_types::imported_memory::ImportedMemoryLayout, String)> {
        self.memory
            .as_ref()
            .map(|memory| (memory.layout(), memory.group().into()))
    }
    pub fn memory_provenance(
        &self,
        source: &SourceAsset,
    ) -> Result<Option<kcoder_types::imported_memory::ImportedMemoryProvenance>> {
        if self.category != Category::Memory {
            return Ok(None);
        }
        if let Some(received) = &self.received
            && let Some(origin) = received.memory_provenance()?
        {
            return Ok(Some(origin));
        }
        if let Some(memory) = &self.memory {
            let mut origin = memory.provenance(self.kind, &source.key, source.revision())?;
            if self
                .selected_root
                .as_ref()
                .is_some_and(|root| root.uploaded().is_some())
            {
                // Uploaded manifests do not carry the original file modification time.
                origin.source_modified_at_ms = None;
            }
            return Ok(Some(origin));
        }
        Ok(Some(
            kcoder_types::imported_memory::ImportedMemoryProvenance {
                source: self.kind,
                layout:
                    kcoder_types::imported_memory::ImportedMemoryLayout::UnclassifiedStaticNotes,
                source_group: "unclassified-static-notes".into(),
                source_file: source.key.clone(),
                source_revision: source.revision(),
                source_modified_at_ms: None,
                facts_verified: false,
                migration_job_id: None,
            },
        ))
    }
    fn open(&self) -> Result<PrivateDirectory> {
        if let Some(root) = &self.selected_root {
            root.verify(&self.root, self.kind)?;
        }
        ensure!(
            self.received.is_none(),
            "source_transfer_received_asset_has_no_source_path"
        );
        let root = PrivateDirectory::open_existing(&self.root)?;
        root.verify_trusted_config_directory()?;
        ensure!(
            root.directory_identity()? == self.identity,
            "migration_source_changed"
        );
        Ok(root)
    }
    pub fn entries(&self) -> Result<Vec<String>> {
        if self.is_scoped_instruction() {
            return self
                .checked_instructions()?
                .summaries()
                .map(|rows| rows.into_iter().map(|row| row.id).collect());
        }
        self.verify_definition_project()?;
        if let Some(binding) = self.received_binding()? {
            return Ok(vec![binding.metadata()?.3]);
        }
        if let Some(name) = &self.single {
            validate_name(name)?;
            return Ok(vec![name.clone()]);
        }
        let directory = self.open()?;
        if let Some(memory) = &self.memory {
            memory.verify(&directory)?;
            return Ok(memory.entries());
        }
        let mut entries = Vec::new();
        collect_entries(&directory, "", self.category, 0, &mut 0, &mut entries)?;
        if self.category == Category::Agent {
            entries.retain(|name| {
                name.ends_with(if self.kind == MigrationSourceKind::ClaudeCode {
                    ".md"
                } else {
                    ".toml"
                })
            });
        }
        ensure!(entries.len() <= 1024, "migration_asset_budget_exceeded");
        entries.sort();
        Ok(entries)
    }
    pub fn read(&self, key: &str) -> Result<SourceAsset> {
        self.read_checked(key, |_| true)
    }
    pub(crate) fn read_checked(
        &self,
        key: &str,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<SourceAsset> {
        ensure!(check(0), "source_transfer_cancelled");
        if self.is_scoped_instruction() {
            return self.read_scoped_instruction(key);
        }
        if let Some(binding) = self.received_binding()? {
            let source = binding.read(key, check)?;
            if !self.fingerprints.is_empty() {
                ensure!(
                    self.fingerprints.get(key) == Some(&source.revision()),
                    "migration_source_changed"
                );
            }
            return Ok(source);
        }
        self.verify_definition_project()?;
        let source = self.read_local(key)?;
        self.verify_definition_project()?;
        if let Some(memory) = &self.memory {
            memory.verify_file(&self.open()?, key)?;
        }
        if let Some(root) = &self.selected_root {
            root.verify(&self.root, self.kind)?;
            if self.definition_hooks.is_none() {
                root.verify_uploaded_files(source.files.iter().map(|file| {
                    let parent = if self.category == Category::Skill {
                        self.root.join(key)
                    } else {
                        self.root.clone()
                    };
                    (parent.join(&file.relative_path), file.content.as_slice())
                }))?;
            }
        }
        Ok(source)
    }
    fn read_local(&self, key: &str) -> Result<SourceAsset> {
        validate_name(key)?;
        if let Some(hooks) = &self.definition_hooks {
            ensure!(key == "inline-hooks.json", "migration_unknown_item");
            let source = hooks.read()?;
            if !self.fingerprints.is_empty() {
                ensure!(
                    self.fingerprints.get(key) == Some(&source.revision()),
                    "migration_source_changed"
                );
            }
            return Ok(source);
        }
        if let Some(name) = &self.single {
            ensure!(key == name, "migration_unknown_item");
        }
        let mut parent = self.open()?;
        let parts = key.split('/').collect::<Vec<_>>();
        for part in &parts[..parts.len() - 1] {
            parent = parent.open_child(OsStr::new(part), false)?;
        }
        let leaf = parts[parts.len() - 1];
        let files = if self.category == Category::Skill {
            let directory = parent.open_child(OsStr::new(leaf), false)?;
            let files = kcoder_skills::import::read_package_files(&directory, |path| {
                for component in path.components() {
                    let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
                    ensure!(
                        !name.starts_with(".env.")
                            && ![
                                ".env",
                                "auth.json",
                                "credentials.json",
                                "node_modules",
                                ".venv",
                                "__pycache__",
                                ".ssh",
                                ".aws",
                                "id_rsa",
                                "id_ed25519"
                            ]
                            .contains(&name.as_str())
                            && !name.ends_with(".pem")
                            && !name.ends_with(".key"),
                        "migration_private_or_generated_package_entry"
                    );
                }
                Ok(())
            })?;
            ensure!(
                files
                    .iter()
                    .any(|file| file.relative_path == Path::new("SKILL.md")),
                "migration_skill_entry_missing"
            );
            files
        } else {
            let file = parent.open_single_link_regular_file(OsStr::new(leaf))?;
            ensure!(
                file.metadata()?.len() <= 4 * 1024 * 1024,
                "migration_asset_budget_exceeded"
            );
            let mut bytes = Vec::new();
            file.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() <= 4 * 1024 * 1024,
                "migration_asset_budget_exceeded"
            );
            ensure!(
                matches!(self.category, Category::Agent | Category::Hook)
                    || std::str::from_utf8(&bytes).is_ok(),
                "migration_asset_encoding"
            );
            let mut files = vec![kcoder_skills::SkillPackageFile {
                relative_path: PathBuf::from(key),
                content: bytes,
                executable: false,
            }];
            if self.kind == MigrationSourceKind::ClaudeCode
                && self.category == Category::Instructions
            {
                imports::collect(&self.open()?, key, &mut files)?;
            }
            files
        };
        let native_reference = self.kind == MigrationSourceKind::Codex
            && self.category == Category::Instructions
            && key == "AGENTS.md"
            && matches!(self.scope, ImportedContextScope::Project { .. });
        let source = SourceAsset {
            key: key.into(),
            name: if self.category == Category::Skill {
                key.into()
            } else {
                key.trim_end_matches(".md").replace('/', "-")
            },
            files,
            native_reference,
        };
        if !self.fingerprints.is_empty() {
            ensure!(
                self.fingerprints.get(key) == Some(&source.revision()),
                "migration_source_changed"
            );
        }
        Ok(source)
    }
    pub fn inventory(&self) -> Result<MigrationInventory> {
        if self.is_scoped_instruction() {
            return self.scoped_instruction_inventory();
        }
        self.inventory_with_revisions()
            .map(|(inventory, _)| inventory)
    }
    pub fn freeze(self) -> Result<(Self, MigrationInventory)> {
        self.freeze_checked(|_| true)
    }
    pub(crate) fn freeze_checked(
        mut self,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<(Self, MigrationInventory)> {
        ensure!(
            !self.is_scoped_instruction(),
            "migration_instruction_batch_capture_required"
        );
        let (inventory, revisions) = self.inventory_with_revisions_checked(&mut check)?;
        self.fingerprints = revisions;
        Ok((self, inventory))
    }
    fn inventory_with_revisions(
        &self,
    ) -> Result<(
        MigrationInventory,
        std::collections::BTreeMap<String, String>,
    )> {
        self.inventory_with_revisions_checked(&mut |_| true)
    }
    fn inventory_with_revisions_checked(
        &self,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<(
        MigrationInventory,
        std::collections::BTreeMap<String, String>,
    )> {
        let mut items = Vec::new();
        let mut revisions = std::collections::BTreeMap::new();
        let mut total_bytes = 0usize;
        for key in self.entries()? {
            ensure!(check(total_bytes as u64), "source_transfer_cancelled");
            let id = format!(
                "asset-{:x}",
                Sha256::digest(format!("{:?}:{}", self.category, key).as_bytes())
            );
            let result = if total_bytes >= 32 * 1024 * 1024 {
                Err(anyhow::anyhow!("migration_asset_budget_exceeded"))
            } else {
                self.read_checked(&key, &mut *check)
            };
            let (asset, issues) = match result {
                Ok(source) => {
                    let bytes = source.files.iter().map(|file| file.content.len()).sum();
                    total_bytes += bytes;
                    let compatibility = if matches!(self.category, Category::Agent | Category::Hook)
                    {
                        Ok(())
                    } else if self.category == Category::Skill || self.category == Category::Command
                    {
                        crate::asset_adapter::skill_package(
                            &source,
                            self.category,
                            "migration-probe",
                            "probe",
                            false,
                            &self.scope,
                        )
                        .map(|_| ())
                    } else if self.category == Category::Memory {
                        crate::asset_adapter::memory_text(&source).map(|_| ())
                    } else if source.native_reference {
                        Ok(())
                    } else {
                        crate::asset_adapter::context_text(&source).map(|_| ())
                    };
                    let override_present = self.received.is_none()
                        && self
                            .open()?
                            .entry_metadata(OsStr::new("AGENTS.override.md"))
                            .is_ok();
                    let needs_review = compatibility.is_err()
                        || self.kind == MigrationSourceKind::Codex
                            && self.category == Category::Instructions
                            && override_present;
                    revisions.insert(key.clone(), source.revision());
                    (
                        Some(AssetCandidate {
                            entry: key.clone(),
                            name: source.name,
                            bytes,
                            files: source.files.len(),
                            native_reference: source.native_reference,
                        }),
                        if matches!(self.category, Category::Agent | Category::Hook) {
                            vec![kcoder_types::migration::MigrationIssue {
                                code: Code::RequiresReview,
                                severity: Severity::Blocking,
                                phase: kcoder_types::migration::MigrationIssuePhase::Activation,
                                field: Some("passive_definition".into()),
                            }]
                        } else if needs_review {
                            vec![issue(
                                Code::RequiresReview,
                                Severity::Blocking,
                                "asset_semantics",
                            )]
                        } else {
                            Vec::new()
                        },
                    )
                }
                Err(error) if error.to_string() == "source_transfer_cancelled" => {
                    return Err(error);
                }
                Err(error) => (
                    None,
                    vec![issue(
                        match error.to_string().as_str() {
                            "migration_asset_budget_exceeded" => Code::BudgetExceeded,
                            "migration_source_changed" => Code::SourceChanged,
                            "migration_unsafe_source_path" => Code::UnsafePath,
                            "migration_private_or_generated_package_entry" => Code::SecretExcluded,
                            _ => Code::RequiresReview,
                        },
                        Severity::Blocking,
                        "asset",
                    )],
                ),
            };
            let compatible = asset.is_some() && issues.iter().all(|issue| !issue.blocks_import());
            let passive = matches!(self.category, Category::Agent | Category::Hook);
            items.push(NormalizedItem {
                preview: MigrationItemPreview {
                    id,
                    category: self.category,
                    source_name: key,
                    status: if compatible && !passive {
                        Status::Discovered
                    } else {
                        Status::RequiresAction
                    },
                    selected_by_default: compatible
                        && self.category != Category::Memory
                        && !passive,
                    issues,
                },
                provider: None,
                mcp: None,
                asset,
                template: None,
            });
        }
        let mut provenance_issues = Vec::new();
        if let Some(received) = self.received_binding()? {
            if !received.allows_reuse() {
                provenance_issues.push(issue(
                    Code::RequiresReview,
                    Severity::Warning,
                    "received_source_identity_unavailable",
                ));
            }
            if received.executable_flags_cleared()? {
                provenance_issues.push(issue(
                    Code::RequiresReview,
                    Severity::Warning,
                    "received_executable_flags_cleared",
                ));
            }
        }
        Ok((
            MigrationInventory {
                source: self.kind,
                adapter_revision: if matches!(self.category, Category::Agent | Category::Hook) {
                    "passive-definition/v1"
                } else {
                    "asset-bundle/v1"
                }
                .into(),
                items,
                issues: provenance_issues,
            },
            revisions,
        ))
    }
    pub fn source_path(&self, key: &str) -> Result<PathBuf> {
        ensure!(
            !self.is_scoped_instruction(),
            "migration_instruction_has_no_synthetic_source_path"
        );
        if let Some(root) = &self.selected_root {
            root.verify(&self.root, self.kind)?;
        }
        ensure!(
            self.received.is_none(),
            "source_transfer_received_asset_has_no_source_path"
        );
        validate_name(key)?;
        Ok(self.root.join(key))
    }
}

pub(crate) fn expanded_context(source: &SourceAsset) -> Result<String> {
    imports::expand(source)
}
fn validate_name(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty()
            && name.len() <= 1024
            && !name.contains('\\')
            && !name.chars().any(char::is_control)
            && name
                .split('/')
                .all(|part| !part.is_empty() && part.len() <= 256 && part != "." && part != ".."),
        "migration_unsafe_source_path"
    );
    Ok(())
}

fn collect_entries(
    directory: &PrivateDirectory,
    prefix: &str,
    category: Category,
    depth: usize,
    count: &mut usize,
    entries: &mut Vec<String>,
) -> Result<()> {
    ensure!(depth <= 16, "migration_asset_budget_exceeded");
    directory.visit_entry_names_bounded(4096, |name| {
        *count += 1;
        ensure!(*count <= 4096, "migration_asset_budget_exceeded");
        let name = name
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("migration_unsafe_source_path"))?;
        if [".git", "node_modules", ".venv", "__pycache__"].contains(&name) {
            return Ok(());
        }
        let key = if prefix.is_empty() {
            name.into()
        } else {
            format!("{prefix}/{name}")
        };
        validate_name(&key)?;
        let metadata = directory.entry_metadata(OsStr::new(name))?;
        if category == Category::Skill {
            if metadata.is_dir() || metadata.file_type().is_symlink() {
                entries.push(key);
            }
        } else if metadata.is_dir() {
            collect_entries(
                &directory.open_child(OsStr::new(name), false)?,
                &key,
                category,
                depth + 1,
                count,
                entries,
            )?;
        } else if name.ends_with(".md") || category == Category::Agent && name.ends_with(".toml") {
            entries.push(key);
        }
        Ok(())
    })
}
