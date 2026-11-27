//! Only the known project projection is transferable. DB/WAL, trust and arbitrary metadata are not.
use super::{ProjectBatchSource, ProjectReadCancellation, ProjectRecord, is_absolute_source_root};
use anyhow::{Result, ensure};
use kcoder_types::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub(crate) const PROJECT_TRANSFER_FORMAT: &str = "kcoder-project-inventory/1";
pub(crate) const PROJECT_TRANSFER_MAX_BYTES: u64 = 128 * 1024;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectTransferSnapshot {
    pub version: u32,
    pub source: MigrationSourceKind,
    pub format_revision: String,
    pub logical_origin: String,
    pub record: ProjectRecord,
}
impl ProjectTransferSnapshot {
    pub(crate) fn capture(
        source: &ProjectBatchSource,
        cancel: &ProjectReadCancellation,
    ) -> Result<Self> {
        source.validate(cancel)?;
        let snapshot = Self {
            version: 1,
            source: source.source(),
            format_revision: source.format_revision().to_owned(),
            logical_origin: source.logical_identity(),
            record: source.record().clone(),
        };
        snapshot.validate()?;
        Ok(snapshot)
    }
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1,
            "source_transfer_project_format_unsupported"
        );
        let expected = match self.source {
            MigrationSourceKind::ClaudeCode => "claude-project-registry/json/1",
            MigrationSourceKind::Codex => "codex-project-registry/sqlite/1",
        };
        ensure!(
            self.format_revision == expected,
            "source_transfer_project_format_unsupported"
        );
        ensure!(
            self.logical_origin.len() == 64
                && self
                    .logical_origin
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "source_transfer_project_snapshot_changed"
        );
        let text = |value: &str, maximum: usize, empty: bool| {
            (empty || !value.is_empty())
                && value.len() <= maximum
                && !value.chars().any(char::is_control)
        };
        ensure!(
            text(&self.record.id, 256, false)
                && text(&self.record.name, 4096, true)
                && self.record.roots.len() <= 16,
            "source_transfer_project_snapshot_unsupported"
        );
        let mut roots = BTreeSet::new();
        for root in &self.record.roots {
            ensure!(
                text(root, 4096, false) && is_absolute_source_root(root) && roots.insert(root),
                "source_transfer_project_snapshot_unsupported"
            );
        }
        ensure!(
            serde_json::to_vec(self)?.len() as u64 <= PROJECT_TRANSFER_MAX_BYTES,
            "source_transfer_project_budget_exceeded"
        );
        Ok(())
    }
    pub(crate) fn bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        Ok(serde_json::to_vec(self)?)
    }
    pub(crate) fn metadata(
        &self,
    ) -> kcoder_types::migration_projects::MigrationProjectReceivedMetadata {
        use kcoder_types::migration_projects::*;
        MigrationProjectReceivedMetadata {
            display_name: self.display_name().to_owned(),
            label_origin: if self.source == MigrationSourceKind::ClaudeCode {
                MigrationProjectLabelOrigin::PathBasename
            } else if self.record.name.is_empty() {
                MigrationProjectLabelOrigin::OriginalId
            } else {
                MigrationProjectLabelOrigin::RegistryName
            },
            original_project_id: (self.source == MigrationSourceKind::Codex)
                .then(|| self.record.id.clone()),
            roots: self.record.roots.len() as u32,
            format_revision: self.format_revision.clone(),
        }
    }
    pub(crate) fn display_name(&self) -> &str {
        if self.record.name.is_empty() {
            &self.record.id
        } else {
            &self.record.name
        }
    }
}
