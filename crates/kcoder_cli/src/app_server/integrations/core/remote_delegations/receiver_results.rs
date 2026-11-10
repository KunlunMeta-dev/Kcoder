//! Read actual artifacts from the original completed Native receiver, never model-authored references.
use super::*;
use kcoder_state::integrations::office::OfficeStore;
use kcoder_types::{TurnAttemptStatus, integrations::office::*};
use sha2::{Digest, Sha256};

pub struct OriginalReceiverOfficeResult {
    pub manifest: OfficeArtifactManifest,
    pub bytes: Vec<u8>,
}
pub fn capture(
    authority: &super::authority::AcceptedRemoteAuthority,
    journal: &NativeRemoteJournal,
) -> Result<Option<OriginalReceiverOfficeResult>> {
    let Some(receiver) = authority.original_office_receiver()? else {
        return Ok(None);
    };
    journal.check_current()?;
    let task = super::receiver_history::read_original_receiver(
        journal.context(),
        journal.store(),
        journal.operation_id(),
    )?
    .context("REMOTE_RECEIVER_ORIGINAL_TERMINAL_REQUIRED")?;
    ensure!(
        task.status == TurnAttemptStatus::Completed,
        "REMOTE_RECEIVER_ORIGINAL_COMPLETION_REQUIRED"
    );
    let guard =
        NativeDomainGuard::observe(receiver.profile()?, receiver.scope(), NativeDomain::Office)?
            .context("REMOTE_RECEIVER_OFFICE_STORE_REQUIRED")?;
    let store = OfficeStore::open_in(
        &guard.directory(receiver.profile()?)?,
        OsStr::new("data"),
        kcoder_types::integrations::core::IntegrationOwner::from(receiver.scope()),
    )?
    .context("REMOTE_RECEIVER_OFFICE_STORE_REQUIRED")?;
    let mut manifests = store
        .list_artifacts(&task.identity.thread_id)?
        .into_iter()
        .filter(|manifest| {
            manifest.task.turn_id == task.identity.turn_id
                && manifest.task.run_id.is_none()
                && authority.receiver_formats().contains(&manifest.format)
        })
        .collect::<Vec<_>>();
    // Ambiguity cannot become a first-row choice. The original journal remains
    // available for explicit reconciliation; no generation or prompt is replayed.
    ensure!(
        !manifests.is_empty(),
        "REMOTE_RECEIVER_OFFICE_RESULT_REQUIRED"
    );
    ensure!(
        manifests.len() == 1,
        "REMOTE_RECEIVER_OFFICE_RESULT_AMBIGUOUS"
    );
    let manifest = manifests
        .pop()
        .context("REMOTE_RECEIVER_OFFICE_RESULT_REQUIRED")?;
    manifest.validate()?;
    ensure!(
        manifest.owner
            == kcoder_types::integrations::core::IntegrationOwner::from(receiver.scope())
            && manifest.bytes <= OFFICE_MAX_ARTIFACT_BYTES,
        "REMOTE_RECEIVER_OFFICE_RESULT_CHANGED"
    );
    let reference = OfficeArtifactRef {
        id: manifest.id.clone(),
        revision: manifest.revision,
    };
    let mut bytes = Vec::new();
    while (bytes.len() as u64) < manifest.bytes {
        journal.check_current()?;
        let (page, total) =
            store.read_artifact_chunk(&reference, bytes.len() as u64, 192 * 1024)?;
        ensure!(
            total == manifest.bytes
                && !page.is_empty()
                && page.len() as u64 <= total - bytes.len() as u64,
            "REMOTE_RECEIVER_OFFICE_RESULT_CHANGED"
        );
        bytes.extend_from_slice(&page);
    }
    ensure!(
        bytes.len() as u64 == manifest.bytes
            && format!("{:x}", Sha256::digest(&bytes)) == manifest.sha256
            && store.read_artifact(&reference)?.as_ref() == Some(&manifest),
        "REMOTE_RECEIVER_OFFICE_RESULT_CHANGED"
    );
    journal.check_current()?;
    Ok(Some(OriginalReceiverOfficeResult { manifest, bytes }))
}
