//! Read-only receipt catalog; entries are candidates, not installed or revalidated payloads.
mod asset;
mod binding;
mod history;
mod instructions;
mod inventory;
mod plugin;
pub(crate) use inventory::ReceivedProjectInventoryBinding;
mod project;
pub use asset::ReceivedAssetBinding;
pub(crate) use history::ReceivedHistoryBinding;
pub(crate) use instructions::ReceivedInstructionGraphBinding;
pub(crate) use plugin::ReceivedPluginArchive;
pub use project::ReceivedProjectTarget;

use super::*;
use kcoder_types::migration::{MigrationCategory, MigrationSourceKind};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceivedSourceClass {
    Project,
    Instructions,
    Plugin,
    Configuration,
    WorkAsset,
    History,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedSourceSummary {
    pub entry_id: String,
    pub source: MigrationSourceKind,
    pub class: ReceivedSourceClass,
    pub category: Option<MigrationCategory>,
    /// Provenance only. A source project path never authorizes a destination path.
    pub project_scoped: bool,
    pub files: u32,
    pub bytes: u64,
    pub project: Option<kcoder_types::migration_projects::MigrationProjectReceivedMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedSourcePage {
    pub receipt: TransferReceipt,
    pub items: Vec<ReceivedSourceSummary>,
    pub total_sources: u32,
    pub next_page: Option<u32>,
}

fn same_asset_group(first: &TransferContent, next: &TransferContent) -> bool {
    match (first, next) {
        (
            TransferContent::WorkAsset {
                source: a,
                source_identity: i,
                category: b,
                scope: c,
                asset: d,
                source_revision: e,
                memory_provenance: f,
                ..
            },
            TransferContent::WorkAsset {
                source: x,
                source_identity: j,
                category: y,
                scope: z,
                asset: w,
                source_revision: v,
                memory_provenance: w_origin,
                ..
            },
        ) => a == x && b == y && c == z && d == w && e == v && i == j && f == w_origin,
        _ => false,
    }
}

impl IncomingTransfers {
    /// Restores authority from the original private target grant. No source
    /// connection, native identity creation, publication, or whole-payload hash.
    pub fn received_sources(
        &self,
        request_id: &str,
        expected_manifest: &str,
        page_index: u32,
    ) -> Result<ReceivedSourcePage> {
        ensure!(page_index <= 102, "source_transfer_invalid_page");
        let grant = self.recover_target(request_id)?;
        let source = grant.source_authority();
        let receipt = self
            .receipt(request_id, source)?
            .context("source_transfer_not_ready")?;
        ensure!(
            receipt.manifest_sha256 == expected_manifest,
            "source_transfer_receipt_changed"
        );
        let (_, manifest) = self.ready(request_id, source, &receipt)?;
        let mut groups: BTreeMap<&str, (&TransferContent, ReceivedSourceSummary)> = BTreeMap::new();
        for entry in &manifest.entries {
            // Manifest validation has already established the ten-byte entry ID.
            let group = &entry.id[..6];
            if let Some((first, summary)) = groups.get_mut(group) {
                ensure!(
                    same_asset_group(first, &entry.content),
                    "source_transfer_source_group_changed"
                );
                summary.files += 1;
                summary.bytes = summary
                    .bytes
                    .checked_add(entry.bytes)
                    .context("source_transfer_budget_exceeded")?;
                continue;
            }
            let (source, class, category, project_scoped) = match &entry.content {
                TransferContent::ProjectInventory { source, .. } => (
                    *source,
                    ReceivedSourceClass::Project,
                    Some(MigrationCategory::Project),
                    false,
                ),
                TransferContent::InstructionBundle { source, .. } => (
                    *source,
                    ReceivedSourceClass::Instructions,
                    Some(MigrationCategory::Instructions),
                    true,
                ),
                TransferContent::PluginPackage { origin, .. } => (
                    origin.source,
                    ReceivedSourceClass::Plugin,
                    Some(MigrationCategory::Plugin),
                    matches!(origin.scope.as_str(), "project" | "local"),
                ),
                TransferContent::ConfigurationInventory {
                    source,
                    source_scope,
                    ..
                } => (
                    *source,
                    ReceivedSourceClass::Configuration,
                    None,
                    configuration_project_scoped(source_scope),
                ),
                TransferContent::WorkAsset {
                    source,
                    category,
                    scope,
                    ..
                } => (
                    *source,
                    ReceivedSourceClass::WorkAsset,
                    Some(*category),
                    matches!(
                        scope,
                        kcoder_config::imported_context::ImportedContextScope::Project { .. }
                    ),
                ),
                TransferContent::History { snapshot, .. } => (
                    snapshot.origin.source,
                    ReceivedSourceClass::History,
                    Some(MigrationCategory::History),
                    snapshot.origin.project.is_some(),
                ),
            };
            groups.insert(
                group,
                (
                    &entry.content,
                    ReceivedSourceSummary {
                        entry_id: entry.id.clone(),
                        source,
                        class,
                        category,
                        project_scoped,
                        files: 1,
                        bytes: entry.bytes,
                        project: match &entry.content {
                            TransferContent::ProjectInventory { metadata, .. } => {
                                Some(metadata.clone())
                            }
                            _ => None,
                        },
                    },
                ),
            );
        }
        let total_sources = groups.len() as u32;
        let start = page_index as usize * 10;
        ensure!(
            start < groups.len() || start == 0,
            "source_transfer_invalid_page"
        );
        let items = groups
            .into_values()
            .skip(start)
            .take(10)
            .map(|(_, item)| item)
            .collect::<Vec<_>>();
        let next_page = (start + items.len() < total_sources as usize).then_some(page_index + 1);
        Ok(ReceivedSourcePage {
            receipt,
            items,
            total_sources,
            next_page,
        })
    }
}
