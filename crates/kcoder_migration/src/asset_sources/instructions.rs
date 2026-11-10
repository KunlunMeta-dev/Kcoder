//! Explicit scoped instructions use the normal asset binding and the owning job's recipe.
use super::*;
use crate::{
    instruction_assets::binding::{InstructionBinding, LiveInstructionBinding},
    instruction_sources::{
        InstructionDestination, InstructionDisposition, InstructionSourceSnapshot,
        ScopedInstructionDestination,
    },
};
use std::{collections::BTreeMap, sync::Arc};

impl AssetBundleBinding {
    /// Native composition supplies the independently authorized destination, not a source path.
    pub fn capture_scoped_instructions(
        profile: &Path,
        authorized_workspace: &Path,
        snapshot: Arc<InstructionSourceSnapshot>,
        mapping: &[(String, String)],
        static_subset_confirmed: bool,
    ) -> Result<Self> {
        ensure!(
            !mapping.is_empty() && mapping.len() <= 128,
            "migration_instruction_selection_invalid"
        );
        let destination = InstructionDestination::capture(profile, authorized_workspace)?;
        let mut targets = BTreeMap::new();
        for (id, relative) in mapping {
            ensure!(
                targets
                    .insert(
                        id.clone(),
                        ScopedInstructionDestination::capture(&destination, relative)?
                    )
                    .is_none(),
                "migration_instruction_selection_invalid"
            );
        }
        Self::capture_mapped_instructions(
            profile,
            authorized_workspace,
            snapshot,
            &targets.into_iter().collect::<Vec<_>>(),
            static_subset_confirmed,
        )
    }
    /// Keep the physical directory selected during review across later confirmation/capture.
    pub fn capture_mapped_instructions(
        profile: &Path,
        authorized_workspace: &Path,
        snapshot: Arc<InstructionSourceSnapshot>,
        mapping: &[(String, ScopedInstructionDestination)],
        static_subset_confirmed: bool,
    ) -> Result<Self> {
        Self::capture_mapped_instructions_checked(
            profile,
            authorized_workspace,
            snapshot,
            mapping,
            static_subset_confirmed,
            |_| true,
        )
    }
    pub fn capture_mapped_instructions_checked(
        profile: &Path,
        authorized_workspace: &Path,
        snapshot: Arc<InstructionSourceSnapshot>,
        mapping: &[(String, ScopedInstructionDestination)],
        static_subset_confirmed: bool,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<Self> {
        ensure!(
            !mapping.is_empty() && mapping.len() <= 128,
            "migration_instruction_selection_invalid"
        );
        let destination = InstructionDestination::capture(profile, authorized_workspace)?;
        let mut targets = BTreeMap::new();
        for (id, target) in mapping {
            ensure!(check(0), "migration_cancelled");
            target.verify(profile)?;
            ensure!(
                target.destination() == &destination,
                "migration_instruction_target_changed"
            );
            ensure!(
                targets.insert(id.clone(), target.clone()).is_none(),
                "migration_instruction_selection_invalid"
            );
        }
        let live = LiveInstructionBinding::capture(
            snapshot.clone(),
            targets,
            profile,
            static_subset_confirmed,
            &mut check,
        )?;
        let instructions = InstructionBinding::Granted(Arc::new(live));
        Ok(Self {
            root: profile.canonicalize()?,
            identity: instructions.semantic_revision().into(),
            single: None,
            kind: snapshot.source(),
            category: Category::Instructions,
            scope: ImportedContextScope::Project {
                root: authorized_workspace.canonicalize()?,
            },
            fingerprints: Default::default(),
            received: None,
            selected_root: None,
            memory: None,
            definition_hooks: None,
            definition_project: None,
            instructions: Some(Box::new(instructions)),
        })
    }
    pub(crate) fn is_scoped_instruction(&self) -> bool {
        self.instructions.is_some()
    }
    pub(super) fn checked_instructions(&self) -> Result<&InstructionBinding> {
        let binding = self
            .instructions
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_scoped_instructions"))?;
        ensure!(
            self.category == Category::Instructions
                && self.kind == binding.source()
                && self.identity == binding.semantic_revision()
                && self.single.is_none()
                && matches!(self.scope, ImportedContextScope::Project { .. })
                && self.received.is_none()
                && self.selected_root.is_none()
                && self.memory.is_none()
                && self.definition_hooks.is_none()
                && self.definition_project.is_none(),
            "migration_invalid_source_binding"
        );
        Ok(binding)
    }
    pub(crate) fn scoped_instruction_snapshot(
        &self,
    ) -> Result<Option<Arc<InstructionSourceSnapshot>>> {
        if self.instructions.is_none() {
            return Ok(None);
        }
        self.checked_instructions()?
            .snapshot_in_profile(&self.root)
            .map(Some)
    }
    pub(crate) fn scoped_instruction_target(
        &self,
        entry: &str,
    ) -> Result<&ScopedInstructionDestination> {
        self.checked_instructions()?.target(entry)
    }
    pub(crate) fn instruction_capture_job_id(&self) -> Result<&str> {
        self.checked_instructions()?.captured_job_id()
    }
    pub(crate) fn scoped_instruction_profile(&self) -> Result<&Path> {
        self.checked_instructions()?;
        Ok(&self.root)
    }
    pub(crate) fn freeze_in_job(
        &self,
        directory: &PrivateDirectory,
        profile: &Path,
        job_id: &str,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<(Self, MigrationInventory)> {
        let binding = self.checked_instructions()?;
        ensure!(
            self.root == profile.canonicalize()?,
            "migration_wrong_target"
        );
        let frozen = binding.freeze(directory, profile, job_id, &mut check)?;
        let mut result = self.clone();
        result.instructions = Some(Box::new(frozen));
        let inventory = result.scoped_instruction_inventory()?;
        Ok((result, inventory))
    }
    pub(crate) fn verify_instruction_parent(&self, parent: &PrivateDirectory) -> Result<()> {
        if self.instructions.is_none() {
            return Ok(());
        }
        self.checked_instructions()?
            .verify_parent(parent, &self.root)
    }
    pub(super) fn scoped_instruction_inventory(&self) -> Result<MigrationInventory> {
        let binding = self.checked_instructions()?;
        let complete = binding.complete_launch_chain();
        let summaries = binding.summaries()?;
        ensure!(
            summaries.iter().all(|row| row.bytes <= 4 * 1024 * 1024),
            "migration_instruction_artifact_invalid"
        );
        let items = summaries
            .into_iter()
            .map(|source| {
                let compatible = source.disposition == InstructionDisposition::Selected && complete;
                let issues = if compatible {
                    Vec::new()
                } else {
                    vec![issue(
                        Code::RequiresReview,
                        Severity::Blocking,
                        "scoped_instruction_semantics",
                    )]
                };
                NormalizedItem {
                    preview: MigrationItemPreview {
                        id: source.id.clone(),
                        category: Category::Instructions,
                        source_name: source.relative_path.clone(),
                        status: if compatible {
                            Status::Discovered
                        } else {
                            Status::RequiresAction
                        },
                        selected_by_default: compatible,
                        issues,
                    },
                    provider: None,
                    mcp: None,
                    template: None,
                    asset: Some(AssetCandidate {
                        entry: source.id,
                        name: source
                            .relative_path
                            .trim_end_matches(".md")
                            .replace('/', "-"),
                        bytes: source.bytes as usize,
                        files: 1,
                        native_reference: false,
                    }),
                }
            })
            .collect();
        Ok(MigrationInventory {
            source: self.kind,
            adapter_revision: binding.format_revision().into(),
            items,
            issues: Vec::new(),
        })
    }
    pub(super) fn read_scoped_instruction(&self, key: &str) -> Result<SourceAsset> {
        let snapshot = self
            .scoped_instruction_snapshot()?
            .ok_or_else(|| anyhow::anyhow!("migration_not_scoped_instructions"))?;
        snapshot.verify_source(|_| true)?;
        let source = self
            .checked_instructions()?
            .summaries()?
            .into_iter()
            .find(|source| source.id == key)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        let content = snapshot.original_bytes(key)?;
        Ok(SourceAsset {
            key: key.into(),
            name: source
                .relative_path
                .trim_end_matches(".md")
                .replace('/', "-"),
            files: vec![kcoder_skills::SkillPackageFile {
                relative_path: key.into(),
                content: content.to_vec(),
                executable: false,
            }],
            native_reference: false,
        })
    }
}
