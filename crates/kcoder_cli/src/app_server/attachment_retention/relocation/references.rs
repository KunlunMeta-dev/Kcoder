//! Only existing typed retention facts can add an intermediate identity.
use super::*;

pub(super) fn referenced_identities(
    service: &RetentionService,
    snapshot: &RetentionRelocationSnapshot,
) -> Result<BTreeSet<String>> {
    let current = std::iter::once(&snapshot.tree)
        .chain(snapshot.artifacts.values())
        .flat_map(|tree| {
            tree.directories
                .values()
                .chain(tree.files.values().map(|file| &file.identity))
        })
        .map(identity_key)
        .collect::<BTreeSet<_>>();
    let header = &service.store.header;
    let mut identities = [&header.identity, &header.lock_identity]
        .into_iter()
        .chain(header.areas.values())
        .map(identity_key)
        .collect::<BTreeSet<_>>();
    let mut count = 0;
    for area in [Area::Owners, Area::Entries, Area::Receipts] {
        let directory = service
            .store
            .relocation_root()
            .open_child(OsStr::new(area.name()), false)?;
        directory.visit_regular_files(
            |_| true,
            |_, file| {
                count += 1;
                ensure!(count <= MAX_ENTRIES, "retention reference record bound");
                ensure!(
                    file.metadata()?.len() <= RECORD_BYTES,
                    "retention reference record exceeds bound"
                );
                let mut bytes = Vec::new();
                file.take(RECORD_BYTES + 1).read_to_end(&mut bytes)?;
                ensure!(
                    bytes.len() as u64 <= RECORD_BYTES,
                    "retention reference record exceeds bound"
                );
                match area {
                    Area::Owners => {
                        let owner: Owner = serde_json::from_slice(&bytes)?;
                        identities.extend(
                            [
                                owner.data_identity.as_ref(),
                                owner.marker_identity.as_ref(),
                                owner.lease_directory_identity.as_ref(),
                                owner.lease_identity.as_ref(),
                            ]
                            .into_iter()
                            .flatten()
                            .map(identity_key),
                        );
                        if let Some(manifest) = owner.manifest {
                            identities.insert(identity_key(&manifest.payload.lease_parent));
                            identities.insert(identity_key(&manifest.payload.inode));
                        }
                    }
                    Area::Entries => {
                        let entry: Entry = serde_json::from_slice(&bytes)?;
                        identities.extend(
                            [
                                entry.directory_identity.as_ref(),
                                entry.payload_identity.as_ref(),
                            ]
                            .into_iter()
                            .flatten()
                            .map(identity_key),
                        );
                        if let Some(transfer) = entry.transfer {
                            identities.insert(identity_key(&transfer.artifact_identity));
                        }
                    }
                    Area::Receipts => {
                        let receipt: Receipt = serde_json::from_slice(&bytes)?;
                        if let Some(intent) = receipt.transfer_intent {
                            identities.insert(identity_key(&intent.artifact_parent));
                            for artifact in intent.artifacts {
                                identities.extend(
                                    [
                                        Some(&artifact.source_parent),
                                        Some(&artifact.source_identity),
                                        artifact.identity.as_ref(),
                                    ]
                                    .into_iter()
                                    .flatten()
                                    .map(identity_key),
                                );
                            }
                        }
                        if let Some(intent) = receipt.cleanup_intent {
                            identities.extend(intent.query.storage_identities().map(identity_key));
                        }
                    }
                    _ => unreachable!("only typed owner, entry and receipt records are selected"),
                }
                // Historical references to already-gone objects need no new
                // placement. Bound memory by this operation's actual inventory.
                identities.retain(|identity| current.contains(identity));
                Ok(())
            },
        )?;
    }
    Ok(identities)
}
