//! An accepted project projection is metadata, not permission to open its foreign roots.
use super::binding::ReceivedBinding;
use super::*;
use crate::project_migration::{
    ProjectBatchSource, ProjectReadCancellation, ProjectRecord,
    transfer::{PROJECT_TRANSFER_FORMAT, PROJECT_TRANSFER_MAX_BYTES, ProjectTransferSnapshot},
};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReceivedProjectInventoryBinding {
    original: ReceivedBinding,
    source: MigrationSourceKind,
    format_revision: String,
    logical_identity: String,
}
fn read_snapshot(
    binding: &ReceivedBinding,
    cancel: &ProjectReadCancellation,
) -> Result<ProjectTransferSnapshot> {
    ensure!(!cancel.is_cancelled(), "migration_project_source_cancelled");
    let receiver = binding.validate()?;
    let (directory, _) = receiver.ready(
        &binding.receipt().request_id,
        binding.source(),
        binding.receipt(),
    )?;
    let entry = binding.entry();
    ensure!(
        entry.bytes > 0 && entry.bytes <= PROJECT_TRANSFER_MAX_BYTES,
        "source_transfer_project_budget_exceeded"
    );
    let bytes = directory.read_source_document_snapshot(
        OsStr::new(&payload_name(entry)),
        PROJECT_TRANSFER_MAX_BYTES,
        || !cancel.is_cancelled(),
    )?;
    ensure!(
        bytes.bytes().len() as u64 == entry.bytes && bytes.sha256 == entry.sha256,
        "source_transfer_payload_changed"
    );
    let snapshot: ProjectTransferSnapshot = serde_json::from_slice(bytes.bytes())
        .map_err(|_| anyhow::anyhow!("source_transfer_project_snapshot_unsupported"))?;
    snapshot.validate()?;
    let TransferContent::ProjectInventory {
        source,
        format,
        source_identity,
        metadata,
        ..
    } = &entry.content
    else {
        anyhow::bail!("source_transfer_not_project_inventory")
    };
    ensure!(
        *source == snapshot.source
            && format == PROJECT_TRANSFER_FORMAT
            && source_identity == &snapshot.logical_origin
            && metadata == &snapshot.metadata(),
        "source_transfer_project_snapshot_changed"
    );
    ensure!(!cancel.is_cancelled(), "migration_project_source_cancelled");
    Ok(snapshot)
}
impl IncomingTransfers {
    pub fn received_project_source(
        &self,
        request: &str,
        manifest: &str,
        entry: &str,
    ) -> Result<ProjectBatchSource> {
        let original = self.received_binding(request, manifest, entry)?;
        let snapshot = read_snapshot(&original, &Default::default())?;
        let logical_identity = digest(&(
            "transferred-project/1",
            original.source(),
            snapshot.source,
            &snapshot.logical_origin,
        ))?;
        let binding = ReceivedProjectInventoryBinding {
            original,
            source: snapshot.source,
            format_revision: snapshot.format_revision,
            logical_identity,
        };
        ProjectBatchSource::received(binding, snapshot.record)
    }
}
impl ReceivedProjectInventoryBinding {
    pub(crate) fn source(&self) -> MigrationSourceKind {
        self.source
    }
    pub(crate) fn format_revision(&self) -> &str {
        &self.format_revision
    }
    pub(crate) fn logical_identity(&self) -> String {
        self.logical_identity.clone()
    }
    pub(crate) fn verify_profile(&self, profile: &Path) -> Result<()> {
        let actual = PrivateDirectory::open_existing(profile)?
            .open_child(OsStr::new("migrations"), false)?;
        self.original.verify_batch_parent(&actual)
    }
    pub(crate) fn validate(
        &self,
        record: &ProjectRecord,
        cancel: &ProjectReadCancellation,
    ) -> Result<()> {
        let snapshot = read_snapshot(&self.original, cancel)?;
        ensure!(
            snapshot.source == self.source
                && snapshot.format_revision == self.format_revision
                && snapshot.record == *record
                && self.logical_identity
                    == digest(&(
                        "transferred-project/1",
                        self.original.source(),
                        snapshot.source,
                        &snapshot.logical_origin
                    ))?,
            "source_transfer_project_snapshot_changed"
        );
        Ok(())
    }
}
