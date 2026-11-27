//! Live source grants become a small same-job immutable recipe before journal publication.
use super::artifact::InstructionArtifactReference;
use crate::instruction_sources::{
    InstructionDisposition, InstructionRole, InstructionSourceSnapshot, InstructionSourceSummary,
    InstructionTrigger, ScopedInstructionDestination,
};
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path, sync::Arc};

/// This is an internal Native construction. The source registry owns the live
/// snapshot; public RPC selections must resolve into it before calling capture.
#[derive(Clone)]
pub(crate) struct LiveInstructionBinding {
    snapshot: Arc<InstructionSourceSnapshot>,
    semantic_revision: String,
    mapping: BTreeMap<String, ScopedInstructionDestination>,
    static_subset_confirmed: bool,
}
impl std::fmt::Debug for LiveInstructionBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveInstructionBinding")
            .finish_non_exhaustive()
    }
}
impl PartialEq for LiveInstructionBinding {
    fn eq(&self, other: &Self) -> bool {
        self.semantic_revision == other.semantic_revision
            && self.mapping == other.mapping
            && self.static_subset_confirmed == other.static_subset_confirmed
    }
}
impl Eq for LiveInstructionBinding {}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapturedItem {
    id: String,
    relative_path: String,
    relative_scope: String,
    role: InstructionRole,
    trigger: InstructionTrigger,
    disposition: InstructionDisposition,
    bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason_code: Option<String>,
}
impl From<InstructionSourceSummary> for CapturedItem {
    fn from(value: InstructionSourceSummary) -> Self {
        Self {
            id: value.id,
            relative_path: value.relative_path,
            relative_scope: value.relative_scope,
            role: value.role,
            trigger: value.trigger,
            disposition: value.disposition,
            bytes: value.bytes,
            reason_code: value.reason_code,
        }
    }
}
impl CapturedItem {
    fn summary(&self) -> InstructionSourceSummary {
        InstructionSourceSummary {
            id: self.id.clone(),
            relative_path: self.relative_path.clone(),
            relative_scope: self.relative_scope.clone(),
            role: self.role,
            trigger: self.trigger,
            disposition: self.disposition,
            bytes: self.bytes,
            reason_code: self.reason_code.clone(),
        }
    }
}

/// No source body or live source pathname is in the ordinary journal binding.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenInstructionBinding {
    version: u32,
    source: MigrationSourceKind,
    semantic_revision: String,
    artifact: InstructionArtifactReference,
    mapping: BTreeMap<String, ScopedInstructionDestination>,
    items: Vec<CapturedItem>,
    complete_launch_chain: bool,
    dynamic_scope_present: bool,
    static_subset_confirmed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format_revision: Option<String>,
}
impl std::fmt::Debug for FrozenInstructionBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FrozenInstructionBinding")
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    content = "recipe",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(crate) enum InstructionBinding {
    /// A live grant cannot be smuggled into a persisted or received Native binding.
    #[serde(skip)]
    Granted(Arc<LiveInstructionBinding>),
    Captured(Box<FrozenInstructionBinding>),
}
impl std::fmt::Debug for InstructionBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InstructionBinding").finish_non_exhaustive()
    }
}

impl LiveInstructionBinding {
    pub(crate) fn capture(
        snapshot: Arc<InstructionSourceSnapshot>,
        mapping: BTreeMap<String, ScopedInstructionDestination>,
        profile: &Path,
        static_subset_confirmed: bool,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<Self> {
        snapshot.verify_consumer(profile)?;
        snapshot.verify_source(&mut check)?;
        ensure!(
            !mapping.is_empty() && mapping.len() <= 128,
            "migration_instruction_selection_invalid"
        );
        ensure!(
            snapshot.complete_launch_chain() || static_subset_confirmed,
            "migration_instruction_static_subset_confirmation_required"
        );
        let summaries = snapshot.summaries();
        for (id, target) in &mapping {
            ensure!(
                summaries.iter().any(|item| &item.id == id),
                "migration_unknown_item"
            );
            target.verify(profile)?;
        }
        let semantic_revision = snapshot.semantic_revision()?;
        Ok(Self {
            snapshot,
            semantic_revision,
            mapping,
            static_subset_confirmed,
        })
    }
    pub(crate) fn freeze(
        &self,
        directory: &PrivateDirectory,
        profile: &Path,
        job_id: &str,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<FrozenInstructionBinding> {
        self.snapshot.verify_consumer(profile)?;
        self.snapshot.verify_source(&mut check)?;
        for target in self.mapping.values() {
            target.verify(profile)?;
        }
        let artifact = InstructionArtifactReference::publish(
            directory,
            profile,
            job_id,
            &self.snapshot,
            || check(0),
        )?;
        let items = self
            .snapshot
            .summaries()
            .into_iter()
            .filter(|item| self.mapping.contains_key(&item.id))
            .map(CapturedItem::from)
            .collect();
        Ok(FrozenInstructionBinding {
            version: 1,
            source: self.snapshot.source(),
            semantic_revision: self.semantic_revision.clone(),
            artifact,
            mapping: self.mapping.clone(),
            items,
            complete_launch_chain: self.snapshot.complete_launch_chain(),
            dynamic_scope_present: self.snapshot.dynamic_scope_present(),
            static_subset_confirmed: self.static_subset_confirmed,
            format_revision: (self.snapshot.format_revision() == "scoped-instructions/v2")
                .then(|| "scoped-instructions/v2".into()),
        })
    }
}
impl FrozenInstructionBinding {
    pub(crate) fn open_snapshot(
        &self,
        parent: &PrivateDirectory,
        profile: &Path,
    ) -> Result<Arc<InstructionSourceSnapshot>> {
        let directory = self.artifact.open_directory(parent, profile)?;
        self.snapshot(&directory, profile, self.artifact.job_id())
    }
    pub(crate) fn target(&self, id: &str) -> Result<&ScopedInstructionDestination> {
        self.mapping
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))
    }
    pub(crate) fn summaries(&self) -> Result<Vec<InstructionSourceSummary>> {
        ensure!(
            self.version == 1
                && self
                    .format_revision
                    .as_deref()
                    .is_none_or(|value| value == "scoped-instructions/v2")
                && !self.items.is_empty()
                && self.items.len() <= 128
                && self.mapping.len() == self.items.len()
                && self
                    .items
                    .iter()
                    .all(|item| self.mapping.contains_key(&item.id)),
            "migration_instruction_artifact_invalid"
        );
        let ids = self
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<std::collections::BTreeSet<_>>();
        ensure!(
            ids.len() == self.items.len(),
            "migration_instruction_artifact_invalid"
        );
        Ok(self.items.iter().map(CapturedItem::summary).collect())
    }
    pub(crate) fn snapshot(
        &self,
        directory: &PrivateDirectory,
        profile: &Path,
        job_id: &str,
    ) -> Result<Arc<InstructionSourceSnapshot>> {
        let snapshot = self.artifact.read(directory, profile, job_id)?;
        ensure!(
            snapshot.source() == self.source
                && snapshot.format_revision()
                    == self
                        .format_revision
                        .as_deref()
                        .unwrap_or("scoped-instructions/v1")
                && snapshot.semantic_revision()? == self.semantic_revision
                && snapshot.complete_launch_chain() == self.complete_launch_chain
                && snapshot.dynamic_scope_present() == self.dynamic_scope_present,
            "migration_instruction_artifact_changed"
        );
        let selected = snapshot
            .summaries()
            .into_iter()
            .filter(|item| self.mapping.contains_key(&item.id))
            .map(CapturedItem::from)
            .collect::<Vec<_>>();
        ensure!(
            selected == self.items,
            "migration_instruction_artifact_changed"
        );
        self.summaries()?;
        Ok(Arc::new(snapshot))
    }
}

impl InstructionBinding {
    pub(crate) fn format_revision(&self) -> &str {
        match self {
            Self::Granted(live) => live.snapshot.format_revision(),
            Self::Captured(frozen) => frozen
                .format_revision
                .as_deref()
                .unwrap_or("scoped-instructions/v1"),
        }
    }
    pub(crate) fn captured_job_id(&self) -> Result<&str> {
        match self {
            Self::Granted(_) => anyhow::bail!("migration_instruction_capture_required"),
            Self::Captured(frozen) => Ok(frozen.artifact.job_id()),
        }
    }
    pub(crate) fn complete_launch_chain(&self) -> bool {
        match self {
            Self::Granted(live) => live.snapshot.complete_launch_chain(),
            Self::Captured(frozen) => frozen.complete_launch_chain,
        }
    }
    pub(crate) fn snapshot_in_profile(
        &self,
        profile: &Path,
    ) -> Result<Arc<InstructionSourceSnapshot>> {
        match self {
            Self::Granted(live) => Ok(live.snapshot.clone()),
            Self::Captured(frozen) => {
                let profile_directory = PrivateDirectory::open_existing(profile)?;
                profile_directory.verify_trusted_config_directory()?;
                let parent =
                    profile_directory.open_child(std::ffi::OsStr::new("migrations"), false)?;
                frozen.open_snapshot(&parent, profile)
            }
        }
    }
    pub(crate) fn verify_parent(&self, parent: &PrivateDirectory, profile: &Path) -> Result<()> {
        if let Self::Captured(frozen) = self {
            frozen.artifact.open_directory(parent, profile)?;
        }
        Ok(())
    }
    pub(crate) fn source(&self) -> MigrationSourceKind {
        match self {
            Self::Granted(live) => live.snapshot.source(),
            Self::Captured(frozen) => frozen.source,
        }
    }
    pub(crate) fn semantic_revision(&self) -> &str {
        match self {
            Self::Granted(live) => &live.semantic_revision,
            Self::Captured(frozen) => &frozen.semantic_revision,
        }
    }
    pub(crate) fn summaries(&self) -> Result<Vec<InstructionSourceSummary>> {
        match self {
            Self::Granted(live) => Ok(live
                .snapshot
                .summaries()
                .into_iter()
                .filter(|item| live.mapping.contains_key(&item.id))
                .collect()),
            Self::Captured(frozen) => frozen.summaries(),
        }
    }
    pub(crate) fn target(&self, id: &str) -> Result<&ScopedInstructionDestination> {
        match self {
            Self::Granted(live) => live
                .mapping
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item")),
            Self::Captured(frozen) => frozen.target(id),
        }
    }
    pub(crate) fn freeze(
        &self,
        directory: &PrivateDirectory,
        profile: &Path,
        job_id: &str,
        check: impl FnMut(u64) -> bool,
    ) -> Result<Self> {
        match self {
            Self::Granted(live) => live
                .freeze(directory, profile, job_id, check)
                .map(|frozen| Self::Captured(Box::new(frozen))),
            Self::Captured(frozen) => {
                ensure!(
                    frozen.artifact.job_id() == job_id,
                    "migration_instruction_wrong_capture_job"
                );
                frozen
                    .snapshot(directory, profile, job_id)?
                    .verify_source(check)?;
                Ok(self.clone())
            }
        }
    }
}
