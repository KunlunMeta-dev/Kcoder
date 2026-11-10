//! Static source bytes stay bound to their original receiving receipt and consumer.
use super::super::*;
use super::{binding::ReceivedBinding, project::ReceivedProjectTarget};
use crate::asset_sources::{AssetBundleBinding, SourceAsset};
use kcoder_config::imported_context::ImportedContextScope;
use kcoder_types::migration::{MigrationCategory, MigrationSourceKind};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceivedAssetBinding {
    binding: ReceivedBinding,
    project: Option<ReceivedProjectTarget>,
}
impl IncomingTransfers {
    pub fn received_asset_binding(
        &self,
        request: &str,
        manifest_sha256: &str,
        entry_id: &str,
        project: Option<ReceivedProjectTarget>,
    ) -> Result<AssetBundleBinding> {
        let value = ReceivedAssetBinding {
            binding: self.received_binding(request, manifest_sha256, entry_id)?,
            project,
        };
        let (_, _, scope, _) = value.metadata()?;
        let TransferContent::WorkAsset {
            scope: original, ..
        } = &value.binding.entry().content
        else {
            anyhow::bail!("source_transfer_not_work_asset")
        };
        ensure!(
            matches!(original, ImportedContextScope::Project { .. })
                == matches!(scope, ImportedContextScope::Project { .. }),
            "source_transfer_project_mapping_required"
        );
        if let Some(project) = &value.project {
            project.verify(value.binding.profile())?;
        }
        AssetBundleBinding::from_received(value)
    }
}
impl ReceivedAssetBinding {
    pub(crate) fn uploaded_source(
        &self,
    ) -> Result<Option<kcoder_types::migration_source_upload::SourceUploadProvenance>> {
        self.binding.validate()?;
        Ok(self.binding.entry().content.uploaded_source().cloned())
    }
    pub(crate) fn metadata(
        &self,
    ) -> Result<(
        MigrationSourceKind,
        MigrationCategory,
        ImportedContextScope,
        String,
    )> {
        let TransferContent::WorkAsset {
            source,
            category,
            scope,
            asset,
            ..
        } = &self.binding.entry().content
        else {
            anyhow::bail!("source_transfer_not_work_asset")
        };
        let scope = match (scope, &self.project) {
            (ImportedContextScope::Global, None) => ImportedContextScope::Global,
            (ImportedContextScope::Project { .. }, Some(project)) => {
                ImportedContextScope::Project {
                    root: project.root().into(),
                }
            }
            _ => anyhow::bail!("source_transfer_project_mapping_required"),
        };
        Ok((*source, *category, scope, asset.clone()))
    }
    pub(crate) fn memory_provenance(
        &self,
    ) -> Result<Option<kcoder_types::imported_memory::ImportedMemoryProvenance>> {
        self.binding.validate()?;
        match &self.binding.entry().content {
            TransferContent::WorkAsset {
                memory_provenance, ..
            } => Ok(memory_provenance.as_deref().cloned()),
            _ => anyhow::bail!("source_transfer_not_work_asset"),
        }
    }
    pub(crate) fn profile(&self) -> &Path {
        self.binding.profile()
    }
    pub(crate) fn allows_reuse(&self) -> bool {
        matches!(
            &self.binding.entry().content,
            TransferContent::WorkAsset {
                source_identity: Some(_),
                ..
            }
        )
    }
    pub(crate) fn logical_identity(&self) -> Result<String> {
        let TransferContent::WorkAsset {
            source,
            source_identity,
            scope,
            category,
            asset,
            ..
        } = &self.binding.entry().content
        else {
            anyhow::bail!("source_transfer_not_work_asset")
        };
        if let Some(identity) = source_identity {
            digest(&(
                "received-work-asset-origin/1",
                self.binding.source(),
                source,
                identity,
                scope,
                category,
                asset,
                self.project.as_ref().map(ReceivedProjectTarget::identity),
            ))
        } else {
            // This is only an artifact binding key, never a reconstructed origin.
            // Legacy bindings are excluded from cross-receipt reuse altogether.
            digest(&("received-work-asset-unidentified-artifact/1", &self.binding))
        }
    }
    pub(crate) fn executable_flags_cleared(&self) -> Result<bool> {
        let receiver = self.binding.validate()?;
        let receipt = self.binding.receipt();
        let (_, manifest) = receiver.ready(&receipt.request_id, self.binding.source(), receipt)?;
        let group = &self.binding.entry().id[..6];
        Ok(manifest.entries.iter().any(|entry| {
            entry.id.starts_with(group)
                && matches!(
                    &entry.content,
                    TransferContent::WorkAsset {
                        source_executable: true,
                        ..
                    }
                )
        }))
    }
    pub(crate) fn read(&self, key: &str, check: impl FnMut(u64) -> bool) -> Result<SourceAsset> {
        let (_, _, _, expected) = self.metadata()?;
        ensure!(key == expected, "migration_unknown_item");
        if let Some(project) = &self.project {
            project.verify(self.binding.profile())?;
        }
        let receiver = self.binding.validate()?;
        let receipt = self.binding.receipt();
        Ok(receiver
            .work_asset_checked(
                &receipt.request_id,
                self.binding.source(),
                &self.binding.entry().id,
                receipt,
                check,
            )?
            .asset)
    }
    pub(crate) fn verify_batch_parent(&self, parent: &PrivateDirectory) -> Result<()> {
        self.binding.verify_batch_parent(parent)
    }
}
