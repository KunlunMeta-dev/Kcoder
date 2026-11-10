//! Native work-asset plans. Only the private journal contains content snapshots.
use crate::{NormalizedItem, asset_sources::AssetBundleBinding};
use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_config::{
    PrivateDirectory,
    imported_context::{
        ImportedContext, ImportedContextKind, ImportedContextScope, ImportedContextStore,
    },
};
use kcoder_skills::{
    ExpectedSkillRevision, SkillCommitRequest, SkillMutation, SkillMutationActor,
    SkillOperationKind, SkillPackage, SkillPackageFile, SkillRevision, SkillStore,
};
use kcoder_types::migration::{MigrationCategory as Category, MigrationItemStatus as Status};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

mod agents;
mod instructions;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetResolution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_adaptation: Option<kcoder_types::migration_agent::MigrationAgentAdaptation>,
    pub item_id: String,
    pub target_name: String,
    #[serde(default)]
    pub enable_after_import: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_scope: Option<ImportedContextScope>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedFile {
    path: PathBuf,
    data: String,
    executable: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Skill {
        name: String,
        files: Vec<EncodedFile>,
        revision: SkillRevision,
    },
    Context {
        record: ImportedContext,
    },
    NativeReference {
        path: PathBuf,
    },
    PendingDefinition {
        binding: Box<crate::definition_assets::StoreBinding>,
        record: Box<crate::definition_assets::DefinitionRecord>,
    },
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetPlan {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_adaptation: Option<kcoder_types::migration_agent::MigrationAgentAdaptation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    adapted_agent_report: Option<kcoder_types::migration_definitions::MigrationDefinitionReport>,
    plan_id: String,
    target_id: String,
    name: String,
    enabled: bool,
    item: NormalizedItem,
    scope: ImportedContextScope,
    original_entry: EncodedFile,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    imported_sources: Vec<EncodedFile>,
    #[serde(default)]
    source_revision: Option<String>,
    action: Action,
}
impl std::fmt::Debug for AssetPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AssetPlan")
            .field("plan_id", &self.plan_id)
            .field("enabled", &self.enabled)
            .finish_non_exhaustive()
    }
}
impl AssetPlan {
    pub(crate) fn bind_memory_job(&mut self, job_id: &str) -> Result<()> {
        if let Action::Context { record } = &mut self.action
            && let Some(origin) = &mut record.memory_provenance
        {
            ensure!(
                origin
                    .migration_job_id
                    .as_ref()
                    .is_none_or(|old| old == job_id),
                "migration_wrong_target"
            );
            origin.migration_job_id = Some(job_id.into());
        }
        Ok(())
    }
    pub(crate) fn semantic_fingerprint(&self) -> Result<String> {
        let revision = if let Some(revision) = &self.source_revision {
            revision.clone()
        } else {
            let mut files = match &self.action {
                Action::Skill { files, .. } => files
                    .iter()
                    .filter(|file| file.path != Path::new("SKILL.md"))
                    .map(|file| {
                        Ok(SkillPackageFile {
                            relative_path: file.path.clone(),
                            content: STANDARD
                                .decode(&file.data)
                                .map_err(|_| anyhow::anyhow!("migration_invalid_journal"))?,
                            executable: file.executable,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?,
                _ => Vec::new(),
            };
            files.push(SkillPackageFile {
                relative_path: self.original_entry.path.clone(),
                content: STANDARD
                    .decode(&self.original_entry.data)
                    .map_err(|_| anyhow::anyhow!("migration_invalid_journal"))?,
                executable: self.original_entry.executable,
            });
            crate::asset_sources::SourceAsset {
                key: String::new(),
                name: String::new(),
                files,
                native_reference: self.native_reference(),
            }
            .revision()
        };
        asset_fingerprint(
            self.item.preview.category,
            &self.scope,
            &self.name,
            self.enabled && !self.native_reference(),
            &agents::semantic_revision(&revision, self.agent_adaptation.as_ref())?,
        )
    }
    pub(crate) fn original_text(&self) -> Result<String> {
        let bytes = STANDARD
            .decode(&self.original_entry.data)
            .map_err(|_| anyhow::anyhow!("migration_invalid_journal"))?;
        ensure!(
            bytes.len() <= 4 * 1024 * 1024,
            "migration_asset_budget_exceeded"
        );
        let mut text =
            String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("migration_asset_encoding"))?;
        for source in &self.imported_sources {
            let bytes = STANDARD
                .decode(&source.data)
                .map_err(|_| anyhow::anyhow!("migration_invalid_journal"))?;
            let body = std::str::from_utf8(&bytes)
                .map_err(|_| anyhow::anyhow!("migration_asset_encoding"))?;
            let header = format!(
                "\n\n<!-- Original imported Markdown source: {} -->\n",
                source.path.display()
            );
            ensure!(
                text.len()
                    .saturating_add(header.len())
                    .saturating_add(body.len())
                    <= 4 * 1024 * 1024,
                "migration_asset_budget_exceeded"
            );
            text.push_str(&header);
            text.push_str(body);
        }
        Ok(text)
    }
    pub(crate) fn context_record(&self) -> Option<&ImportedContext> {
        match &self.action {
            Action::Context { record } => Some(record),
            _ => None,
        }
    }
    fn pending_record(&self) -> Option<crate::definition_assets::DefinitionRecord> {
        let Action::PendingDefinition { record, .. } = &self.action else {
            return None;
        };
        let mut record = (**record).clone();
        record.data = self.original_entry.data.clone();
        Some(record)
    }
    pub fn definition_report(
        &self,
    ) -> Option<&kcoder_types::migration_definitions::MigrationDefinitionReport> {
        if let Some(report) = self.adapted_agent_report.as_ref() {
            return Some(report);
        }
        match &self.action {
            Action::PendingDefinition { record, .. } => Some(&record.report),
            _ => None,
        }
    }
    pub fn definition_bytes(&self) -> Result<Option<Vec<u8>>> {
        if self.definition_report().is_none() {
            return Ok(None);
        }
        ensure!(
            self.original_entry.data.len() <= (4 * 1024 * 1024usize).div_ceil(3) * 4,
            "migration_asset_budget_exceeded"
        );
        let bytes = STANDARD
            .decode(&self.original_entry.data)
            .map_err(|_| anyhow::anyhow!("migration_invalid_journal"))?;
        ensure!(
            bytes.len() <= 4 * 1024 * 1024,
            "migration_asset_budget_exceeded"
        );
        Ok(Some(bytes))
    }
    pub fn id(&self) -> &str {
        &self.plan_id
    }
    pub fn item(&self) -> &NormalizedItem {
        &self.item
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn native_reference(&self) -> bool {
        matches!(self.action, Action::NativeReference { .. })
    }
    pub fn project_scoped(&self) -> bool {
        matches!(self.scope, ImportedContextScope::Project { .. })
    }
    fn revision(&self) -> String {
        match &self.action {
            Action::Skill { revision, .. } => revision.0.clone(),
            Action::PendingDefinition { .. } => self
                .pending_record()
                .unwrap()
                .digest()
                .expect("serializable passive definition"),
            _ => format!(
                "sha256:{:x}",
                Sha256::digest(
                    serde_json::to_vec(&self.action).expect("serializable private asset plan")
                )
            ),
        }
    }
}

pub struct AssetTarget {
    profile: PathBuf,
    directory: PrivateDirectory,
    identity: String,
}
impl AssetTarget {
    pub(crate) fn requested_fingerprint(
        item: &NormalizedItem,
        binding: &AssetBundleBinding,
        resolution: &AssetResolution,
    ) -> Result<String> {
        ensure!(
            !item
                .preview
                .issues
                .iter()
                .any(|issue| issue.blocks_import()),
            "migration_item_requires_resolution"
        );
        let candidate = item
            .asset
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_an_asset"))?;
        let source = binding.read(&candidate.entry)?;
        agents::validate_choice(item.preview.category, resolution)?;
        ensure!(
            !matches!(binding.category, Category::Agent | Category::Hook)
                || !resolution.enable_after_import,
            "migration_definition_cannot_activate"
        );
        asset_fingerprint(
            item.preview.category,
            &resolved_scope(item, binding, resolution)?,
            &resolution.target_name,
            resolution.enable_after_import && !source.native_reference,
            &agents::semantic_revision(&source.revision(), resolution.agent_adaptation.as_ref())?,
        )
    }
    pub(crate) fn observe(&self, plan: &AssetPlan) -> Result<Option<bool>> {
        self.check_binding(plan)?;
        match &plan.action {
            Action::Skill { name, revision, .. } => {
                if !self.skills_directory_exists()?
                    || self
                        .skills()?
                        .current_revision(name)
                        .map_err(skill_error)?
                        .as_ref()
                        != Some(revision)
                {
                    return Ok(None);
                }
                let disabled = kcoder_skills::activation::disabled(&self.profile)?;
                let imports = kcoder_skills::activation::enabled_imports(&self.profile)?;
                Ok(Some(
                    !disabled.contains(name)
                        && (plan.enabled
                            || imports.get(name).is_some_and(|token| token == plan.id())),
                ))
            }
            Action::Context { record } => {
                if record.kind == ImportedContextKind::Memory {
                    ImportedContextStore::open(&self.profile)?.verify_memory_scope(record)?;
                }
                let current = ImportedContextStore::open(&self.profile)?
                    .list()?
                    .into_iter()
                    .find(|current| current.id == record.id);
                let Some(mut current) = current else {
                    return Ok(None);
                };
                let enabled = current.enabled;
                current.enabled = record.enabled;
                Ok((current == *record).then_some(enabled))
            }
            Action::NativeReference { .. } => Ok(Some(true)),
            Action::PendingDefinition { binding, .. } => {
                crate::definition_assets::DefinitionStore::existing(&self.profile, binding)?
                    .observe(binding, &plan.pending_record().unwrap())
            }
        }
    }
    pub(crate) fn check_context_additions(&self, records: &[ImportedContext]) -> Result<()> {
        if records.is_empty() {
            return Ok(());
        }
        self.current_profile()?;
        ImportedContextStore::open(&self.profile)?
            .check_additions(records)
            .map_err(|_| anyhow::anyhow!("migration_context_capacity_or_conflict"))
    }
    pub fn open(profile: &Path) -> Result<Self> {
        let directory = PrivateDirectory::open_existing(profile)?;
        directory.verify_trusted_config_directory()?;
        let profile = profile.canonicalize()?;
        ensure!(
            PrivateDirectory::open_existing(&profile)?.directory_identity()?
                == directory.directory_identity()?,
            "migration_target_changed"
        );
        let identity = directory.directory_identity()?;
        Ok(Self {
            profile,
            directory,
            identity,
        })
    }
    fn target_id(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(self.profile.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(self.identity.as_bytes());
        format!("assets-{:x}", hash.finalize())
    }
    fn current_profile(&self) -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(&self.profile)?.directory_identity()? == self.identity,
            "migration_target_changed"
        );
        self.directory.verify_trusted_config_directory()?;
        Ok(())
    }
    pub(crate) fn check_binding(&self, plan: &AssetPlan) -> Result<()> {
        self.current_profile()?;
        ensure!(plan.target_id == self.target_id(), "migration_wrong_target");
        Ok(())
    }
    pub fn prepare(
        &self,
        item: &NormalizedItem,
        binding: &AssetBundleBinding,
        resolution: &AssetResolution,
    ) -> Result<AssetPlan> {
        self.current_profile()?;
        agents::validate_choice(item.preview.category, resolution)?;
        if binding.is_scoped_instruction() {
            return self.prepare_scoped_instruction(item, binding, resolution);
        }
        let scope = resolved_scope(item, binding, resolution)?;
        let memory_workspace_identity = if binding.category == Category::Memory {
            ImportedContextStore::open(&self.profile)?.capture_memory_workspace(&scope)?
        } else {
            None
        };
        ensure!(
            item.preview.id == resolution.item_id && item.preview.category == binding.category,
            "migration_unknown_item"
        );
        ensure!(
            !item
                .preview
                .issues
                .iter()
                .any(|issue| issue.blocks_import()),
            "migration_item_requires_resolution"
        );
        let candidate = item
            .asset
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_an_asset"))?;
        let source = binding.read(&candidate.entry)?;
        agents::validate_choice(item.preview.category, resolution)?;
        let source_revision = Some(source.revision());
        let original = source
            .files
            .iter()
            .find(|file| {
                file.relative_path
                    == Path::new(if binding.category == Category::Skill {
                        "SKILL.md"
                    } else {
                        &source.key
                    })
            })
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        let original_entry = EncodedFile {
            path: original.relative_path.clone(),
            data: STANDARD.encode(&original.content),
            executable: original.executable,
        };
        let imported_sources = if binding.category == Category::Instructions {
            source
                .files
                .iter()
                .filter(|file| file.relative_path != original.relative_path)
                .map(|file| EncodedFile {
                    path: file.relative_path.clone(),
                    data: STANDARD.encode(&file.content),
                    executable: false,
                })
                .collect()
        } else {
            Vec::new()
        };
        ensure!(
            !resolution.target_name.trim().is_empty()
                && resolution.target_name.trim() == resolution.target_name
                && resolution.target_name.len() <= 256
                && !resolution.target_name.chars().any(char::is_control),
            "migration_invalid_asset_name"
        );
        let plan_id = format!("plan-{}", uuid::Uuid::new_v4().simple());
        let action = match binding.category {
            Category::Agent if resolution.agent_adaptation.is_some() => {
                self.adapt_agent(binding, resolution, &original.content, &plan_id, &scope)?
            }
            Category::Agent | Category::Hook => {
                ensure!(
                    !resolution.enable_after_import,
                    "migration_definition_cannot_activate"
                );
                ensure!(
                    source.files.len() == 1,
                    "migration_definition_single_file_required"
                );
                let format = crate::definition_adapter::format(binding.kind, binding.category)?;
                let record = crate::definition_assets::DefinitionRecord {
                    id: format!("def-{}", uuid::Uuid::new_v4().simple()),
                    operation_id: plan_id.clone(),
                    name: resolution.target_name.clone(),
                    scope: scope.clone(),
                    source: binding.kind,
                    source_revision: source.revision(),
                    report: crate::definition_adapter::report(format, &original.content),
                    data: String::new(),
                };
                let (store, storage) =
                    crate::definition_assets::DefinitionStore::for_plan(&self.profile)?;
                store.check_name(&storage, &record)?;
                Action::PendingDefinition {
                    binding: Box::new(storage),
                    record: Box::new(record),
                }
            }
            Category::Skill | Category::Command => {
                ensure!(
                    !resolution.enable_after_import
                        || !kcoder_skills::activation::disabled(&self.profile)?
                            .contains(&resolution.target_name),
                    "migration_asset_activation_conflict"
                );
                if self.skills_directory_exists()? {
                    ensure!(
                        self.skills()?
                            .current_revision(&resolution.target_name)
                            .map_err(skill_error)?
                            .is_none(),
                        "migration_target_conflict"
                    );
                }
                let package = crate::asset_adapter::skill_package(
                    &source,
                    binding.category,
                    &resolution.target_name,
                    &plan_id,
                    resolution.enable_after_import,
                    &binding.scope,
                )?;
                let revision =
                    kcoder_skills::canonical_package_revision(&package).map_err(skill_error)?;
                let files = package
                    .files
                    .into_iter()
                    .map(|file| EncodedFile {
                        path: file.relative_path,
                        data: STANDARD.encode(file.content),
                        executable: file.executable,
                    })
                    .collect();
                Action::Skill {
                    name: package.name,
                    files,
                    revision,
                }
            }
            Category::Instructions | Category::Memory => {
                if source.native_reference {
                    let path = binding.source_path(&candidate.entry)?;
                    let ImportedContextScope::Project { root } = &binding.scope else {
                        anyhow::bail!("migration_invalid_asset_scope")
                    };
                    ensure!(
                        kcoder_config::try_discover_project_md(root)?
                            .iter()
                            .any(|native| native == &path),
                        "migration_asset_semantics_require_review"
                    );
                    Action::NativeReference { path }
                } else {
                    let store = ImportedContextStore::open(&self.profile)?;
                    ensure!(
                        !store
                            .list()?
                            .iter()
                            .any(|record| record.name == resolution.target_name
                                && record.scope == scope),
                        "migration_target_conflict"
                    );
                    let content = if binding.category == Category::Memory {
                        crate::asset_adapter::memory_text(&source)?
                    } else {
                        crate::asset_adapter::context_text(&source)?
                    };
                    let record = ImportedContext {
                        id: format!("ctx-{}", uuid::Uuid::new_v4().simple()),
                        operation_id: plan_id.clone(),
                        name: resolution.target_name.clone(),
                        kind: if binding.category == Category::Memory {
                            ImportedContextKind::Memory
                        } else {
                            ImportedContextKind::Instructions
                        },
                        scope: scope.clone(),
                        content,
                        enabled: resolution.enable_after_import,
                        memory_provenance: binding.memory_provenance(&source)?.map(Box::new),
                        memory_workspace_identity,
                        instruction_provenance: None,
                    };
                    Action::Context { record }
                }
            }
            _ => anyhow::bail!("migration_not_an_asset"),
        };
        let mut item = item.clone();
        if resolution.agent_adaptation.is_some() {
            item.preview.issues.retain(|issue| {
                !(issue.code == kcoder_types::migration::MigrationIssueCode::RequiresReview
                    && issue.phase == kcoder_types::migration::MigrationIssuePhase::Activation
                    && issue.field.as_deref() == Some("passive_definition"))
            });
        }
        item.preview.status = Status::Staged;
        let enabled = if matches!(action, Action::NativeReference { .. }) {
            true
        } else {
            resolution.enable_after_import
        };
        let plan = AssetPlan {
            agent_adaptation: resolution.agent_adaptation.clone(),
            adapted_agent_report: resolution.agent_adaptation.as_ref().map(|_| {
                crate::definition_adapter::report(
                    crate::definition_adapter::format(binding.kind, binding.category)
                        .expect("validated Agent format"),
                    &original.content,
                )
            }),
            plan_id,
            target_id: self.target_id(),
            name: resolution.target_name.clone(),
            enabled,
            item,
            scope,
            original_entry,
            imported_sources,
            source_revision,
            action,
        };
        // The prepared source preview must remain readable after the source disappears.
        if plan.definition_report().is_none() {
            plan.original_text()?;
        }
        Ok(plan)
    }
    fn skills_directory_exists(&self) -> Result<bool> {
        match self.directory.open_child(OsStr::new("skills"), false) {
            Ok(directory) => {
                directory.verify_trusted_config_directory()?;
                Ok(true)
            }
            Err(error)
                if error.chain().any(|error| {
                    error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                Ok(false)
            }
            Err(_) => anyhow::bail!("migration_target_changed"),
        }
    }
    fn skills(&self) -> Result<SkillStore> {
        self.current_profile()?;
        if !self.skills_directory_exists()? {
            self.directory.create_private_child(OsStr::new("skills"))?;
        }
        SkillStore::open(&self.profile.join("skills")).map_err(skill_error)
    }
    pub(crate) fn publish(
        &self,
        plan: &AssetPlan,
        cancelled: bool,
        source_blocked: bool,
    ) -> Result<crate::providers::ProviderPublication> {
        self.check_binding(plan)?;
        match &plan.action {
            Action::Skill {
                name,
                files,
                revision,
            } => {
                let store = self.skills()?;
                if let Some(receipt) = store.receipt(plan.id()).map_err(skill_error)? {
                    ensure!(
                        receipt
                            .after
                            .iter()
                            .any(|item| &item.name == name
                                && item.revision.as_ref() == Some(revision)),
                        "migration_receipt_conflict"
                    );
                    ensure!(
                        store.current_revision(name).map_err(skill_error)?.as_ref()
                            == Some(revision),
                        "migration_target_changed"
                    );
                } else {
                    ensure!(!cancelled, "migration_cancelled_unsettled_publication");
                    ensure!(!source_blocked, "migration_source_changed");
                    let package = SkillPackage {
                        name: name.clone(),
                        files: files
                            .iter()
                            .map(|file| {
                                Ok(SkillPackageFile {
                                    relative_path: file.path.clone(),
                                    content: STANDARD
                                        .decode(&file.data)
                                        .map_err(|_| anyhow::anyhow!("migration_plan_changed"))?,
                                    executable: file.executable,
                                })
                            })
                            .collect::<Result<_>>()?,
                    };
                    ensure!(
                        kcoder_skills::canonical_package_revision(&package).map_err(skill_error)?
                            == *revision,
                        "migration_plan_changed"
                    );
                    store
                        .commit(skill_request(
                            plan.id(),
                            SkillOperationKind::Install,
                            SkillMutation::PutPackage {
                                package,
                                expected: ExpectedSkillRevision::Absent,
                            },
                        ))
                        .map_err(skill_error)?;
                }
            }
            Action::Context { record } => {
                let store = ImportedContextStore::open(&self.profile)?;
                if let Some(current) = store
                    .list()?
                    .into_iter()
                    .find(|current| current.id == record.id)
                {
                    ensure!(current == *record, "migration_target_changed");
                } else {
                    ensure!(!cancelled, "migration_cancelled_unsettled_publication");
                    ensure!(!source_blocked, "migration_source_changed");
                    store.create(record.clone())?;
                }
            }
            Action::NativeReference { .. } => {
                ensure!(!source_blocked, "migration_source_changed");
            }
            Action::PendingDefinition { binding, .. } => {
                crate::definition_assets::DefinitionStore::existing(&self.profile, binding)?
                    .publish(
                        binding,
                        &plan.pending_record().unwrap(),
                        cancelled,
                        source_blocked,
                    )?
            }
        }
        Ok(crate::providers::ProviderPublication {
            target_id: plan.target_id.clone(),
            target_revision: plan.revision(),
            ownership_confirmed: !plan.native_reference(),
        })
    }
    pub(crate) fn rollback(&self, plan: &AssetPlan) -> Result<()> {
        self.check_binding(plan)?;
        match &plan.action {
            Action::Skill { name, revision, .. } => {
                let store = self.skills()?;
                let operation = format!("undo-{}", plan.id());
                if store.receipt(&operation).map_err(skill_error)?.is_some() {
                    return Ok(());
                }
                ensure!(
                    store.current_revision(name).map_err(skill_error)?.as_ref() == Some(revision),
                    "migration_target_changed"
                );
                store
                    .commit(skill_request(
                        &operation,
                        SkillOperationKind::Archive,
                        SkillMutation::Archive {
                            name: name.clone(),
                            expected: revision.clone(),
                            archive_name: format!(
                                "import-{}",
                                plan.id().trim_start_matches("plan-")
                            ),
                        },
                    ))
                    .map_err(skill_error)?;
            }
            Action::Context { record } => ImportedContextStore::open(&self.profile)?
                .remove_owned(record)
                .map_err(|_| anyhow::anyhow!("migration_target_changed"))?,
            Action::NativeReference { .. } => {}
            Action::PendingDefinition { binding, .. } => {
                crate::definition_assets::DefinitionStore::existing(&self.profile, binding)?
                    .rollback(binding, &plan.pending_record().unwrap())?
            }
        }
        Ok(())
    }
}
pub(crate) fn resolved_scope(
    item: &NormalizedItem,
    binding: &AssetBundleBinding,
    resolution: &AssetResolution,
) -> Result<ImportedContextScope> {
    if binding.is_scoped_instruction() {
        ensure!(
            resolution.memory_scope.is_none(),
            "migration_invalid_asset_scope"
        );
        let entry = &item
            .asset
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_an_asset"))?
            .entry;
        return Ok(binding.scoped_instruction_target(entry)?.scope());
    }
    if binding.category == Category::Memory {
        ensure!(
            !resolution.enable_after_import,
            "migration_memory_activate_separately"
        );
        return resolution
            .memory_scope
            .clone()
            .ok_or_else(|| anyhow::anyhow!("migration_memory_scope_required"));
    }
    ensure!(
        resolution.memory_scope.is_none(),
        "migration_invalid_asset_scope"
    );
    Ok(binding.scope.clone())
}

fn asset_fingerprint(
    category: Category,
    scope: &ImportedContextScope,
    name: &str,
    enabled: bool,
    revision: &str,
) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            category, scope, name, enabled, revision
        ))?)
    ))
}
fn skill_request(
    id: &str,
    operation: SkillOperationKind,
    mutation: SkillMutation,
) -> SkillCommitRequest {
    SkillCommitRequest {
        operation_id: id.into(),
        actor: SkillMutationActor::System {
            component: "migration".into(),
            session_id: None,
        },
        operation,
        preconditions: Vec::new(),
        mutations: vec![mutation],
        metadata: Default::default(),
    }
}
fn skill_error(_: kcoder_skills::SkillStoreError) -> anyhow::Error {
    anyhow::anyhow!("migration_skill_store_conflict_or_unavailable")
}
