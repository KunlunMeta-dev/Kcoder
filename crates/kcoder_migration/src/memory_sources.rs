//! Known static memory layouts become inactive notes, never native verified facts or skills.
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::{
    imported_memory::{ImportedMemoryLayout, ImportedMemoryProvenance},
    migration::MigrationSourceKind,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, ffi::OsStr, time::UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemoryFileStamp {
    bytes: u64,
    modified_at_ms: Option<u64>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemorySourceBinding {
    version: u32,
    layout: ImportedMemoryLayout,
    group: String,
    files: BTreeMap<String, MemoryFileStamp>,
}
impl std::fmt::Debug for MemorySourceBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemorySourceBinding")
            .field("layout", &self.layout)
            .field("files", &self.files.len())
            .finish_non_exhaustive()
    }
}

impl MemorySourceBinding {
    pub(crate) fn capture(
        directory: &PrivateDirectory,
        layout: ImportedMemoryLayout,
        group: String,
    ) -> Result<Self> {
        ensure!(
            !group.is_empty() && group.len() <= 256 && !group.chars().any(char::is_control),
            "migration_memory_layout_unsupported"
        );
        ensure!(
            matches!(
                layout,
                ImportedMemoryLayout::ClaudeAutoMemoryV1 | ImportedMemoryLayout::CodexMemoryFilesV1
            ),
            "migration_memory_layout_unsupported"
        );
        let mut files = BTreeMap::new();
        directory.visit_entry_names_bounded(512, |name| {
            let name = name
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("migration_memory_layout_unsupported"))?;
            if name == "rollout_summaries" && layout == ImportedMemoryLayout::CodexMemoryFilesV1 {
                let child = directory.open_child(OsStr::new(name), false)?;
                child.visit_entry_names_bounded(256, |leaf| {
                    let leaf = leaf
                        .to_str()
                        .ok_or_else(|| anyhow::anyhow!("migration_memory_layout_unsupported"))?;
                    if leaf.ends_with(".md") {
                        insert(
                            &child,
                            leaf,
                            &format!("rollout_summaries/{leaf}"),
                            &mut files,
                        )?;
                    }
                    Ok(())
                })?;
            } else if (layout == ImportedMemoryLayout::ClaudeAutoMemoryV1 && name.ends_with(".md"))
                || (layout == ImportedMemoryLayout::CodexMemoryFilesV1
                    && ["MEMORY.md", "memory_summary.md", "raw_memories.md"].contains(&name))
            {
                insert(directory, name, name, &mut files)?;
            }
            Ok(())
        })?;
        ensure!(
            !files.is_empty() && files.len() <= 128,
            "migration_memory_source_empty_or_over_budget"
        );
        ensure!(
            files.values().map(|file| file.bytes).sum::<u64>() <= 32 * 1024 * 1024,
            "migration_asset_budget_exceeded"
        );
        Ok(Self {
            version: 1,
            layout,
            group,
            files,
        })
    }

    pub(crate) fn verify(&self, directory: &PrivateDirectory) -> Result<()> {
        ensure!(
            self.version == 1
                && Self::capture(directory, self.layout, self.group.clone())? == *self,
            "migration_source_changed"
        );
        Ok(())
    }
    pub(crate) fn entries(&self) -> Vec<String> {
        self.files.keys().cloned().collect()
    }
    pub(crate) fn verify_file(&self, directory: &PrivateDirectory, key: &str) -> Result<()> {
        let expected = self
            .files
            .get(key)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        let (parent, leaf) = match key.strip_prefix("rollout_summaries/") {
            Some(leaf) => (
                Some(directory.open_child(OsStr::new("rollout_summaries"), false)?),
                leaf,
            ),
            None => (None, key),
        };
        let parent = parent.as_ref().unwrap_or(directory);
        ensure!(
            &stamp(parent, leaf)? == expected,
            "migration_source_changed"
        );
        Ok(())
    }
    pub(crate) fn provenance(
        &self,
        source: MigrationSourceKind,
        key: &str,
        revision: String,
    ) -> Result<ImportedMemoryProvenance> {
        ensure!(
            matches!(
                (source, self.layout),
                (
                    MigrationSourceKind::ClaudeCode,
                    ImportedMemoryLayout::ClaudeAutoMemoryV1
                ) | (
                    MigrationSourceKind::Codex,
                    ImportedMemoryLayout::CodexMemoryFilesV1
                )
            ),
            "migration_invalid_source_binding"
        );
        let file = self
            .files
            .get(key)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        Ok(ImportedMemoryProvenance {
            source,
            layout: self.layout,
            source_group: self.group.clone(),
            source_file: key.into(),
            source_revision: revision,
            source_modified_at_ms: file.modified_at_ms,
            facts_verified: false,
            migration_job_id: None,
        })
    }
    pub(crate) fn layout(&self) -> ImportedMemoryLayout {
        self.layout
    }
    pub(crate) fn group(&self) -> &str {
        &self.group
    }
}

fn stamp(parent: &PrivateDirectory, leaf: &str) -> Result<MemoryFileStamp> {
    ensure!(
        !leaf.is_empty()
            && leaf.len() <= 256
            && !leaf.contains(['/', '\\'])
            && !leaf.chars().any(char::is_control),
        "migration_unsafe_source_path"
    );
    let file = parent.open_single_link_regular_file(OsStr::new(leaf))?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.len() <= 4 * 1024 * 1024,
        "migration_asset_budget_exceeded"
    );
    Ok(MemoryFileStamp {
        bytes: metadata.len(),
        modified_at_ms: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| duration.as_millis().try_into().ok()),
    })
}
fn insert(
    parent: &PrivateDirectory,
    leaf: &str,
    key: &str,
    files: &mut BTreeMap<String, MemoryFileStamp>,
) -> Result<()> {
    ensure!(files.len() < 128, "migration_asset_budget_exceeded");
    files.insert(key.into(), stamp(parent, leaf)?);
    Ok(())
}
