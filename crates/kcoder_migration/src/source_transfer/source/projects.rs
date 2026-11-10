//! Bounded project metadata uses the existing owned capture/checkpoint publisher.
use super::*;
use crate::project_migration::{
    ProjectBatchSource, ProjectReadCancellation,
    transfer::{PROJECT_TRANSFER_FORMAT, PROJECT_TRANSFER_MAX_BYTES, ProjectTransferSnapshot},
};

pub(super) fn capture(
    directory: &PrivateDirectory,
    index: usize,
    source: &ProjectBatchSource,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<TransferEntry> {
    active(directory)?;
    ensure!(check(0), "source_transfer_cancelled");
    let original_control = directory.duplicate_handle()?;
    let cancel = ProjectReadCancellation::with_probe(move || active(&original_control).is_err());
    let projection = ProjectTransferSnapshot::capture(source, &cancel).map_err(|error| {
        if cancel.is_cancelled() {
            anyhow::anyhow!("source_transfer_cancelled")
        } else {
            error
        }
    })?;
    let bytes = projection.bytes()?;
    ensure!(
        bytes.len() as u64 <= PROJECT_TRANSFER_MAX_BYTES,
        "source_transfer_project_budget_exceeded"
    );
    let content = TransferContent::ProjectInventory {
        source: projection.source,
        format: PROJECT_TRANSFER_FORMAT.into(),
        source_identity: projection.logical_origin.clone(),
        source_revision: source.identity().to_owned(),
        metadata: projection.metadata(),
    };
    let entry = entry(index, 0, content, &bytes);
    snapshot(directory, &entry, &mut Cursor::new(&bytes), check)?;
    Ok(entry)
}
